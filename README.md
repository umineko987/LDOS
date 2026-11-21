> **开发中**

# LDOS

**LoRA Dataset Operating System**

[English](README_EN.md)

LDOS 是围绕 [gallery-dl](https://codeberg.org/mikf/gallery-dl) 构建的本地 LoRA 数据集工作台。数据集负责采集 → 清洗 → 去重 → 打标 → 导出，成功导出的成品自动进入图库，供人工审查。

## 特性介绍

- **数据集流水线**：采集（从搜索或图库加入）、清洗（规则初筛和逐张审查）、去重（感知哈希、SSCD、DINO 与并排对比）、打标（本地 tagger 模型）、导出（将图片、caption 和触发词复制到目标目录）。
- **图库审查**：从图库来源或文件夹进入，逐张保留或移到回收区并继续，支持恢复。可按标签筛选、查看频率、编辑标注、预览批量改动和撤销写入。审查导出成品只修改这份副本。
- **数据集地图**：按图像嵌入把整个数据集画成散点图，显示聚簇和代表标签、标出离群图；用套索圈一片图片，打标签或移出数据集。
- **图库**：浏览、检索、重命名已下载的图片，编辑同名 TXT 标注，有回收区；可以把目录或选中的图片加入数据集。
- **任务中心**：采集、扫描、打标、导出等后台任务实时推送进度，完成或失败时提示。
- **代理、站点授权与模型**：管理代理来源、连接探测、站点授权和托管浏览器会话；下载和管理本地模型。
- **本地桌面工作区**：mygo + Svelte（当前仅支持 Linux）桌面界面连接本地 Go 服务；后端默认仅监听回环地址，任务与图库状态保存在本地 SQLite 和文件系统中。

## 快速开始

当前支持 Linux x86_64，需要 GTK 3 / WebKitGTK 4.1、Node.js 26、Go 1.27.3，以及带 venv/pip 的 Python 3.13 或 3.14。

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

安装会保留已有的 `gallery-dl-backend/config.json`。新配置允许手动启动代理池，默认不自动启动；添加订阅后，在设置的网络页面启动代理池。登录和模型下载共用设置中的代理选择，采集使用站点策略。

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

## 配置与数据

- 配置入口为 `gallery-dl-backend/config.json`，可用 `GDL_BACKEND_CONFIG` 指定其他配置；路径相对配置文件解析。
- `GDL_BACKEND_HOST` / `GDL_BACKEND_PORT` 可覆盖监听地址与端口，默认使用回环地址。
- 用户凭据、代理订阅、数据库、下载文件和本地模型保存在配置指定的本地目录中，不纳入版本控制。
- README 保留安装与开发入口；设计笔记、开发资料和本地编辑器/代理工具配置只保存在本机。源码、测试、CI、构建脚本和许可证仍随仓库维护。

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

后端模块与运行边界见 [Go 后端 README](backend/README.md)，桌面浏览器测试入口见 [E2E README](desktop/e2e/README.md)。
