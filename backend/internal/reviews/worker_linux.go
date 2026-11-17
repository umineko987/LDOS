package reviews

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 1024*1024 - b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}

// command owns a whole process group, including descendants after leader exit.
// The lifecycle mutex makes launch mutually exclusive with Stop and Finish.
func (s *Service) command(ctx context.Context, program string, args []string, cwd string, stdout, stderr io.Writer) error {
	if program == "" {
		return fmt.Errorf("审核执行器未配置")
	}
	cmd := exec.Command(program, args...)
	cmd.Dir = cwd
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = append(os.Environ(), "PYTHONUTF8=1", "PYTHONUNBUFFERED=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	cmd.WaitDelay = s.deps.Dedup.ShutdownGrace
	s.mu.Lock()
	if s.stopped || s.ctx.Err() != nil || ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	err := cmd.Start()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	select {
	case e := <-done:
		return e
	case <-ctx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		timer := time.NewTimer(s.deps.Dedup.ShutdownGrace)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
		}
		return ctx.Err()
	}
}
func (s *Service) runWorker(ctx context.Context, input WorkerInput) (Manifest, string, error) {
	var manifest Manifest
	i := input.identity()
	if !validID(i.id) || strings.ContainsAny(i.id, "/\\") || i.id == "." || i.id == ".." {
		return manifest, "", fmt.Errorf("invalid review artifact identity")
	}
	cfg := s.deps.Dedup
	python, e := filepath.Abs(s.pythonExecutable())
	if e != nil {
		return manifest, "", e
	}
	worker, e := filepath.Abs(cfg.WorkerScript)
	if e != nil {
		return manifest, "", e
	}
	core, e := filepath.Abs(cfg.CoreScript)
	if e != nil {
		return manifest, "", e
	}
	for _, path := range []string{python, worker, core} {
		st, e := os.Stat(path)
		if e != nil {
			return manifest, "", e
		}
		if !st.Mode().IsRegular() {
			return manifest, "", fmt.Errorf("审核执行器不是文件")
		}
	}
	if e = ctx.Err(); e != nil {
		return manifest, "", e
	}
	if e = privateDirectory(s.runtime); e != nil {
		return manifest, "", e
	}
	manifestPath := filepath.Join(s.runtime, i.id+".json")
	logPath := filepath.Join(s.runtime, i.id+".log")
	if e = checkPath(s.runtime, i.id+".json"); e != nil {
		return manifest, "", e
	}
	if e = os.Remove(manifestPath); e != nil && !errors.Is(e, os.ErrNotExist) {
		return manifest, "", e
	}
	args := []string{worker}
	if !i.gallery {
		args = append(args, input.OutputDir)
	}
	args = append(args, "--output", manifestPath, "--core-script", core, "--model-dir", cfg.ModelDir, "--device", cfg.Device, "--workers", strconv.Itoa(cfg.Workers), "--torch-threads", strconv.Itoa(cfg.TorchThreads), "--torch-interop-threads", strconv.Itoa(cfg.TorchInteropThreads), "--deep-batch-size", strconv.Itoa(cfg.DeepBatchSize), "--neighbor-block-size", strconv.Itoa(cfg.NeighborBlockSize))
	if i.gallery {
		inputPath := filepath.Join(s.runtime, i.id+".input.json")
		f, e := privateFile(inputPath)
		if e != nil {
			return manifest, "", e
		}
		e = json.NewEncoder(f).Encode(input)
		closeErr := f.Close()
		if e != nil {
			return manifest, "", e
		}
		if closeErr != nil {
			return manifest, "", closeErr
		}
		args = append(args, "--input", inputPath)
	}
	if cfg.NoSSCD {
		args = append(args, "--no-sscd")
	}
	if cfg.NoDINO {
		args = append(args, "--no-dino")
	}
	logFile, e := privateFile(logPath)
	if e != nil {
		return manifest, "", e
	}
	e = s.command(ctx, python, args, filepath.Dir(worker), logFile, logFile)
	closeErr := logFile.Close()
	if ctx.Err() != nil {
		return manifest, logPath, ctx.Err()
	}
	if e != nil {
		return manifest, logPath, fmt.Errorf("去重分析进程失败: %w: %s", e, logTail(logPath, 4000))
	}
	if closeErr != nil {
		return manifest, logPath, closeErr
	}
	root, e := openRoot(s.runtime)
	if e != nil {
		return manifest, logPath, e
	}
	defer root.close()
	f, e := root.open(i.id + ".json")
	if e != nil {
		return manifest, logPath, fmt.Errorf("去重分析进程未生成审核清单: %w", e)
	}
	defer f.Close()
	if e = f.Chmod(0600); e != nil {
		return manifest, logPath, e
	}
	st, e := f.Stat()
	if e != nil {
		return manifest, logPath, e
	}
	if st.Size() > 256*1024*1024 {
		return manifest, logPath, fmt.Errorf("审核清单超过 256 MiB 上限")
	}
	decoder := json.NewDecoder(f)
	decoder.UseNumber()
	if e = decoder.Decode(&manifest); e != nil {
		return manifest, logPath, fmt.Errorf("读取去重审核清单失败: %w", e)
	}
	var extra any
	if e = decoder.Decode(&extra); e != io.EOF {
		return manifest, logPath, fmt.Errorf("审核清单含多余 JSON 内容")
	}
	return manifest, logPath, nil
}
func logTail(path string, limit int64) string {
	f, e := os.Open(path)
	if e != nil {
		return ""
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return ""
	}
	start := st.Size() - limit
	if start < 0 {
		start = 0
	}
	if _, e = f.Seek(start, io.SeekStart); e != nil {
		return ""
	}
	data, _ := io.ReadAll(io.LimitReader(f, limit))
	return safeText(strings.TrimSpace(string(bytes.ToValidUTF8(data, []byte("�")))))
}
