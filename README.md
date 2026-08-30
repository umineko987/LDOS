# LDOS

**LoRA Dataset Operating System**

*The operating workspace for LoRA datasets.*

面向 LoRA 数据集采集、整理与去重审核的一站式桌面工作流。

## 1. 获取源码

需要完整检出 `gallery-dl-codeberg` 子模块：

```bash
git clone --recurse-submodules https://github.com/KKKneko/LDOS.git
cd LDOS
```

已有源码但子模块不完整时，在仓库根目录执行：

```bash
git submodule update --init --recursive
```

## 2. Linux 部署

### 2.1 系统要求

Linux 安装脚本当前只接受 `x86_64` / `amd64`。系统需要提供：

- Python `3.11`–`3.14`，并包含 `venv` 模块；
- Git；
- `curl` 或 `wget`；
- `gzip`；
- `sha256sum` 或 `shasum`；
- `coreutils`。

Debian / Ubuntu：

```bash
sudo apt update
sudo apt install -y python3 python3-venv git curl ca-certificates gzip coreutils
```

Arch Linux：

```bash
sudo pacman -S python git curl ca-certificates gzip coreutils
```

安装器不会自动运行 `sudo`。

### 2.2 安装 CPU 环境

在仓库根目录执行：

```bash
./scripts/setup-linux.sh --device cpu
```

### 2.3 安装 CUDA 12.8 环境

确认主机已有兼容的 NVIDIA 驱动和 GPU，然后执行：

```bash
./scripts/setup-linux.sh --device cuda
```

### 2.4 安装过程使用代理

安装代理只影响本次 Git、Python 依赖、Mihomo 和模型下载，不会自动写入运行时抓取代理池：

```bash
./scripts/setup-linux.sh --device cpu --proxy http://127.0.0.1:7890
```

明确关闭安装阶段的代理：

```bash
./scripts/setup-linux.sh --device cpu --no-proxy
```

常用可选项：

```bash
./scripts/setup-linux.sh --help
```

- `--skip-models`：跳过模型下载；之后启用去重前需要重新运行一次不带该参数的安装命令；
- `--skip-mihomo`：跳过 Mihomo 安装；
- `--skip-submodule`：跳过子模块初始化；仅适用于子模块已经准备好的情况；
- `--python PATH`：指定创建虚拟环境所使用的 Python。

安装脚本会创建或复用以下目录：

- `gallery-dl-backend/.venv`：后端环境；
- `.venv`：去重环境；
- `.models`：去重模型缓存；
- `gallery-dl-backend/runtime`：运行时数据；
- `gallery-dl-backend/credentials`：授权材料。

### 2.5 Linux 启动

先运行部署诊断：

```bash
./scripts/doctor.sh
```

诊断通过后启动后端：

```bash
./scripts/run.sh
```

`run.sh` 会再次执行诊断，然后启动 `gallery-dl-backend`。停止服务时按 `Ctrl+C`。

## 3. Windows 部署

以下命令在仓库根目录的 PowerShell 中执行。需要 Python `3.11`–`3.14`、Git 和可用的网络连接。

如果 PowerShell 阻止执行本地脚本，只为当前进程放行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### 3.1 准备子模块和后端环境

```powershell
git submodule update --init --recursive
python -m venv .\gallery-dl-backend\.venv
& .\gallery-dl-backend\.venv\Scripts\python.exe -m pip install `
  --disable-pip-version-check --require-hashes --only-binary=:all: `
  -r .\gallery-dl-backend\requirements.txt
```

### 3.2 准备去重环境

纯 CPU：

```powershell
.\setup-dedup.ps1 -Device cpu
```

NVIDIA CUDA 12.8：

```powershell
.\setup-dedup.ps1 -Device cuda
```

安装阶段使用代理：

```powershell
.\setup-dedup.ps1 -Device cpu -ProxyUrl http://127.0.0.1:7890
```

明确关闭安装阶段代理：

```powershell
.\setup-dedup.ps1 -Device cpu -NoProxy
```

如果只想安装依赖、暂时跳过模型下载：

```powershell
.\setup-dedup.ps1 -Device cpu -SkipModels
```

之后启用去重前，需要重新运行不带 `-SkipModels` 的命令。

### 3.3 创建配置

首次部署时复制示例配置：

```powershell
if (-not (Test-Path .\gallery-dl-backend\config.json)) {
  Copy-Item .\gallery-dl-backend\config.example.json .\gallery-dl-backend\config.json
}
```

配置文件中的相对路径以 `gallery-dl-backend/config.json` 所在目录为基准。需要启用去重时，编辑配置中的：

```json
{
  "dedup": {
    "enabled": true,
    "device": "cpu"
  }
}
```

CUDA 部署将 `device` 改为 `"cuda"`。两个去重环境都使用根目录下的 `.venv`；后端使用 `gallery-dl-backend/.venv`。

### 3.4 可选安装 Mihomo

只有使用 VLESS、VMess、Trojan 等隧道节点时才需要安装 Mihomo：

```powershell
& .\gallery-dl-backend\scripts\install_mihomo.ps1
```

### 3.5 Windows 启动

```powershell
.\gallery-dl-backend\run_backend.ps1
```

停止服务时按 `Ctrl+C`。

## 4. 配置端口和路径

默认配置文件：

```text
gallery-dl-backend/config.json
```

默认服务地址：

```text
http://127.0.0.1:8787
```

Linux 使用其他配置文件或端口：

```bash
GDL_BACKEND_CONFIG=/path/to/config.json ./scripts/run.sh --port 8788
```

Windows 使用其他配置文件或端口：

```powershell
.\gallery-dl-backend\run_backend.ps1 `
  -Config C:\path\to\config.json `
  -PortOverride 8788
```

如果修改下载目录，必须同时更新 `default_output_root` 和 `allowed_output_roots`，例如：

```json
{
  "default_output_root": "/data/ldos",
  "allowed_output_roots": ["/data/ldos"]
}
```
