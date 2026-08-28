# gallery-dl 独立代理池后端

这是一个 FastAPI 后端，用于统一搜索图库地址、按选择顺序建立图片任务，并通过独立
代理租约运行 gallery-dl：

- `../gallery-dl-codeberg` 保持为上游 Git submodule，源码树不做任何本地修改，
  并始终通过独立子进程调用；后端需要的两处行为差异（跨尝试稳定的 `.part` 命名、
  EH 卡死检测心跳）由 `gdl_backend/worker_patches.py` 在 worker 进程内以运行时
  补丁实现，上游接口变化时补丁自动跳过并在任务日志输出 `[gdl-backend-patch]` 告警；
- `gdl_backend/` 负责搜索、规划、调度、授权、代理池和状态持久化；
- `/ui/` 通过唯一的 `WebUIStaticFiles(..., html=True)` 挂载；该小型 `StaticFiles` 子类只为 WebUI
  保留 ETag/Last-Modified 并添加 `Cache-Control: no-cache`，同源提供 canonical Svelte/Vite
  构建复制 `gdl_backend/webui_dist/`。前端源码只位于 `desktop/src/`；`webui_dist/` 是 wheel
  package-data 和 HTTP 发布副本，不是第二套可编辑前端。旧原生 ESM、临时 `/ui-next/` 与 CSS
  fallback 已从正式交付中删除。

## 运行要求

源码开发的 Linux、Windows 与 CPU/CUDA 依赖说明见现有 setup/config；桌面发布命令统一维护在
[根 README](../README.md)。后端源码支持 Python 3.11–3.14；正式桌面分发锁定 Python 3.13.15，
默认只监听本机回环地址。

X、Pixiv、EH 的托管授权需要桌面 Chrome/Chromium；纯后端、下载调度和去重不要求图形界面。
`auth.authorization_proxy` 是授权浏览器的独立代理，与抓取代理池互不影响。

## 主要能力

- 搜索 Danbooru、E-Hentai/ExHentai 与 Pawchive，并从 Danbooru 画师资料补充已验证的 X/Pixiv 账号；
- EH 与 Pawchive 搜索自动携带 Danbooru 画师条目的别名（`other_names`，中日文/罗马字变体）扩搜并合并去重，弥补两站缺少人工链接维护导致的漏检；
- 关键词输入框提供 Danbooru autocomplete 前缀补全（`GET /api/v1/search/autocomplete?q=`），可用画师任意别名前缀（如“柠檬静”）解析出正式 artist tag，由用户自行确认选用，不做静默替换；
- 按来源和地址顺序执行批次，当前地址内部采用图片级并发；
- 利用 Danbooru `source` 在同一批次内预去重，后续 Pixiv/X 作品在建任务前跳过；
- 使用 SQLite/WAL 持久化任务、尝试、事件、日志、租约和批次进度；
- 导入原生 HTTP/HTTPS/SOCKS 代理及常见机场订阅格式；
- 通过 Mihomo 将 VLESS、VMess、Trojan、Shadowsocks、Hysteria、TUIC 等节点桥接为本地 HTTP 出口；
- 对每个新地址执行站点探活，图片任务全程固定一个代理节点；
- 托管 X、Pixiv、EH 的项目专属浏览器授权，Danbooru 与 Pawchive 公共抓取无需登录；
- 为 EH/EHX 批次显式选择 `fullimg` 原图或 1280 查看图，并控制 GP 响应时停止或降级；
- 支持任务取消、失败重试、重启恢复、文件清单和幂等提交；
- 聚合批次结束后可独立启动 L0-L2 去重；严格自动组先淘汰，剩余图片进入分组人工审核。

搜索证据、任务状态与代理租约均以后端持久化数据为准。

## CPU 去重资源 profile

Linux setup 明确写入 `dedup.device=cpu`。以下字段接受 `0`（自动）或正整数覆盖：

| 配置字段 | 16 逻辑 CPU 自动值 | 自动边界 |
| --- | ---: | --- |
| `workers` | 4 | 图片预处理、关系分析和模型解码共用，最多 4 |
| `torch_threads` | 4 | Torch intra-op，同时设置 OpenMP/MKL，最多 4 |
| `torch_interop_threads` | 1 | 每个独立 worker 进程只设置一次 |
| `deep_batch_size` | 2 | CPU 按逻辑 CPU 收敛到 1–4 |
| `neighbor_block_size` | 128 | CPU 按逻辑 CPU 收敛到 64–256 |

CPU 下 OpenCV 固定为 1 个原生线程，避免多个 Python worker 各自展开线程池。worker 在导入
Torch/OpenCV 和启动并行计算前应用边界，并把实际设备、worker、batch、Torch/OpenMP/MKL、
分块和主要阶段耗时写入日志及审核 manifest。资源参数不参与阈值、候选关系、complete-link
分组或质量 winner 判定。`device=auto/cuda` 且字段为 0 时仍沿用原有 8 worker、batch 8、
block 512 且不主动改变 Torch 线程；CPU 服务器应明确使用 `device=cpu`。P0 配置若已有
`workers: 8`，该值会被视为用户覆盖，改为 `0` 才会采用新 profile。

## 最小配置与代理边界

完整字段以 [`config.example.json`](../gallery-dl-backend/config.example.json) 为准。示例中的项目抓取代理池和去重
默认禁用，避免在没有节点源、根 venv 或模型时静默进入半可用状态；Linux 安装器会按所选设备
准备模型并启用去重。直连抓取可以保持 `proxy.enabled=false`；需要抓取代理池时再显式启用。
`config.json` 可提供启动基线；代理源管理 API 的修改会作为完整快照写入
`runtime/proxy/managed-sources.json`，且保存不会自动重载代理池。节点文件写接口只接受
`allowed_node_roots` 内的普通、非符号链接文件：

```json
{
  "proxy": {
    "enabled": true,
    "auto_start": true,
    "subscription_urls": ["https://SUBSCRIPTION_URL"],
    "allowed_node_roots": ["../subscriptions"],
    "transport_core_enabled": true
  }
}
```

可通过 `GET /api/v1/proxy/sources` 读取脱敏快照，并用其 `/subscriptions`、`/node-file`、
`/inline-nodes` 子路由增删改；`DELETE /api/v1/proxy/sources/override` 恢复 `config.json`
基线。桌面化入口 `/ui/#/proxy` 的“代理管理”已提供这些操作及运行池控制；保存与应用严格
分离，修改后需显式执行“应用并重载”，活动租约存在时仍返回冲突。

代理探活缓存配置如下；缓存仅驻留内存，并按目标协议、主机名与端口隔离：

| 配置字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `probe_cache_ttl_seconds` | `600.0` | 同一目标主机全量探活结果的复用秒数；设为 `0` 禁用缓存。 |

批次推进与下载任务使用两层独立上限；批次并行不会放宽全局或每站下载并发：

| 配置字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `scheduler.max_concurrent_batches` | `4` | 同时推进发现与规划的活跃批次数，范围 `1..16`；每个批次内部仍一次只推进一个地址。 |

`/ui/` 的应用中心按 3 组列出 10 个应用。8 个真实应用中，7 个业务应用接入正式 API，外观设置
严格保持本地：

- **图片采集**：autocomplete、聚合搜索、弱证据/EH 标签过滤、来源与地址排序，以及严格批次提交；
- **批次管理**：最近/活动批次、图片任务、1.5 秒活动态轮询、批次取消、失败补齐和重新规划；
- **代理管理**：运行池控制、脱敏代理源编辑，以及保存/显式重载分离；
- **授权管理**：五个目标的安全状态、X/Pixiv/EH 共享浏览器授权、材料/Profile 清理和授权专用代理；
- **去重审核**：显式分析、全量组选择器、待提交组精确分批保存、同步锐利镜片和危险应用确认；
- **站点设置**：为 Danbooru、X、Pixiv、EH 与 Pawchive 调整四项“各站运行设置”；
- **系统诊断**：20 秒只读轮询健康、就绪、最小配置能力和调度摘要，离线时保留安全旧快照；
- **外观设置**：只管理“夜航石墨、月岩、深海、深林、雾褐、暖夜”六个内置深色场景与动效开关；偏好严格保持本地，不发起网络请求或调用业务 API。

夜航玻璃是唯一正式视觉：根 `color-scheme` 固定为 dark，普通表面使用低透明中性白，主要窗口为
`blur(60px) saturate(1.8)`，全局噪点只挂载一次。用户不能写入任意强调色、窗口底色、透明度或
本地图片壁纸。偏好白名单只包含 `wallpaperColor` 和 `animations`；旧 custom 壁纸只经过一次性
IndexedDB delete-only 兼容 seam 清理，失败不阻断桌面启动。低于 `1180 × 720` CSS 像素时只显示
桌面环境 blocker。

**图片库与目录导出**属于同一个 Gallery 工作区：来源/目录浏览、搜索、TXT 查看与编辑、文件回收，以及按允许扩展名复制完整目录均由 Gallery 负责。
正式桌面通过 `/api/v1/gallery/...` 访问这些能力；不存在独立 Export 应用或旧 `/api/v1/dataset-exports` 运行时入口。浏览器模式没有本机目录选择能力时，仅禁用相应目标选择，不建立第二套页面。
“授权管理”不提供后端不存在的手工 Cookie/Token、浏览器导入、文件路径导入或远端验证按钮；来源
勾选/排序、每请求路由和 EH 标签 include/exclude 过滤只属于“图片采集”。

### 各站运行设置

页面面向 Danbooru、X / Twitter、Pixiv、EH 与 Pawchive，每个网站只提供四项设置：

| 页面名称 | API 字段 | 范围或选项 |
| --- | --- | --- |
| 并发任务 | `max_concurrency` | 1–128 |
| 重试次数 | `retry_limit` | 0–20 |
| 重试间隔 | `backoff_base_seconds` | 0–3600 |
| 代理方案 | `proxy_mode` | `direct`、`prefer`、`required` |

桌面页面使用 `?view=policy` 读取五站快照，并通过
`PUT /api/v1/sites/policies/{site}?view=policy` 保存所选网站的完整四字段对象。默认响应形状仍可供
旧客户端读取，但所有 PUT 形状都使用同一个四字段请求模型：缺字段、未知字段以及旧高级字段一律
返回 422，不会忽略后写入。`DELETE` 删除该网站的四字段覆盖，让它重新使用统一默认。

以下运行参数由后端固定，不属于 POLICY API 或 `default_site_policy` 的配置面：

```text
probe_url                         = null
probe_before_use                  = true
node_tags                         = []
http_timeout                      = 60.0
gallery_retries                   = 2
task_timeout_seconds              = 7200.0
download_stall_timeout_seconds    = 300.0
eh_download                       = null
extra_args                        = []
```

`default_site_policy` 也只读取前述四字段；旧配置文件中的高级键会被丢弃，不能改变新任务运行参数。
运行时由后端把四字段与固定值合成为完整 `SitePolicy`。单次任务或 CRAWL 请求的显式
`proxy_mode` 仍优先；CRAWL 的 EH 图片版本/GP 选择与受控单次附加参数仍按请求进入任务快照，不会
被站点固定值误删。

保存只影响之后新建的搜索、规划和任务。已经创建、排队或运行的任务继续使用创建时持久化的完整
快照。数据库 schema v8 在首次升级时与版本标记同一事务清空全部旧 `site_policies` 行；升级完成后
新建的四字段覆盖会在后续重启中保留，不会反复清除。

页面不轮询；激活和写入后读取一次最新值。未保存内容只留在当前表单，切换网站、切换应用、最小化、
关闭和浏览器离开都会先确认。错误只显示受控提示和请求 ID，不回显提交原文。

`HTTP_PROXY`/`HTTPS_PROXY` 和 setup 的 `--proxy` 只服务于 git/pip/Mihomo/模型下载，不会写入
config，也不会被 doctor 当作抓取代理池节点。Mihomo 是抓取池中 VLESS/VMess/Trojan 等隧道
节点的本地传输核心，不是节点订阅本身。`auth.authorization_proxy` 又是共享授权 Chrome 的第三
条独立线路。后端完整导入项目节点后统一探活，不限制导入数量。

默认从项目 `bin/` 和系统 `PATH` 查找 Mihomo。其他位置使用
`proxy.transport_core_binary`；需要固定校验本地可执行文件时，再设置
`proxy.transport_core_sha256`。

## 启动与入口

推荐从根目录运行 `./scripts/run.sh`，它会先执行快速 doctor。直接运行后端脚本时只使用明确的
`PYTHON` 或 `gallery-dl-backend/.venv/bin/python`；venv/config 缺失会 fail-fast，不再回退
系统 Python 或静默使用默认配置。`--config`、`--host` 和 `--port` 会继续透传：

```bash
bash gallery-dl-backend/run_backend.sh --port 8788
```

Windows 从仓库根目录运行 PowerShell 启动器；它固定使用后端 venv，不会退回系统 Python：

```powershell
.\gallery-dl-backend\run_backend.ps1
```

默认入口：

| 用途 | 地址 |
| --- | --- |
| WebUI | `http://127.0.0.1:8787/ui/` |
| API | `http://127.0.0.1:8787/api/v1` |
| Swagger | `http://127.0.0.1:8787/docs` |
| 健康检查 | `http://127.0.0.1:8787/healthz` |
| 就绪检查 | `http://127.0.0.1:8787/readyz` |

`/healthz` 只表示进程与 SQLite 存活；`/readyz` 结构化报告 submodule、调度器、项目抓取代理、
Mihomo、去重 Python、Torch 实际设备及 SSCD/DINOv2 缓存。禁用组件显示 `disabled`，启用去重
但 Python/Torch/任一启用模型缺失时返回 HTTP 503。`./scripts/doctor.sh` 做同类快速检查，并额外
报告配置、runtime、SQLite/sidecar、credentials/managed、模型缓存及外部输出边界，不下载模型、
不运行推理，也不会打印订阅 URL、Cookie、token、代理凭据或完整授权数据。

应用管理目录（runtime 元数据、credentials/managed、审核日志/manifest、代理核心配置、模型
缓存）为 0700，敏感文件为 0600；创建前拒绝管理路径现有组件中的符号链接。setup 使用 `umask 077` 并只
修复上述项目管理路径。`default_output_root` 位于 runtime 内时由应用维护；用户配置到外部的
输出根目录不被 setup、应用或 doctor 递归 `chmod`，doctor 只诊断。

### 本地网络与安全边界

服务只允许绑定回环地址。

- 后端仅接受与 `server.port` 匹配的 `127.0.0.1`、`localhost` 或 `[::1]` 回环 Host；不支持通过反向代理或自定义域名访问。SSH 本地端口转发仍可用，本地端口应与 `server.port` 一致。

任务和探活目标默认拒绝回环、私网、链路本地及保留 IP。
`server` 区域的目标地址校验开关如下：

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `strict_target_dns` | `true` | 要求 DNS 返回的每个地址均为公网；仅在确认某个合法站点被误拒时才改为 `false`，退回“至少一个公网地址”的兼容模式。 |

本地部署确需访问局域网图站时，在 `server` 配置中设置
`"allow_private_targets": true`。

## Linux CPU CI 分层

- `.github/workflows/linux-cpu-fast.yml`：每次 push/PR/手动触发；检查 Shell 语法和锁漂移，
  在 Python 3.11/3.14 跑后端完整测试，并在 3.14 做干净 CPU 锁安装、根测试、CPU 纯净性、
  `/healthz` 与 ready/not-ready 语义。快速层不下载大模型。
- `.github/workflows/linux-cpu-real-models.yml`：每周和手动触发；缓存固定公开模型，校验
  SSCD+DINOv2，并用程序生成、无敏感内容的图片跑 CPU worker 闭环。
- 两层均复用仓库 setup/smoke 脚本，不包含开发机代理。私人 `runtime/downloads` 样本测试继续
  可选；它不再是唯一真实回归证据。

本地复现关键 smoke：

```bash
./.venv/bin/python ./scripts/check-cpu-environment.py
./scripts/smoke-linux-service.sh
./.venv/bin/python ./scripts/run-real-model-smoke.py --base-images 4
```

## WebUI 工作流

1. 访问裸 `/ui/` 的空玻璃桌面，通过 Dock 或应用中心启动应用；也可使用 `#/应用ID` 深链接。
   当前聚焦窗口最大化时 Dock 完全隐藏，窗口保留菜单栏并延伸到视口底部；恢复、最小化、关闭或切到普通窗口后 Dock 自动返回。Svelte shell 从空窗口栈启动，hash router、shell state 和窗口组件共同提供唯一运行路径，不保留旧 ESM 或 CSS fallback。
2. （可选）在“外观设置”选择六个同源内置夜景之一，并开启或关闭界面动效；
3. 查看代理池状态，按需启动、重载或探活。
4. 在“授权管理”中完成所需站点登录。
5. 输入关键词搜索来源，核对候选和弱证据，并调整来源/地址顺序。
6. 设置单地址图片并发数，提交批次并查看地址与图片任务状态。
7. 批次结束后按需启动去重，通过当前筛选的全量组选择器审核重复组、独立图片和读取失败组；可显式启动同步放大镜检查细节，保存待提交组后再应用整理结果。

界面直接调用下述 API；搜索归并、执行顺序、代理租约和任务状态均以后端数据库为准。

### 桌面 WebUI 状态、轮询与安全边界

所有业务请求只经 `desktop/src/core/api/client.ts`，周期读取只经共享 `PollingService`；应用组件不直接调用 `fetch`/XHR 或创建自己的 interval。后端响应先经过对应领域 model 白名单投影，再一次提交到该领域唯一 state owner；shell state 只拥有窗口 lifecycle，不保存领域快照。

爬取提交所需的原始地址只在 Crawl controller 内短暂保留，批次/任务/review 响应中的 URL、绝对路径、原始错误和内部载荷不会进入持久 state 或不安全 DOM。窗口栈从空数组开始；session current-app 只用于运行期导航协调，不恢复运行、焦点、最小化或窗口栈。

`imageweave.window-placements.v2` 只按应用保存经过几何校验的最近 normal rect 和可选 maximized 偏好；旧 v1 工作区最多一次迁移为位置提示。`imageweave.ui:ui-preferences` 只保存 `wallpaperColor`（六个合法场景 ID）和 `animations`（`on | off`）；未知字段、危险键、accessor、损坏 JSON 和旧 custom 值都安全回退。不保存 CSS 声明、颜色函数、图片内容、文件名、路径、Base64/Data URL 或 Blob URL。

“外观设置”不发起网络请求、调用业务 API、增加后端端点或上传文件。六个场景只定义于 `desktop/src/core/personalization/scenes.ts`，预览即时投影到 shell，提交只经现有 persistence service 写 UI 偏好键。正式代码不读取壁纸 IndexedDB，不导入、解码或重编码本地图片，也不创建 Blob/Object URL；损坏或退役值回退到受控默认 `graphite`。

“批次管理”仅对活动批次执行一个 1.5 秒、生命周期受控且不重叠的轮询，终态、404、最小化、
关闭或切出应用即停止；写操作加锁并在完成后读取权威快照。“去重审核”只在分析处理中轮询；
正式比较舞台按批次与筛选各读取一次 `all=true` 全量元数据，组选择以及“上一组 / 下一组”按钮均在
本地数组工作，不额外请求列表。原图只加载当前组并至多预载一个相邻组，切组、切筛选、最小化或
关闭时释放旧引用。方向键移动当前组的活动图片，`Space` 或图片点击切换保留状态；`Enter` 在可编辑
状态采纳当前组并前进，在只读浏览状态只前往下一组；`Backspace` 返回上一组。这些编辑操作通过
`dirtyGroupIds` 精确记录，写入按每批最多 50 组串行提交。切换筛选、切换批次
或离开应用前先保存，任一批失败都会保留完整草稿并阻止切换。同步放大镜默认关闭，可由按钮或 `X`
开关；启用后使用同一归一化坐标和锐利 Canvas 取样，鼠标移动同步坐标，滚轮调整倍率至最高 `1:1`，
坐标锁定只通过镜片工具区按钮操作。“去重审核”采用桌面布局，不包含移动端或触控专用适配。
“系统诊断”使用一个 20 秒只读轮询；
`GET /api/v1/config?view=diagnostics` 与 `GET /api/v1/scheduler/status?view=diagnostics` 只返回受控
布尔值、计数和枚举，不返回主机路径、秘密、配置正文、任务标识或原始异常。默认不带 `view` 的
legacy API 契约保持兼容。

桌面 WebUI 的唯一源码位于仓库根 `desktop/src/`，由 Svelte/TypeScript 与共享 ApiClient、PollingService、persistence、windowing 组成。它不需要独立前端服务，但发布前必须使用 `desktop/package-lock.json` 锁定的 Vite 构建；后端不得维护手写 HTML/ESM/CSS 源码副本。所有可见响应先经 desktop 领域 model 白名单投影，异常界面不渲染后端 `details`，控制台不记录用户输入、请求/响应、凭据、路径或异常对象。

### `/ui/` 静态交付与 wheel 边界

`npm --prefix desktop run build` 是 canonical frontend build：Vite 生成 `desktop/dist/`，随后 `scripts/frontend_artifacts.py sync` 生成 `frontend-manifest.json` 并原子同步同批字节到 `gdl_backend/webui_dist/`。该后端目录是可重现的 package-data 发布副本，不是第二套可编辑前端源码。Tauri `frontendDist` 直接使用 `desktop/dist/`；FastAPI `/ui` 只挂载 `webui_dist/`。

manifest 为每个 HTML、hashed asset 和静态资源记录相对路径、size 与 SHA-256。`npm --prefix desktop run verify:artifacts` 必须证明 canonical dist 与后端发布副本逐字节一致、Tauri 配置解析到同一 dist；给定 wheel 时还要证明 `gdl_backend/webui_dist/` 成员与 manifest/`RECORD` 一致，并拒绝任何 `gdl_backend/webui/` legacy 成员。`pyproject.toml` package-data 只覆盖 `webui_dist/*.html`、manifest JSON 与 `webui_dist/assets/*`。

正式 `/ui/` 根与 trailing-slash redirect 沿用 Starlette mount 语义；构建产物中的相对 hashed asset 返回正确 MIME。HTML 与 asset 响应均为 `Cache-Control: no-cache`，同时保留 ETag/Last-Modified；条件请求返回 304，业务 API 不继承该 header。缺失静态资源返回 404，hash fragment 仍由同一 `index.html` 和 desktop hash router 解释。
Gallery 是唯一的图库与目录导出桌面入口：正式界面直接调用 `/api/v1/gallery/...`，包含来源、目录、搜索、资产内容/缩略图、TXT、文件操作、回收区和短生命周期目录导出；浏览器仅在平台不具备本机目录选择时禁用目标选择。旧 `/api/v1/dataset-exports` 与独立 Export 应用均不注册。
当前正式 API 基线为 OpenAPI 70 paths/87 operations、递归展开 87 条 APIRoute 和唯一 `/ui` 静态挂载；
路径、方法、operation ID、响应集合及路由模块所有权由 `gallery-dl-backend/tests/test_app_routing_contract.py` 精确固定。
更完整的前端模块和合成边界见 [架构与开发约定](ARCHITECTURE.md)。

### 桌面分发与写路径

`scripts/desktop_release.py` 是唯一生产 assembly：它从 `desktop/release/runtime-lock.json` 下载并
校验目标平台的 `python-build-standalone` archive，以 hash-locked、binary-only requirements 安装依赖，
然后只复制 `gdl_backend/`、gallery-dl submodule source、dedup worker/core/model loader 和经代码证实
需要的 package-data。FastAPI、`python -m gdl_backend.worker_entry` 与 `dedup_review_worker.py` 均由
同一 bundled Python 执行，不依赖用户系统 Python，也没有第二 runtime。`backend/runtime/metadata` 保存对应 archive 的 build provenance 与适用许可证文本，供 notices 和静态审计使用；它不参与执行，也不含用户状态。

安装包中的 `backend/` 是只读 Tauri resource。首次启动经 `app.path().app_config_dir()` 创建
`backend.json`，经 `app.path().app_data_dir()` 创建 `runtime/`、SQLite、日志、proxy 状态、downloads、
credentials、subscriptions 和 models 目录。生成配置中的 gallery/dedup executable 完全相同；
repo/worker/core 指向 bundled app，所有可写状态指向 app data。已有配置不会被覆盖，模板不含
secret、credential 或开发绝对路径。

当前 release lock 不携带模型、mihomo 或浏览器 runtime。缺失可选资源继续通过 `/readyz=503`
诊断，不影响 `/healthz` 启动门槛，也不会创建伪模型或伪二进制。每棵 release tree 都包含
`release-manifest.json`、`release-files.sha256` 和由实际 lock/metadata 生成的 notices；静态 bundle
verification 会拒绝第二 frontend/runtime、未列资源、秘密和开发绝对路径。

## 托管授权

| 站点 | 授权方式 | 托管结果 |
| --- | --- | --- |
| X | 项目专属 Chrome 登录 | X/Twitter Cookie |
| Pixiv | 项目专属 Chrome OAuth | 后端专用 gallery-dl cache |
| EH | 项目专属 Chrome 登录 | E-Hentai/ExHentai Cookie |
| Danbooru | 公共 API | 无需登录 |
| Pawchive | 公共 API | 无需登录 |

X、Pixiv 和 EH 共用项目目录中的持久 Chrome Profile，但每次授权使用独立标签页。后端只
管理这个 Profile，不读取用户日常浏览器数据。搜索、规划或下载实际返回认证错误后，凭证
才会标记为失效；重新授权成功后，尚未运行的同站任务会继续调度。

删除单站授权只删除该站导出的 Cookie 或 Token；删除共享浏览器 Profile 会停止授权会话并
清理浏览器状态，但不会自动删除已经导出的站点凭证。授权材料与缓存仅写入权限受限的项目管理目录；
失效凭证需重新授权后才能恢复后续同站任务。

“授权管理”使用相同路由的 `?view=vault` 响应 profile。默认 `legacy` 响应保持兼容；`vault`
投影只保留受控站点/会话 ID、布尔能力、计数与时间，移除 Pixiv 完整授权 URL、原始会话错误、
失效原因、绝对路径及非必要代理字段；VAULT 操作失败也只返回白名单错误码和受控消息，不透传
`AuthError.message/details`。前端再经 `desktop/src/apps/vault/model.ts` 二次白名单投影后才进入 Vault 领域 state；会话 ID 只短暂保存在应用 controller 中，不进入持久 state、DOM 或 Storage。

授权代理是唯一由 VAULT 表单提交的敏感自由文本：输入使用默认隐藏控件，构造 JSON 后、发请求
前即清空，成功、失败、确认取消、最小化、关闭、路由切换和销毁都会再次清空。代理写接口限制
字段长度和 `Content-Length`，Pydantic 错误不含原始 `input`。普通状态只在激活、写后和手动刷新
时读取；仅活动授权会话使用一个 `vault.authorization`、800ms、隐藏暂停的非关键轮询器。

## API 概览

请求和响应模型以运行中的 [Swagger](http://127.0.0.1:8787/docs) 为准。主要端点：

```text
GET  /api/v1/proxy/status
POST /api/v1/proxy/start
POST /api/v1/proxy/reload
POST /api/v1/proxy/probe
POST /api/v1/proxy/stop

GET    /api/v1/auth
GET    /api/v1/auth/proxy
PUT    /api/v1/auth/proxy
DELETE /api/v1/auth/proxy
GET    /api/v1/auth/{site}
POST   /api/v1/auth/{site}/login/start
GET    /api/v1/auth/{site}/login/{session_id}
DELETE /api/v1/auth/{site}/login/{session_id}
POST   /api/v1/auth/pixiv/oauth/start
DELETE /api/v1/auth/pixiv/oauth/session
DELETE /api/v1/auth/browser-profile
DELETE /api/v1/auth/{site}

GET  /api/v1/search/sites
GET  /api/v1/search/autocomplete
POST /api/v1/search

GET  /api/v1/config?view=diagnostics
GET  /api/v1/scheduler/status?view=diagnostics

POST /api/v1/crawls
GET  /api/v1/crawls
GET  /api/v1/crawls/{batch_id}
GET  /api/v1/crawls/{batch_id}/tasks
POST /api/v1/crawls/{batch_id}/cancel
POST /api/v1/crawls/{batch_id}/retry
POST /api/v1/crawls/{batch_id}/rerun
GET  /api/v1/crawls/{batch_id}/review
GET  /api/v1/crawls/{batch_id}/review?all=true&kind={duplicate|single|unreadable}
POST /api/v1/crawls/{batch_id}/review/start
PUT  /api/v1/crawls/{batch_id}/review/decisions
POST /api/v1/crawls/{batch_id}/review/apply
POST /api/v1/crawls/{batch_id}/review/retry
GET  /api/v1/crawls/{batch_id}/review/images/{image_id}

POST /api/v1/tasks
GET  /api/v1/tasks
GET  /api/v1/tasks/{id}
POST /api/v1/tasks/{id}/cancel
POST /api/v1/tasks/{id}/retry
GET  /api/v1/tasks/{id}/logs
GET  /api/v1/tasks/{id}/events
GET  /api/v1/tasks/{id}/files

GET    /api/v1/sites/policies
GET    /api/v1/sites/policies/{site}
PUT    /api/v1/sites/policies/{site}
DELETE /api/v1/sites/policies/{site}
```

授权读取与操作端点均接受可选 `view=vault`，供桌面 WebUI 取得不含完整 OAuth URL 和原始诊断文本
的最小响应；不传该参数时保持旧响应兼容。Pixiv OAuth 和共享 Profile 清理使用上表专用端点。

审核列表 GET 不带 `all=true` 时继续接受兼容客户端使用的 `limit/offset` 分页。正式 WebUI 使用
`all=true`；后端把 offset 归零，按 ordinal 返回当前 `kind` 的全部人工组，`groups.limit` 等于实际
返回数，自动去重组仍不进入响应。单次全量读取最多 10,000 组，超过时返回
`review_groups_too_large`，列表只含白名单元数据和同源图片引用，不内嵌图片二进制。
`review/decisions` 继续支持部分组提交且单次最多 50 组，WebUI 会只把 `dirtyGroupIds` 对应的组
顺序分批写入；全部写入并权威重读成功后才清除本地草稿。

### 搜索

`POST /api/v1/search`：

```json
{
  "keyword": "artist name",
  "sites": ["danbooru", "x", "pixiv", "eh", "pawchive"],
  "limit": 20,
  "proxy_mode": "required"
}
```

响应按请求中的站点顺序返回 `sources[]`：

- `addresses[]` 保存默认可选的已验证账号/标签地址和 EH 画廊候选；
- `weak_evidence[]` 保存 Danbooru 仅别名匹配、尚未闭环的画师候选；
- `related_profiles` 保存 Danbooru 人工维护的其他平台主页；
- EH 候选带标题、封面、页数和按官方 namespace 分组的 `tag_facets[]`；
- Pawchive 候选来自站内创作者目录（名称包含匹配，按收藏数排序），
  已过滤本站从未导入的 kemono 同步空壳条目。

客户端应区分已验证地址、弱证据与站点候选，并由用户确认后再提交。

### 顺序批次

客户端从搜索响应中选择地址后，按期望顺序提交到 `POST /api/v1/crawls`：

```json
{
  "sources": [
    {
      "site": "danbooru",
      "addresses": [
        {
          "address_type": "artist_tag",
          "label": "artist name",
          "url": "https://danbooru.donmai.us/posts?tags=artist_name"
        }
      ]
    },
    {
      "site": "pixiv",
      "addresses": [
        {
          "address_type": "account",
          "label": "Artist",
          "url": "https://www.pixiv.net/users/USER_ID/artworks"
        }
      ]
    },
    {
      "site": "eh",
      "addresses": [
        {
          "address_type": "gallery",
          "label": "Gallery",
          "url": "https://e-hentai.org/g/GID/TOKEN/"
        }
      ],
      "eh_download": {
        "image_mode": "original",
        "gp_policy": "stop"
      }
    }
  ],
  "concurrency": 20,
  "max_tasks": 10000,
  "proxy_mode": "required"
}
```

来源和地址顺序串行推进，只有当前地址内部的图片任务并发。每个新地址开始前会进行一次
站点探活，并把通过节点集合持久化；该地址的规划与下载只从此集合取得租约。`concurrency`
还受全局调度上限限制，`max_tasks` 限制整个批次的媒体任务规模。
地址详情中的 `pre_dedup_skipped_count` 记录在建立任务前按来源键跳过的媒体任务数；这些项不会进入 `task_count` 或任务列表。

爬取和去重是两个独立的可选环节。批次进入终态后保持“去重未开始”，只有
`POST review/start` 或 WebUI 的“开始去重分析”会建立任务；读取详情、载入历史批次和服务启动
都不会触发分析。启动后，`dedup` 管理器使用仓库根目录的独立 `.venv` 和 `.models` 分析实际
下载文件。原脚本判定的 L0 完全相同组和严格 L1 压缩/重编码/重采样组沿用其 complete-link
分组和质量 winner，非 winner 自动移入 `duplicates/`；自动 keeper、L1/L2 人工候选、独立图
及解码失败图进入审核。正式 WebUI 通过 `review?all=true` 一次投影当前筛选的全部人工组，再用
全量组选择器和本地“上一组 / 下一组”按钮连续审核；元数据全量读取不会同时加载全部原图，网络窗口
始终限制为当前组和至多一个相邻预载组。所有可读组（包括单图）可显式启动同步放大镜，以推荐图的
160px 参考尺度在各图共享归一化坐标；鼠标移动同步取样，滚轮倍率上限为 `1:1`，坐标锁定使用镜片
工具区按钮。审核快捷键为方向键移动活动图片、`Space` 切换保留、`Backspace` 返回上一组以及 `X`
开关放大镜；`Enter` 在可编辑状态采纳并前进，在只读状态仅前往下一组。界面不提供移动端或触控专用布局。

`review/decisions` 以组为单位保存 `selected_image_ids`，空数组表示整组不保留。前端只提交点击图片或
按 `Enter`“采纳并前进”加入 `dirtyGroupIds` 的组，并按每批最多 50 组分批写入；未操作组不会因
一次保存被确认。任一批写入或随后的权威重读失败时，本地完整草稿都会保留。`review/apply` 将人工
未选图片及其同名 `.txt` 移入批次根目录的 `duplicates/`，并保留
原相对目录层级。严格自动淘汰也同步移动同名 `.txt`。应用前要求所有人工组均已确认，分析、
自动整理和应用状态均持久化，可在服务重启后恢复或重试。

EH/EHX 来源的 `eh_download.image_mode` 接受 `original` 或 `resample`。原图模式下，
`gp_policy=stop` 保持严格原图并在 GP 响应时停止，`gp_policy=resized` 允许 gallery-dl
降级为 1280 查看图。WebUI 默认提交 `original + stop`。EH 图片任务使用后端固定的 300 秒
无进展保护，超时会结束当前尝试并按任务的 `max_attempts` 自动换代理重试；已存在的完整文件仍由
gallery-dl 跳过。
批次终态若仍有失败图片，可调用 `POST /api/v1/crawls/{batch_id}/retry`（或 WebUI 的“补齐失败下载”），
只重新排队失败任务，不会重跑成功任务。

### 代理策略

- `direct`：始终直连；
- `prefer`：有健康节点时使用代理，代理池降级时直连；
- `required`：必须取得健康节点，否则按站点策略重试。

例外：节点源包含需要 mihomo 传输核心的隧道节点时，核心启动失败会使代理池启动直接报错
（不再丢弃隧道节点降级续跑）；该状态下 `prefer` 与 `required` 任务立即终止并在任务日志
中提醒，不会回退直连，修复核心后在 WebUI 重新启动代理池再重试。其余场景（代理池被停止、
未启动或运行中暂无可租节点）行为不变。

各站运行设置只开放并发任务、重试次数、重试间隔和代理方案。其余运行参数由后端固定；完整四字段
请求模型由 `PUT /api/v1/sites/policies/{site}` 的 Swagger 定义。

## 失败与恢复

- 明确的代理连接、CONNECT、407 或 TLS 故障会处罚并冷却当前节点；
- 429、502、503、504 作为站点临时错误重试，不处罚节点；
- 认证错误会标记对应托管凭证失效，并暂停尚未运行的同站任务；
- 输入错误、不支持 URL 和资源不存在直接进入终态；
- 后端重启会核验 worker marker、回收遗留进程并重新排队仍可重试的任务；
- 用户取消先中断进程组，超时后终止整个子进程树。

## 测试与诊断

从仓库根目录执行完整后端回归：

```bash
cd gallery-dl-backend
./.venv/bin/python -m unittest discover -s tests -v
cd ..
```

定向核对 canonical frontend、静态 HTTP、origin/security header 与 package-data：

```bash
npm --prefix desktop run build
npm --prefix desktop run verify:artifacts
cd gallery-dl-backend
./.venv/bin/python -m unittest \
  tests.test_desktop_origin_contract \
  tests.test_api -v
cd ..
```

前端行为、结构、预算与 coverage 只由唯一 desktop workspace 守护：

```bash
npm --prefix desktop ci
npm --prefix desktop run check
npm --prefix desktop test
npm --prefix desktop run test:coverage
```

项目级边界见 [架构文档的 validation section](ARCHITECTURE.md#8-validation-boundary)。wheel 必须从
clean tracked checkout 构建，再用
`python scripts/frontend_artifacts.py verify --wheel <wheel>` 核对 manifest 定义的全部前端成员、wheel `RECORD`、size 与 SHA-256；wheel 不得包含任何 `gdl_backend/webui/` legacy 源码。HTTP 合同测试分别核对 200/MIME/字节、`no-cache`/validator、条件 304 与缺失资源 404。不能把开发工作树中的未跟踪文件、浏览器 Profile、coverage 或本机缓存带入包。

P6 release contract 可单独验证，canonical package build 会自动包含这些步骤：

```bash
npm --prefix desktop ci
python scripts/desktop_release.py assemble --target linux-x86_64 --cache-dir .release-cache
python scripts/desktop_release.py verify-tree
python scripts/desktop_release.py verify-runtime
python -m pytest tests/test_desktop_release.py tests/test_third_party_notices.py -q
python -m compileall -q scripts gallery-dl-backend/gdl_backend
```

Windows assembly 使用 `--target windows-x86_64`；正式 Linux/Windows bundle 使用根 README 的
`desktop_release.py build`。正式 WebKitGTK/WebView2 启动、视觉、键盘/a11y、截图和 Tasks/Crawl/Review
真实性能矩阵在本次 P6 中 **未执行（任务约束）**，不是 PASS/FAIL；静态安装包解包和纯 HTTP/worker
smoke 不能替代这些 headed 项。

测试默认使用本地夹具、mock 或 gallery-dl `--version`。需要真实凭据和代理节点的 EH
烟雾脚本不属于当前仓库的提交内容；如需运行此类检查，应在受控本地环境中单独维护。
