package main

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Each backend owns a new process group. Keep the parent's write end separate
// from exec.Cmd: EOF is the existing Python supervisor's graceful-exit signal.
type processTree struct {
	cmd        *exec.Cmd
	parentPipe *os.File
	done       chan struct{}
	once       sync.Once
	waitErr    error // published by closing done
}

func spawnProcess(cmd *exec.Cmd) (*processTree, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdin = reader
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	reader.Close()
	p := &processTree{cmd: cmd, parentPipe: writer, done: make(chan struct{})}
	go func() { p.waitErr = cmd.Wait(); close(p.done) }()
	return p, nil
}

func (p *processTree) exited() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (p *processTree) signalGroup(signal syscall.Signal) error {
	err := syscall.Kill(-p.cmd.Process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func (p *processTree) groupExists() bool {
	err := syscall.Kill(-p.cmd.Process.Pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func waitDone(done <-chan struct{}, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

func (p *processTree) shutdown(grace, termGrace time.Duration) {
	p.once.Do(func() {
		p.parentPipe.Close()
		waitDone(p.done, grace)
		// A successfully reaped Python parent can leave workers alive. Never
		// return just because Wait completed: terminate its remaining group too.
		if p.groupExists() {
			_ = p.signalGroup(syscall.SIGTERM)
			deadline := time.Now().Add(termGrace)
			for p.groupExists() && time.Now().Before(deadline) {
				time.Sleep(25 * time.Millisecond)
			}
			if p.groupExists() {
				_ = p.signalGroup(syscall.SIGKILL)
			}
		}
		<-p.done
	})
}
