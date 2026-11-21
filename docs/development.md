# Linux 开发指南

[English](development.en.md)

## 快速开始

当前支持 Linux x86_64。宿主提供 GTK 3 / WebKitGTK 4.1；源码构建使用 Go 1.27.3 和 Node.js 26.3.1（自带 npm 11.16.0）。准备系统 `python3`（3.11.4 或更新）用于引导安装，无需预装推理用的 Python 或 Torch。

Debian/Ubuntu 安装桌面依赖：

```sh
sudo apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev
```

获取源码并准备 Go 后端、Python 执行器和 CPU 模型环境：

```sh
git clone --recurse-submodules https://github.com/KKKneko/LDOS.git
cd LDOS
./scripts/setup-linux.sh --device cpu
```

安装器复用[发行锁](../desktop/release/runtime-lock.json)，下载并校验 CPython 3.13.15 到 `.local/runtimes/`，分别为采集和模型创建隔离 venv。默认安装 CPU 锁；`--device cuda` 选择 CUDA 12.8 锁（需兼容的 NVIDIA 驱动），`--tagger-torch` 可选装 CPU 版 Canary/PixAI 依赖。模型权重按需安装，`--with-models` 可预取 SSCD/DINOv2。高级用户可用 `--python PATH` 指定 3.11–3.14。

Linux x86_64 的 Mihomo 版本也取自发行锁。

在 `desktop/` 安装前端依赖并启动开发窗口：

```sh
cd desktop
npm ci
npm run generate
npm run dev
```

`dev` 会构建 Go 后端、生成 mygo 绑定并启动 Vite 与桌面窗口。结束开发时退出窗口并停止终端中的开发进程。需要单独运行无窗口后端时，在仓库根目录执行 `./scripts/run.sh`；`./scripts/doctor.sh --json` 可检查运行环境。

## 构建与运行

在 `desktop/` 执行：

```sh
npm run build
npm run desktop:start
```

构建输出为 `backend/build/ldos-backend` 和 `desktop/build/linux-amd64/ldos`。源码运行模式仍需要源码目录、gallery-dl 子模块、Python 执行器环境和配置；仅移动桌面二进制不会携带这些资源。

独立发行归档使用 `python3 scripts/desktop_release.py build` 从干净工作区组装。mygo 独立发行包和 AppImage 尚未完成发布验收。CI、桌面构建和发行目标仅维护 Linux x86_64。

## 测试

在仓库根目录运行：

```sh
(cd backend && go test -race -timeout 5m ./... && go vet ./...)
(cd desktop && npm test && npm run check)
.venv/bin/python -m unittest discover -s tests -v
PYTHONPATH=backend/executors gallery-dl-backend/.venv/bin/python -m unittest discover -s backend/executors/tests -v
python3 scripts/export_openapi.py --check
```

Python 测试另需向两个 venv 安装 `gallery-dl-backend/requirements-test.txt`。回归覆盖代理启动与回退、搜索超时及取消、队列状态刷新、去重后的图片和 caption 读取；真实 gallery 认证测试使用子模块与执行器 venv。GUI、实际站点权限及真实模型效果需单独验收。

后端模块与运行边界见 [Go 后端 README](../backend/README.md)，桌面浏览器测试入口见 [E2E README](../desktop/e2e/README.md)。
