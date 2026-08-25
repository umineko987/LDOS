# ImageWeave Architecture

本文描述 P6 收口后的唯一正式架构。历史原生 ESM WebUI 已在 P5 删除；生产 `/ui/`、Tauri 和 release bundle 都使用同一份 Svelte 构建字节。

## 1. System boundary

```text
Tauri 2 host
  ├─ Svelte 5 frontend (desktop/src -> desktop/dist)
  ├─ platform adapter / minimal capabilities
  ├─ BackendManager + process tree ownership
  └─ local HTTP to exact loopback origin
       └─ Python 3.13 runtime
            └─ FastAPI + SQLite
                 ├─ gallery-dl subprocess
                 │    └─ python -m gdl_backend.worker_entry
                 └─ dedup subprocess
                      └─ python dedup_review_worker.py
```

职责固定如下：

- **Svelte frontend**：模拟 OS 壳层、窗口状态、表单草稿、领域安全投影和交互；
- **Tauri/Rust**：窗口、单实例、导航/外链策略、后端启动门槛和进程树关闭；
- **FastAPI/Python**：API、SQLite schema/事务、任务状态机、代理、授权、审核、调度与子进程；
- **release assembly**：构建唯一前端、唯一受控 Python runtime 和可验证安装包。

Rust 不访问 SQLite，不实现 HTTP proxy，不复制 Python schema，也不承载业务规则。桌面应用不直接 spawn worker。

## 2. Canonical frontend

源码仅位于 `desktop/src/`：

- `shell/`：Desktop、Wallpaper、MenuBar、WindowLayer、AppWindow、Dock、ApplicationCenter；
- `core/`：platform adapter、ApiClient、PollingService、runtime sanitizer、focus/persistence/motion primitives；
- `apps/<domain>/`：该领域的组件、sanitizer/model、唯一 state owner、service/controller；
- `styles/`：共享 night-glass tokens、shell 和 application styles。

应用集合由 `core/applications/definitions.ts` 唯一定义。未知应用在 type/router boundary 被拒绝；不存在 placeholder fallback 或第二应用实现。

构建链：

```text
desktop/src
  -> npm run build
  -> desktop/dist
  -> scripts/frontend_artifacts.py sync
  -> gallery-dl-backend/gdl_backend/webui_dist
```

`frontend-manifest.json` 对 canonical file set 和 SHA-256 建模。`npm run verify:artifacts`、后端 manifest tests、Rust bundle tests 和 `desktop_release.py verify-bundle` 共同证明 Tauri bundle 与 `/ui/` 是相同字节；`gallery-dl-backend/gdl_backend/webui/` 不再是运行入口。

## 3. State and lifecycle

### Shell ownership

Shell store 只保留窗口记录、focus、desktop preferences 和 dirty-guard registration，不保留领域 snapshots。窗口集合由稳定 application ID 投影；z-order、maximize/minimize、close、route 和 geometry 都有单一 owner。

拖拽与 resize 使用一个 `requestAnimationFrame` commit path；组件不建立第二份 geometry state。关闭或最小化会从 DOM 移除领域组件。

### Domain ownership

每个应用具有一个 sanitizer、一个 state owner 和一个 controller/service。HTTP response 在一次领域提交前完成安全投影；集合使用稳定业务 ID/key，更新与顺序无关。草稿只由对应领域拥有，并通过 shell dirty boundary 注册关闭/最小化确认。

所有 HTTP 经过唯一 `ApiClient`。周期读取经过唯一 `PollingService`，由 visible/open/focus 生命周期驱动。组件不使用 direct `fetch`、`setInterval`、第二 polling registry、WebSocket 或 SSE。

Review 的 Canvas 镜片、归一化坐标、image window 和 release 逻辑位于独立 imperative engine；Svelte 不保存 per-pixel state。

## 4. Local API and origin contract

桌面只与后端配置中的 loopback endpoint 通信。生产首次配置固定 host `127.0.0.1`、port `8787` 和精确 Tauri origins：

- `tauri://localhost`；
- `http://tauri.localhost`。

开发 origin 只在明确配置中加入。FastAPI 保留 loopback Host 校验、精确 CORS allowlist、write-origin guard 和 Canvas media 所需的精确响应头。秘密、凭据、路径、raw exception 和 raw operation URL 不进入持久 shell/domain projections。
Tauri WebView 只允许 production app origin（debug 额外允许精确 Vite origin）继续内部导航。HTTP/HTTPS 外链由 main-window opener capability 交给系统默认处理程序，不能替换应用页面；`file:`、非批准 origin 与其他 scheme 被拒绝。

启动门槛是 `/healthz`：只有响应 `200` 且 `{"ok": true}` 后主窗口才进入 ready。`/readyz` 表示模型、mihomo、浏览器授权等可选能力；`503` 是正常诊断状态，不阻塞 UI。

## 5. Backend process model

`BackendManager` 是 FastAPI 进程树的唯一 Tauri owner：

1. debug build 从 `gallery-dl-backend/.venv`（或显式 `PYTHON`）和现有 `config.json` 启动；
2. release build 通过 Tauri `resource_dir` 定位 bundled backend，通过 stable `app_config_dir` / `app_data_dir` 准备写路径；
3. 使用选定解释器执行 `python -m gdl_backend --config <path>`；
4. 轮询 `/healthz` 和 backend root version，成功后发布非敏感 runtime metadata；
5. 主窗口关闭、应用退出、启动失败或 backend 异常时关闭完整进程树。

Linux 使用独立 process group，Windows 使用 kill-on-close Job Object。FastAPI 同时监听 parent pipe；父进程 EOF 会触发 graceful shutdown。gallery worker 和 dedup worker 均从 `IMAGEWEAVE_DESKTOP_PYTHON` / 配置解析同一 runtime，不回退到用户系统 Python。

## 6. Relocatable distribution

### Read-only resources

Tauri bundle 只携带：

```text
frontend assets
frontend-manifest.json
backend/
  app/
    gdl_backend/
    gallery-dl-codeberg/
    dedup_core.py
    dedup_models.py
    dedup_resources.py
    dedup_review_worker.py
  runtime/python/          # exactly one controlled runtime
  runtime/metadata/        # runtime build provenance and applicable license texts
  licenses/
  release-manifest.json
  release-files.sha256
```

`desktop/release/runtime-lock.json` 锁定 target、runtime archive、SHA-256、许可证、requirements 和明确 application scripts。当前 lock 的 `dedup_models`、`mihomo`、`browser_runtime` 都是 `false`；无可追溯来源、hash 和许可证的可选资源不打包，也不伪造 readiness。

### Writable state

首次 release 启动在 Tauri stable paths 创建：

```text
app config/
  backend.json
app data/
  runtime/backend.sqlite3
  runtime/logs/
  runtime/proxy/
  downloads/
  credentials/
  subscriptions/
  models/
```

Linux 使用 XDG config/data roots，Windows 使用 Roaming AppData；目录都追加 identifier `dev.imageweave.desktop`。Unix private directories 使用 `0700`，首次 `backend.json` 使用 `0600`。模板不含 secret、credential 或开发绝对路径，且已有配置不会被覆盖。

生成配置将 `gallery.python_executable` 和 `dedup.python_executable` 设置为同一 bundled executable；repo/worker/core 路径指向只读 `resource_dir/backend/app`，数据库、输出、缓存、日志、授权材料和模型路径指向 `app_data_dir`。

### Assembly and verification

`scripts/desktop_release.py` 是唯一 release path：

- 要求 clean tracked checkout，失败即停；
- `npm ci` 后构建/同步 canonical frontend；
- 下载并验证锁定 runtime，以 `--require-hashes --only-binary=:all:` 安装锁定 requirements；
- 复制当前 Python package、worker、gallery-dl submodule source 和必要 package-data；
- 生成 notices、`release-manifest.json` 与逐文件 SHA-256；
- 在隔离 runtime 验证 imports、两个 worker subprocess、FastAPI `/healthz`/`readyz` 和 shutdown；
- 构建 Tauri bundle，静态解包 DEB/AppImage/NSIS，再验证唯一 frontend/runtime、路径、秘密和 hash；
- 完成后再次验证 tracked checkout 未变化。

`.github/workflows/desktop-release.yml` 在 Ubuntu 24.04 与 Windows 2025 执行同一命令；没有第二 packager。CI 上传的包未签名。

## 7. Tauri security boundary

`desktop/src-tauri/capabilities/main.json` 只允许主窗口使用 scoped external URL opener；没有 shell、process、filesystem 或 path capability。应用内导航只允许 production Tauri origin，debug build 额外允许 `http://localhost:1420`。外部 HTTP(S) 导航被拒绝并交给系统 opener；其他 scheme 不打开。

Bundle config 固定 identifier/version/icons/targets、`frontendDist: ../dist` 和唯一 backend resources map。没有 external sidecar binary、Rust HTTP proxy、第二 runtime 或第二 frontend。

## 8. Validation boundary

P0–P5 的 pure unit、simulated DOM/timer、backend contract、artifact、coverage、Rust lifecycle 和 non-headed build tests继续作为回归门槛。P6 增加 runtime assembly、package-data/wheel、notices、bundle extraction、relocation、secret/path scan 和 clean-checkout tests。

下列项目在本次 P6 中 **未执行（任务约束）**，不是 PASS/FAIL：

- Linux WebKitGTK 与 Windows WebView2 headed smoke；
- 安装后启动、退出、再次启动；
- 正式截图；
- 六场景、多窗口、缩放、键盘和 accessibility matrix；
- Tasks、Crawl、Review 真实性能矩阵。

静态安装包解包、临时根目录首次配置/保留/清理和进程子树 tests 已覆盖 repository 可自动闭环部分，但不能替代上述真实 WebView 验证。

本次 non-headed Arch Linux 主机已生成并静态解包验证 DEB。AppImage 的 canonical `NO_STRIP=1` 路径在 Tauri 调用的 `linuxdeploy` GTK plugin 中因当前主机缺少其固定读取的 `/usr/lib/gdk-pixbuf-2.0/2.10.0` 目录而失败，准确记录为 packaging-host layout 阻断；Windows NSIS 未在 Linux 主机伪造，交由 canonical Windows CI job 构建和验证。

## 9. Historical documents

- `docs/2026-08-14-nocturne-glass-webui-design.md`：视觉与交互的历史证据；
- `docs/2026-08-23-tauri-svelte-desktop-refactor-p0-baseline.md`：P0 characterization 和 headed 补跑矩阵；
- `docs/2026-08-23-tauri-svelte-desktop-refactor-design.md`：P0–P6 迁移设计与完成边界；
- `docs/gallery-dl-backend.md`：当前 FastAPI/worker/config 细节；
- `docs/third-party-notices.md`：实际 bundle 第三方组件来源和许可证。

历史文档不构成可运行的第二实现；代码、锁文件、canonical scripts 和 tests 是当前事实来源。
