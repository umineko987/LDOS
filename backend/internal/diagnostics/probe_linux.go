package diagnostics

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/config"
)

const sscdFile = "sscd_disc_mixup.torchscript.pt"
const dinoCheckpoint = "torch/hub/checkpoints/dinov2_vits14_pretrain.pth"
const dinoRepository = "torch/hub/facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"

// Only the inference interpreter can truthfully report its Torch/GPU and wheel
// runtime. Filesystem, configuration, readiness policy, caching and HTTP remain Go.
const torchProbe = `import importlib.metadata as metadata
import json, sys
result = {}
try:
    import torch, torchvision
    requested = sys.argv[1]
    cuda = bool(torch.cuda.is_available())
    actual = ("cuda" if cuda else "cpu") if requested == "auto" else requested
    names = sorted({d.metadata["Name"].lower() for d in metadata.distributions() if d.metadata.get("Name")})
    forbidden = [n for n in names if n.startswith("nvidia-") or n in {"cuda-bindings", "cuda-pathfinder", "cuda-toolkit", "pytorch-triton", "triton"}]
    opencv = [n for n in names if n in {"opencv-python", "opencv-contrib-python", "opencv-contrib-python-headless", "opencv-python-headless"}]
    result.update(torch_version=str(torch.__version__), torchvision_version=str(torchvision.__version__), actual_device=actual, cuda_available=cuda, forbidden_cpu_package_count=len(forbidden), opencv_variants=opencv)
    if requested == "cuda" and not cuda:
        result["error"] = "cuda_unavailable"
    elif requested == "cpu" and (not str(torch.__version__).endswith("+cpu") or forbidden or cuda or opencv != ["opencv-python-headless"]):
        result["error"] = "cpu_environment_mismatch"
except Exception:
    result["error"] = "torch_unavailable"
print(json.dumps(result, separators=(",", ":")))
`
const galleryProbe = `import importlib.util, json
print(json.dumps({"ready": all(importlib.util.find_spec(n) is not None for n in ("requests", "yaml"))}))
`

type boundedOutput struct{ data []byte }

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if space := 65536 - len(b.data); space > 0 {
		b.data = append(b.data, p[:min(space, n)]...)
	}
	return n, nil
}
func executable(path string) bool {
	_, err := exec.LookPath(path)
	return err == nil
}
func runProbe(ctx context.Context, python, script string, args ...string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args = append([]string{"-c", script}, args...)
	cmd := exec.CommandContext(ctx, python, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	var stdout, stderr boundedOutput
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(stdout.data)), "\n")
	var data map[string]any
	err := json.Unmarshal([]byte(lines[len(lines)-1]), &data)
	return data, err
}
func probeModels(ctx context.Context, settings config.Settings) Snapshot {
	d := settings.Dedup
	pythonOK := executable(d.PythonExecutable)
	result := Snapshot{"dedup_python": check(pythonOK, "去重 Python 可执行"), "torch": component("error", "Torch 推理环境不可用", true)}
	sscd := nonempty(filepath.Join(d.ModelDir, sscdFile))
	dino := nonempty(filepath.Join(d.ModelDir, dinoCheckpoint)) && present(filepath.Join(d.ModelDir, dinoRepository, "hubconf.py"))
	result["sscd_model"], result["dino_model"] = check(sscd, "SSCD 模型缓存"), check(dino, "DINOv2 权重和固定 revision 源码缓存")
	if d.NoSSCD {
		result["sscd_model"] = component("disabled", "SSCD 已由配置禁用", false)
	}
	if d.NoDINO {
		result["dino_model"] = component("disabled", "DINOv2 已由配置禁用", false)
	}
	scriptsOK := present(d.WorkerScript) && present(d.CoreScript)
	if pythonOK && scriptsOK {
		probe, err := runProbe(ctx, d.PythonExecutable, torchProbe, d.Device)
		if err == nil && probe["error"] == nil {
			torch := component("ok", "Torch 可用", true)
			for _, name := range []string{"torchvision_version", "actual_device", "cuda_available", "forbidden_cpu_package_count", "opencv_variants"} {
				torch[name] = probe[name]
			}
			torch["version"], torch["configured_device"] = probe["torch_version"], d.Device
			result["torch"] = torch
		} else if probe["error"] == "cuda_unavailable" {
			result["torch"]["summary"] = "配置要求 CUDA，但 PyTorch 未检测到可用 GPU"
		} else if probe["error"] == "cpu_environment_mismatch" {
			result["torch"]["summary"] = "CPU 配置不是纯 CPU PyTorch/headless OpenCV 环境"
		}
	}
	result["dedup"] = check(scriptsOK && ready(result), "去重环境与模型")
	result["dedup"]["configured_device"] = d.Device
	result["dedup"]["configured_resources"] = map[string]any{"workers": d.Workers, "torch_threads": d.TorchThreads, "torch_interop_threads": d.TorchInteropThreads, "deep_batch_size": d.DeepBatchSize, "neighbor_block_size": d.NeighborBlockSize}
	return result
}

func privateDirectory(path, label string) Component {
	st, err := os.Lstat(path)
	if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return component("error", label+"不存在或不是安全目录", true)
	}
	if unix.Access(path, unix.R_OK|unix.W_OK|unix.X_OK) != nil {
		return component("error", label+"不可读写", true)
	}
	if st.Mode().Perm()&0077 != 0 {
		return component("error", label+"权限过宽，需要 0700", true)
	}
	return component("ok", label+"可读写且权限受限", true)
}
func privateFiles(label string, paths ...string) Component {
	existing := 0
	for _, path := range paths {
		st, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !st.Mode().IsRegular() || unix.Access(path, unix.R_OK|unix.W_OK) != nil {
			return component("error", label+"包含不可读写文件或符号链接", true)
		}
		existing++
		if st.Mode().Perm()&0077 != 0 {
			return component("error", label+"文件权限过宽，需要 0600", true)
		}
	}
	result := component("ok", label+"权限受限", true)
	result["existing_file_count"] = existing
	return result
}
func chrome(settings config.Settings) Component {
	if executable(settings.Auth.ChromeExecutable) {
		return component("ok", "检测到 Chrome/Chromium；桌面授权仍需要图形会话", false)
	}
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"} {
		if path, err := exec.LookPath(name); err == nil && executable(path) {
			return component("ok", "检测到 Chrome/Chromium；桌面授权仍需要图形会话", false)
		}
	}
	return component("optional_missing", "未检测到 Chrome/Chromium；仅影响桌面授权", false)
}
