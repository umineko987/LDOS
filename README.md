# ImageWeave

ImageWeave 是一个以 **Tauri 2 + Svelte 5** 为桌面入口、以 **Python + FastAPI** 为本地业务后端的图片采集与整理工作台。桌面壳层提供 Tasks、Crawl、Proxy、Vault、Policy、Diagnostics、Personalization、Review，以及 Gallery/Export 预览；API、SQLite、任务调度、代理、授权与审核语义仍由后端单独负责。

当前仓库没有发布下载地址。桌面发布流程产出未签名的 Linux（DEB、AppImage）和 Windows（NSIS）安装包，适合维护者从干净源码构建并静态验证。

## 当前架构

```text
Tauri 2 / Svelte 5 desktop
  ├─ one canonical frontend (desktop/dist)
  ├─ minimal Tauri capabilities and exact navigation policy
  └─ local HTTP API (loopback only)
       └─ FastAPI + SQLite
            ├─ gallery-dl worker: python -m gdl_backend.worker_entry
            └─ dedup worker: dedup_review_worker.py
```

生产安装包只包含一份前端和一份受控、可重定位的 Python runtime。FastAPI、gallery-dl worker 和 dedup worker 都使用该 runtime；Rust 不代理 HTTP、不访问 SQLite，也不复制 Python 业务 schema。开发模式继续使用仓库内 `gallery-dl-backend/.venv`，但不会形成第二套生产分发实现。

更完整的边界见 [架构文档](docs/ARCHITECTURE.md) 和 [后端文档](docs/gallery-dl-backend.md)。

## 从源码构建桌面安装包

### 前置条件

通用要求：

- 递归检出的 Git submodule（`gallery-dl-codeberg`）；
- Python 3.13，用于执行 release assembly；
- Node.js 24.13.0 与 npm（CI 锁定版本）；
- Rust 1.98.0，仓库根目录的 `rust-toolchain.toml` 会选择该 toolchain；
- 能访问 `desktop/release/runtime-lock.json` 中锁定的 Python runtime 和 Python 包来源。

Linux CI 使用 Ubuntu 24.04，并安装：

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
  libssl-dev libgtk-3-dev libfuse2 zstd
```

Windows 构建由 `.github/workflows/desktop-release.yml` 的 `windows-2025` job 执行，使用 MSVC Rust target 和该 runner 已提供的 Tauri/WebView2 构建环境。仓库不包含签名证书，产物是未签名安装包。

### Canonical release 命令

从仓库根目录、干净的 tracked checkout 执行：

```bash
python scripts/desktop_release.py build --cache-dir .release-cache
```

该命令失败即停，并依次执行：

1. `npm ci`、Svelte build 和 canonical frontend manifest/hash 校验；
2. 下载并校验锁定 runtime，安装锁定 Python 依赖，组装唯一后端树；
3. 验证 FastAPI、`gdl_backend.worker_entry`、dedup 子进程和 HTTP shutdown；
4. `cargo fmt --check`、Rust tests 和 Tauri bundle；
5. 静态解包每个安装包，校验 frontend bytes、runtime、worker、资源清单、路径可重定位性以及秘密/开发绝对路径扫描；
6. 再次确认 tracked checkout 未被构建污染。

默认产物：

- Linux：`desktop/src-tauri/target/release/bundle/deb/*.deb`、`desktop/src-tauri/target/release/bundle/appimage/*.AppImage`；
- Windows：`desktop/src-tauri/target/release/bundle/nsis/*.exe`；
- 后端清单：`desktop/src-tauri/release/backend/release-manifest.json` 和 `desktop/src-tauri/release/backend/release-files.sha256`。

组装、树校验、runtime 校验和单个安装包校验也可以独立执行：

```bash
npm --prefix desktop ci
python scripts/desktop_release.py assemble --target linux-x86_64 --cache-dir .release-cache
python scripts/desktop_release.py verify-tree
python scripts/desktop_release.py verify-runtime
python scripts/desktop_release.py verify-bundle --bundle desktop/src-tauri/target/release/bundle/deb/ImageWeave_0.1.0_amd64.deb
```

Windows 上把 target 改为 `windows-x86_64`；bundle 参数使用实际生成的 NSIS `.exe`。

## 桌面开发

开发模式使用显式仓库路径，不下载生产 runtime。先从仓库根目录准备后端虚拟环境和配置：

```bash
python -m venv gallery-dl-backend/.venv
./gallery-dl-backend/.venv/bin/python -m pip install -r gallery-dl-backend/requirements.txt
cp gallery-dl-backend/config.example.json gallery-dl-backend/config.json
```

Windows 激活或调用虚拟环境时使用 `gallery-dl-backend/.venv/Scripts/python.exe`。

然后安装前端依赖并启动 Tauri 开发入口：

```bash
cd desktop
npm ci
npm run tauri -- dev
```

Tauri debug host 会从 `gallery-dl-backend/config.json` 读取 loopback 地址，并启动 `gallery-dl-backend/.venv` 中的后端。可用 `PYTHON` 和 `GDL_BACKEND_CONFIG` 显式覆盖开发解释器或配置路径。该命令会创建 WebView；本次 P6 任务按约束未执行 headed 开发 smoke。

仅调试 FastAPI 时，可以在仓库根目录执行：

```bash
cd gallery-dl-backend
./.venv/bin/python -m gdl_backend --config config.json
```

默认监听 `127.0.0.1:8787`：

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz
```

`/healthz` 是桌面启动门槛；`/readyz` 描述可选资源是否就绪，`503` 是可诊断状态，不阻塞桌面 UI。

## 配置、数据与可选资源

生产首次启动只在 Tauri stable app config/data 目录创建最小配置，不修改只读 bundle：

- app config：`backend.json`；
- app data：`runtime/backend.sqlite3`、`runtime/logs/`、`runtime/proxy/`、`downloads/`、`credentials/`、`subscriptions/`、`models/`；
- bundled resources：`backend/runtime/python`、`backend/runtime/metadata`、`backend/app`、release manifest/hash 和目标平台第三方 notices。

Linux 的目录根遵循 XDG config/data 目录，Windows 使用系统 Roaming AppData；两者都追加 Tauri identifier `dev.imageweave.desktop`。生成配置中的 `gallery.python_executable` 与 `dedup.python_executable` 指向同一个 bundled runtime。已有 `backend.json` 永不被首次启动逻辑覆盖。

当前 release lock 明确不打包 dedup 模型、mihomo 或浏览器 runtime。缺少这些可选资源时后端保留既有 `/readyz` 语义，不创建伪模型、伪二进制或伪能力。认证材料、用户输出、数据库、缓存和日志不会进入安装包资源树。

开发配置字段、边界和安全默认值见 [`gallery-dl-backend/config.example.json`](gallery-dl-backend/config.example.json)。不要提交真实 cookie、token、代理凭据或本机绝对路径。

## 验证

### Desktop frontend

在 `desktop/` 执行：

```bash
npm ci
npm run check
npm run test
npm run test:coverage
npm run build
npm run verify:artifacts
```

### Python and release contracts

在仓库根目录执行：

```bash
python -m pytest -q
python -m pytest gallery-dl-backend/tests -q
python -m pytest tests/test_desktop_release.py tests/test_third_party_notices.py -q
python -m compileall -q scripts gallery-dl-backend/gdl_backend
```

### Rust host

```bash
cd desktop/src-tauri
cargo fmt --check
cargo check --locked
cargo test --locked
```

### P6 headed 验证边界

以下项目 **未执行（任务约束）**，不是 PASS/FAIL：

- Linux WebKitGTK 和 Windows WebView2 安装后启动、退出、重启 smoke；
- 正式截图；
- 六场景、多窗口、100%/125%/150% 缩放与视觉回归；
- 完整键盘路径和无障碍检查；
- Tasks、Crawl、Review 的真实性能矩阵。

允许 headed 环境后应按 [桌面重构 P0 基线](docs/2026-08-23-tauri-svelte-desktop-refactor-p0-baseline.md) 和 [架构文档](docs/ARCHITECTURE.md) 补跑，不得用静态检查替代真实 WebView 证据。

## Repository layout

| Path | Responsibility |
| --- | --- |
| `desktop/` | 唯一 Svelte 前端、Tauri host、capabilities 与 bundle config |
| `gallery-dl-backend/gdl_backend/` | FastAPI API、SQLite、调度、代理、授权、审核和 worker |
| `gallery-dl-codeberg/` | 锁定的 gallery-dl submodule source |
| `scripts/desktop_release.py` | 唯一 runtime assembly、bundle build 与静态验证入口 |
| `scripts/third_party_notices.py` | 从 npm/Cargo/Python/runtime 锁定输入生成 notices |
| `docs/third-party-notices.md` | 经 Linux canonical assembly 生成的随包组件名称、版本、许可证与来源 |

## License and third-party software

ImageWeave 仓库代码使用 [MIT License](LICENSE)。随桌面安装包分发的 runtime、Python/npm/Cargo 包和 gallery-dl source 具有各自许可证；Linux canonical 清单见 [第三方 notices](docs/third-party-notices.md)，每个安装包还携带 assembly 针对自身目标平台生成的 notices。release assembly 会从锁文件和实际安装 metadata 重新生成并校验 notices；无法证明来源或许可证的资源不会被打包。
