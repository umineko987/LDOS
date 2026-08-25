# ImageWeave Tauri 桌面前端重构设计

- 日期：2026-08-23
- 状态：P0–P6 仓库内可自动闭环项已实施；headed 实机项待补跑（任务约束）
- 目标平台：Linux、Windows
- 前端：Tauri 2 + Svelte 5 + TypeScript + Vite
- 后端：继续使用 Python + FastAPI
- 当前架构基线：[ARCHITECTURE.md](ARCHITECTURE.md)
- 当前视觉基线：[2026-08-14-nocturne-glass-webui-design.md](2026-08-14-nocturne-glass-webui-design.md)

本文保留原始实施设计，并在 P6 收口后记录实际完成边界。当前仓库已包含唯一 Tauri/Svelte
前端、Python/FastAPI 后端、受控 runtime assembly 和正式 bundle 配置；仍需 headed 环境执行的
项目明确列为“未执行（任务约束）”，不能把静态验证写成实机 PASS。

## 0. 先看结论

本轮不是把现有页面原样塞进 Tauri，而是在保留产品设计的前提下替换前端实现。

必须保留：

- 夜航玻璃视觉、六个内置场景和当前排版语言；
- 顶部菜单栏、桌面、应用窗口、应用中心和 Dock；
- 交通灯、拖拽、缩放、层级、最大化、最小化和关闭语义；
- 当前 10 个应用、Hash 深链接、键盘、焦点和无障碍行为；
- Python、FastAPI、SQLite、调度、代理、授权和去重业务实现。

必须替换：

- 手写 DOM 全量重建；
- 当前自研 Store/View 渲染组合；
- 高频路径中的 `left/top/width/height` 无节流写入；
- 任务页每 1.5 秒获取并重建最多 1000 行的实现；
- 旧原生 ESM 前端的交付和测试入口。

最终只有一套 Svelte 前端。Tauri 是正式产品入口；FastAPI `/ui/` 可以继续提供同一份构建产物作为诊断与兼容入口，但不得维护第二套浏览器 UI。

## 1. 目标与取舍

### 1.1 目标

1. 保留当前模拟操作系统的产品身份，不改成普通管理后台。
2. 让窗口拖拽、缩放、切换和任务轮询保持稳定响应。
3. 用组件和细粒度状态更新替代手工大范围 DOM 重建。
4. 让 Tauri 管理宿主窗口、后端进程、启动失败和退出清理。
5. 保持后端业务 API、数据库与任务状态机为 Python/FastAPI 所有。
6. 每迁移一块就删除被替代实现，最终系统比当前更简单。

### 1.2 明确取舍

- 保留的是视觉语言、信息架构和交互语义，不保留旧 DOM、CSS selector 或 JS 模块形状。
- 静止状态继续呈现完整夜航玻璃；直接拖拽和缩放时允许临时使用无模糊实色回退，以换取连续帧。
- Tauri 不承载业务规则；Rust 只负责桌面宿主、sidecar 生命周期和极少量平台能力。
- 首轮不把 Python 服务、下载 worker、去重 worker 或 SQLite 重写为 Rust。
- 首轮不新增 Gallery、Export 的后端业务能力；两者继续保持明确的 preview/unavailable 语义。
- 不新增移动端布局。最低桌面工作区仍为 `1180 × 720` CSS 像素。

## 2. 迁移前性能问题的代码依据（历史基线）

下表记录 P0 时旧手写 WebUI 中存在的高成本路径。P5 已删除这些源码；表格只保留为迁移决策证据，不描述当前运行架构，也不把 Tauri 本身描述为性能修复。

| P0 历史路径 | P0 机制 | 重构要求 |
| --- | --- | --- |
| `gallery-dl-backend/gdl_backend/webui/styles/tokens.css` | 主窗口 `blur(60px)`、`saturate(180%)` | 静止时保留；直接操控时降级；禁止内部重复 backdrop |
| `gallery-dl-backend/gdl_backend/webui/styles/desktop.css` | 每个可见窗口、菜单和 Dock 都是独立合成层 | 保留顶层玻璃数量约束，隐藏/最小化时彻底退出合成 |
| `gallery-dl-backend/gdl_backend/webui/js/core/window-dom-lifecycle.js` | 每次指针移动写入 `left/top/width/height` | 拖拽改为 `requestAnimationFrame + translate3d`，结束时只提交一次 |
| `gallery-dl-backend/gdl_backend/webui/js/core/tasks-model.js` | 活动批次 1.5 秒轮询，前端上限 1000 条任务 | 当前页固定 100 条，摘要与当前页一次提交 |
| `gallery-dl-backend/gdl_backend/webui/js/components/tasks-view.js` | `replaceChildren()` 重建完整任务表及多个事实区 | 使用 keyed rows，只更新变化行和受影响事实 |
| `gallery-dl-backend/gdl_backend/webui/js/apps/tasks.js` | 成功读取后 Store dispatch 与 phase 更新连续触发完整 render | 一个响应周期只允许一次领域状态提交 |
| `gallery-dl-backend/gdl_backend/webui/js/components/crawl-view.js` | 选择、排序和筛选会重建来源、候选与 EH 标签区域 | 使用稳定 key、派生列表和局部组件更新 |

原设计要求录制 Chromium 与目标 Tauri WebView 的 Performance trace。该 headed 证据在本次阶段未执行（任务约束），因此表格不构成真实性能结论。

## 3. 目标架构

```text
Tauri Desktop（Rust）
├─ 宿主窗口、单实例、外部链接与退出生命周期
├─ 启动并监控 Python/FastAPI sidecar
└─ 加载 Svelte/Vite 构建产物
        │
        ├─ Desktop Shell
        │   ├─ Menu Bar
        │   ├─ Window Layer
        │   ├─ Application Center
        │   └─ Dock
        │
        ├─ App Components + Domain State
        └─ API Client
              │ HTTP / loopback
              ▼
Python + FastAPI
├─ 现有 /api/v1、/healthz、/readyz
├─ ServiceContainer 与领域服务
├─ SQLite
├─ gallery-dl worker
├─ Proxy/Mihomo
└─ Dedup worker
```

### 3.1 状态所有权

| 状态 | 唯一所有者 |
| --- | --- |
| Tauri 宿主窗口、sidecar 进程 | Rust 壳层 |
| 模拟桌面的窗口栈、焦点、z-order | Svelte desktop store |
| 各应用服务端快照 | 对应应用 domain store |
| 未提交表单 | 对应应用组件或 domain store，不能同时保存两份 |
| 下载、代理、授权、审核、调度最终状态 | FastAPI 后端与 SQLite |
| 窗口位置与外观偏好 | 前端 persistence adapter |

不建立第二份窗口栈、应用清单、轮询注册表或后端业务缓存。

### 3.2 Tauri 与 FastAPI 边界

Rust 只执行以下职责：

- 保证桌面应用单实例；
- 根据现有配置启动后端；
- 以 `/healthz` 作为进程可用门槛；
- 把 API origin 和后端版本作为非敏感运行配置提供给前端；
- 后端异常退出时显示受控启动/恢复界面；
- 应用退出时优雅终止后端及其子进程树；
- 阻止主 WebView 导航到未授权页面，并把外部链接交给系统浏览器。

Rust 不访问 SQLite，不实现 API proxy，不复制 Python schema，也不决定任务状态。

`/readyz` 不作为打开界面的硬门槛，因为可选代理、模型或去重环境缺失时它可以合法返回 503；这些事实继续由“系统诊断”展示。

### 3.3 前端加载与 API 通信

正式 Tauri WebView 加载本地 Vite 构建产物。前端通过运行配置取得 FastAPI origin，默认是 `http://127.0.0.1:8787`。

同一份构建产物可以复制到 FastAPI 的 `/ui/` 静态目录：

- Tauri 内运行时，API client 为请求添加 loopback origin；
- 浏览器从 `/ui/` 运行时，API client 使用当前同源 origin；
- 两种入口共享完全相同的组件、状态和模型代码。

不建立 Rust HTTP 转发层，也不为 Tauri 复制一套 API contract。

### 3.4 本地来源保护

当前 `local_origin_guard` 会拒绝 `same-site` 和 `cross-site`。Tauri 本地资源调用 loopback API 时，需要做一次最小安全扩展：

1. Host 仍只允许与配置端口匹配的回环地址；
2. 浏览器 `/ui/` 的 `same-origin` 和 `none` 继续允许；
3. 只允许配置中列出的精确 Tauri/Vite origin；
4. 其他跨站来源继续返回 `forbidden_cross_site`；
5. CORS 只开放实际使用的方法和请求头；
6. Review 图片等 Canvas 媒体使用明确的 CORS 请求，不把 token 放进 URL；
7. 为预检、媒体和写请求增加后端契约测试。

Tauri capability 采用最小授权。业务 WebView 不得获得 shell、任意文件系统或任意子进程权限；sidecar 只能由 Rust 启动。

## 4. 产品设计保留合同

### 4.1 五层 OS 壳层

重构后继续保留以下层级：

1. 壁纸层；
2. 顶部菜单栏；
3. 应用窗口层；
4. 应用中心；
5. Dock。

应用中心、菜单和 Dock 必须全部由同一份 typed application definitions 派生。

### 4.2 当前应用

新 definitions 必须准确覆盖当前 10 个应用：

- Ready：Crawl、Tasks、Proxy、Vault、Review、Policy、Diagnostics、Personalization；
- Preview：Gallery、Export。

每项继续包含唯一 `id`、route、标题、图标、分组、顺序、availability 和默认窗口状态。Review 默认最大化，其余当前默认行为保持。

### 4.3 模拟窗口语义

必须保留：

- 多窗口同时可见；
- 窗口点击聚焦和 z-order；
- 拖拽、右侧/底部/角落 resize；
- 最大化、恢复、最小化和关闭；
- 最大化当前窗口时隐藏 Dock、保留菜单栏；
- 后台最大化窗口不影响前台普通窗口的 Dock；
- Dock 的 closed、focused、background、minimized 状态；
- Hash 深链接只打开对应目标窗口；
- 关闭或最小化前的未保存内容确认；
- 菜单、Dock、Dialog 和窗口控件的键盘与焦点返回。

模拟窗口的交通灯只控制内部应用窗口，不控制最外层 Tauri 宿主窗口。首轮保留系统原生宿主窗口装饰，避免产生第二套“退出整个程序”语义。

### 4.4 视觉合同

初始迁移直接复用当前语义 token：

- 深色夜航根主题；
- 六个内置径向光井场景；
- 香槟金装饰强调；
- 24px 顶层圆角、16px 普通控件圆角；
- 白色/80 以上正文；
- 每个可见应用窗口最多一个主 backdrop；
- 应用内部不增加 backdrop；
- 全局噪点只有一层；
- forced-colors、reduced-motion 和 no-backdrop 回退。

允许改变 CSS 组织和具体 selector，不要求逐像素复制旧截图。新截图必须让现有用户可以立即识别为同一个 ImageWeave 夜航玻璃桌面。

## 5. 前端技术设计

### 5.1 技术栈

只引入一套前端方案：

- Svelte 5；
- TypeScript；
- Vite；
- npm 与单一 `package-lock.json`；
- Tauri 2。

不引入 SvelteKit、Tailwind、CSS-in-JS、Redux/Zustand、额外 Router、通用组件库或第二套主题系统。

依赖的精确版本在首次 scaffold 时依据当时官方稳定版本写入清单并锁定；本文不伪造尚未存在的版本号或命令结果。

### 5.2 目录边界

计划中的源码结构：

```text
desktop/
├─ package.json
├─ package-lock.json
├─ vite.config.ts
├─ src/
│  ├─ main.ts
│  ├─ App.svelte
│  ├─ shell/
│  │  ├─ Desktop.svelte
│  │  ├─ MenuBar.svelte
│  │  ├─ WindowLayer.svelte
│  │  ├─ AppWindow.svelte
│  │  ├─ ApplicationCenter.svelte
│  │  └─ Dock.svelte
│  ├─ apps/
│  │  ├─ crawl/
│  │  ├─ tasks/
│  │  ├─ proxy/
│  │  ├─ vault/
│  │  ├─ review/
│  │  ├─ policy/
│  │  ├─ diagnostics/
│  │  ├─ personalization/
│  │  ├─ gallery/
│  │  └─ export/
│  ├─ core/
│  │  ├─ api/
│  │  ├─ polling/
│  │  ├─ routing/
│  │  ├─ persistence/
│  │  ├─ platform/
│  │  └─ state/
│  └─ styles/
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ capabilities/
   └─ src/
```

每个应用目录只包含该领域的组件、runtime sanitizer、domain state 和 controller/service。共享模块不能反向导入具体应用。

### 5.3 Svelte 状态规则

- Shell store 只保存窗口记录、焦点和壳层状态；
- 每个应用有一个 domain state owner；
- 服务端响应先经过 runtime sanitizer，再进入 state；
- 大列表按 ID 保存，顺序单独保存，避免整个对象树反复复制；
- 派生值使用 `$derived`，副作用使用受控 `$effect`；
- 组件不得直接写 LocalStorage、直接创建轮询器或绕过 API client；
- DOM 临时状态只在真正属于 DOM 时保留在组件中；
- 一个网络周期最多提交一次领域状态。

### 5.4 API client

API client 保持一个实现，负责：

- API origin；
- GET/POST/PUT/DELETE；
- JSON 序列化；
- AbortSignal；
- Idempotency-Key；
- request ID；
- 统一错误 envelope；
- 浏览器与 Tauri 的运行环境差异。

各应用不得直接调用 `fetch`。后端 `details`、原始异常、秘密和路径仍不得直接进入 DOM。

### 5.5 Polling

建立唯一 polling service：

- 同一 key 单飞；
- 关闭和最小化暂停；
- 页面不可见暂停非关键任务；
- 后台可见窗口按当前 4 倍间隔策略降频；
- 恢复时按显式策略立即或延迟执行；
- app destroy 时 abort 并删除注册；
- 轮询结果通过一次 domain commit 更新。

不为首轮增加 WebSocket/SSE。先用正确的分页和局部更新解决真实瓶颈，避免建立第二套实时通道。

## 6. 性能实现规则

### 6.1 窗口拖拽与缩放

拖拽路径：

1. `pointerdown` 记录起始 rect；
2. `pointermove` 只更新最新坐标；
3. 每个动画帧最多应用一次 `translate3d`；
4. 拖拽期间不写 Store、不写 storage、不计算其他窗口布局；
5. `pointerup` 把最终 rect 提交一次并清除 transform。

Resize 路径同样经 `requestAnimationFrame` 合并，每帧最多更新一次尺寸，结束时只提交一次。

直接操控期间：

- 禁用窗口过渡、阴影动画和 backdrop；
- 使用与当前玻璃亮度接近的实色/低透明回退；
- 子组件不响应窗口 rect 的中间状态；
- 不触发 Dock、菜单和其他应用重绘。

### 6.2 Tasks 首个性能切片

Tasks 是重构是否继续的性能门槛：

- 继续使用现有 `limit/offset` API；
- 当前页固定最多 100 行；
- 活动批次每 1.5 秒并发读取批次摘要和当前页；
- 两个响应合并后只提交一次；
- 只更新变化的 keyed row；
- 进度、错误分类和文件事实使用派生聚合；
- 切页时取消旧页请求；
- 写操作后只做一次权威重读；
- 终态、最小化、关闭和离开应用后停止轮询。

不再在一个 DOM 表格中展示前 1000 条任务。完整数量继续来自批次摘要，用户通过分页访问记录。

### 6.3 Crawl

- 来源、候选和标签使用稳定业务 ID/key；
- 单个 checkbox 变化只更新对应候选和派生统计；
- 排序只移动相关 keyed item；
- EH 标签查询只计算可见集合；
- 缩略图继续 lazy/async 解码并在组件销毁时释放监听；
- 搜索结果的原始操作 URL 继续只短暂存在于 Crawl 领域，不进入持久化。

### 6.4 Review

Review 的 Canvas 镜片、归一化坐标、图片窗口和释放逻辑作为独立 imperative engine 保留，不强行改写为声明式逐像素状态。

Svelte 只负责：

- 当前批次、筛选和组；
- 图片选择状态；
- 工具栏和状态栏；
- engine 的 mount/update/destroy 边界。

切组、最小化和关闭后仍须释放图片引用、ResizeObserver、监听器和 rAF。

### 6.5 合成层

- 每个静止可见应用窗口最多一个正向 backdrop；
- Menu、Dock、当前打开的顶层浮层可以各有一个；
- 应用内部卡片、行、表格和工具栏不得增加 backdrop；
- 最小化/隐藏元素必须是 `display:none` 或不在 DOM；
- 不使用持续动画或 blur 动画；
- 多窗口压力场景固定测试 6 个可见窗口和 2 个最小化窗口。

### 6.6 性能预算

以下是验收目标，不是对当前实现的性能宣称：

| 场景 | 目标 |
| --- | --- |
| 60Hz 下连续拖拽 10 秒 | p95 帧间隔不高于 16.7ms；主线程 Long Task（>50ms）为 0 |
| 连续 resize 10 秒 | 每帧最多一次尺寸写入；主线程 Long Task 为 0 |
| Tasks 100 行活动轮询 | 每周期一次 state commit；无 >50ms Long Task |
| Tasks 总量 1000+ | DOM 中仍最多保留当前页 100 行 |
| 最小化应用 | 连续两个原轮询周期内业务请求为 0 |
| 打开/关闭同一应用 20 次 | listener、timer、observer、image 引用回到基线 |
| 6 个可见窗口静置 | 无持续动画；每窗口一个主 backdrop，内部为 0 |

性能测试必须在真实 Tauri headed WebView 中执行。Chromium 浏览器结果只能作为对照，不能替代 WebView2/WebKitGTK 结论。

## 7. 后端保持与允许的最小修改

### 7.1 不改变

- Python 3.11–3.14 约束；
- FastAPI 与 `ServiceContainer`；
- `/api/v1` 业务路径、方法、错误 envelope 和响应白名单；
- SQLite schema、事务和任务状态机；
- gallery-dl worker、代理、授权和去重业务语义；
- `/healthz` 与 `/readyz` 的既有含义。

### 7.2 允许修改

只允许为桌面交付修改基础设施边界：

- 精确 Tauri origin 的 CORS 与 local-origin guard；
- Svelte 构建产物的静态挂载和 package-data；
- Tauri 启动所需的非敏感 runtime metadata；
- 可写目录与打包资源路径；
- sidecar 的启动、关闭和诊断适配。

如性能目标可通过现有分页 API 达成，首轮不增加业务 endpoint。

### 7.3 Python sidecar 打包

不能只把后端做成一个 PyInstaller one-file 后就视为闭环：

- `GalleryRunner` 会再次执行 `python -m gdl_backend.worker_entry`；
- `DedupReviewManager` 会启动独立 Python、去重脚本、Torch 和模型。

生产桌面包应携带可重定位的 Python runtime 和当前 Python 包/worker 资源，由 Tauri 启动该 runtime。`gallery.python_executable` 与 `dedup.python_executable` 指向同一受控 runtime 或其明确环境，不依赖用户系统 Python。

该工作只改变分发方式，不把 worker 业务迁移到 Rust，也不复制多个大型 Python runtime。

## 8. 持久化迁移

首轮保持现有 key 和语义：

- `imageweave.ui:current-app`；
- `imageweave.ui:active-batch`；
- `imageweave.window-layout.v1`；
- `imageweave.window-placements.v2`；
- `imageweave.ui:ui-preferences`。

当前 sanitizer 和迁移逻辑先逐项移植为 TypeScript characterization tests，再替换实现。

要求：

- v2 窗口位置继续只保存 normal rect 和可选 maximized 偏好；
- 不恢复 running/focused/minimized 窗口状态；
- UI 偏好仍只允许内置场景和动效开关；
- 损坏 JSON、危险键和未知字段安全回退；
- Tauri WebView 使用稳定数据目录；
- 不因 API 端口变化丢失 Tauri 本地存储。

## 9. 构建与交付

### 9.1 单一构建产物

`desktop/dist/` 是唯一前端构建产物：

- Tauri 作为 `frontendDist` 使用；
- 后端兼容 `/ui/` 使用同一批字节；
- 产物由 canonical build script 生成，不手工编辑；
- Tauri 包和 Python wheel 中的副本必须通过 manifest/hash 检查一致。

源码只维护在 `desktop/src/`。切换完成后删除旧 `gdl_backend/webui/js` 与手写 CSS 实现，不长期保留两套来源。

### 9.2 开发与 CI

首次实现时建立并锁定以下计划任务：

- TypeScript/Svelte 静态检查；
- 前端单元测试与覆盖率；
- Vite production build；
- Tauri Rust test/check/build；
- FastAPI 定向与完整测试；
- 构建产物一致性检查；
- Linux 与 Windows 桌面 smoke。

现有固定 Node runner 在迁移期继续守护旧实现；切换后由新清单中的固定 Node 与 npm scripts 替代。迁移不得静默降低 Python 或前端 coverage 门槛。

## 10. 线性实施顺序

不建立生产 `/ui-next/`、运行时 feature flag 或长期双实现。新前端只在迁移测试入口中出现，旧生产 UI 在切换前冻结，除阻塞性缺陷外不继续扩展。

### P0：基线与目标契约

- 记录 Tasks、拖拽、resize、Crawl 和 Review 的浏览器性能基线；
- 固化 10 个应用、API、storage、窗口和无障碍行为；
- 为本设计的性能预算建立 red-first 测试。

退出条件：基线证据可重复，目标测试只因新实现尚不存在而失败。

### P1：Tauri/Svelte 基础设施

- 创建 `desktop/`、锁文件、Vite 和 Tauri scaffold；
- 建立 platform adapter、API client、runtime sanitizer 和测试入口；
- Rust 启动现有 FastAPI，完成 health、异常退出和关闭清理；
- 完成精确 CORS/origin guard。

退出条件：空 Svelte 页面可在 Tauri 中读取 `/healthz`，浏览器兼容入口仍可读取同一后端。

### P2：OS 壳层

- 移植 application definitions；
- 完成壁纸、菜单栏、窗口层、应用中心和 Dock；
- 完成 Hash 路由、位置持久化和窗口生命周期；
- 完成 rAF 拖拽/resize 与交互期玻璃降级。

退出条件：窗口行为、键盘、焦点、存储迁移和拖拽性能预算通过。

### P3：Tasks 性能竖切

- 实现批次选择、摘要、100 行分页、轮询和写操作；
- 验证一次 poll 一次 commit；
- 验证终态/最小化/关闭停止请求；
- 在真实 Tauri WebView 中执行性能预算。

退出条件：Tasks 闭环和性能预算通过；未通过则停止后续迁移并修复根因。

### P4：其余应用

按以下顺序迁移，每项完成后删除新树中已被替代的临时兼容代码：

1. Crawl；
2. Proxy、Vault；
3. Policy、Diagnostics；
4. Personalization；
5. Review；
6. Gallery、Export preview。

Review 最后迁移真实应用，避免窗口引擎与 Canvas/媒体生命周期同时排错。

退出条件：每项既有 API、确认、轮询、安全和生命周期契约通过。

### P5：正式切换与旧实现删除

- `/ui/` 切换到 Svelte 构建产物；
- Tauri 切换到正式产品入口；
- 删除旧 99 项手写 WebUI 源闭包及已废弃测试；
- 删除不再需要的 facade、Store、Router、window manager 和 CSS；
- 只保留迁移后仍有真实调用证据的兼容逻辑。

退出条件：仓库不存在可运行的第二套前端。

### P6：桌面分发与文档收口

- 一份 hash-locked、可重定位的 Python runtime 运行 FastAPI、gallery worker 与 dedup worker，并携带同一 runtime archive 的 build provenance 与适用许可证文本；
- bundled `backend/app` 与 stable Tauri app config/data 路径分离，首次配置不含秘密或开发绝对路径；
- Linux DEB/AppImage 与 Windows NSIS 共享唯一 canonical build/verification，Windows 由正式 CI job 执行；
- release tree 和静态安装包验证 frontend bytes、runtime、worker、package-data、资源、秘密与 hash；
- README、ARCHITECTURE、后端文档、设计状态和由锁文件/metadata 生成的第三方 notices 同步。

实施边界：仓库可自动闭环的 runtime assembly、isolated import/worker/HTTP/shutdown、wheel/package-data、
Linux/Windows 配置合同、clean-checkout reproducibility 和静态 bundle extraction 已建立。当前 lock
不分发模型、mihomo 或浏览器 runtime；缺少这些可选资源继续使用既有 `/readyz=503` 诊断语义。

正式截图，以及 Linux WebKitGTK/Windows WebView2 安装后启动、退出、再次启动、六场景、多窗口、
缩放、键盘/a11y 和 Tasks/Crawl/Review 性能矩阵均 **未执行（任务约束）**，不是 PASS/FAIL。
当前 non-headed Arch Linux 主机已生成并静态验证 DEB；AppImage 的 canonical `NO_STRIP=1` 路径在 Tauri 调用的 `linuxdeploy` GTK plugin 中因当前主机缺少其固定读取的 `/usr/lib/gdk-pixbuf-2.0/2.10.0` 目录而失败，准确记录为 packaging-host layout 阻断。
Windows 安装包只在 Windows CI/host 生成，不能把 Linux 上存在配置写成已构建。

退出条件：干净 tracked checkout 可执行同一 canonical release path；安装包只有一份 Svelte frontend
和一份 Python runtime，路径可重定位，文档/notices 与代码一致。真实安装后 headed smoke 和正式
视觉/性能证据在允许 headed 且具备对应平台环境时补跑。

## 11. 测试与验收

### 11.1 前端

- pure sanitizer、state transition、geometry 和 polling 单元测试；
- Svelte shell 与应用组件行为测试；
- API endpoint、method、body、abort 和 stale response 契约；
- storage 兼容、损坏数据和危险键测试；
- listener/timer/observer/media 释放测试；
- CSP、外部链接和禁止 capability 测试。

### 11.2 Tauri

- 单实例；
- 后端启动成功、端口冲突、配置错误和异常退出；
- `/healthz` 成功后进入主界面；
- `/readyz` 503 不阻塞界面；
- 主窗口退出后 sidecar 与子进程关闭；
- 导航白名单和系统浏览器打开外链；
- Linux WebKitGTK 与 Windows WebView2 headed smoke。

### 11.3 后端

现有 Python 测试继续作为业务回归门槛，并新增：

- 精确 Tauri origin；
- 非法跨站来源仍为 403；
- CORS preflight；
- 跨源媒体读取和 Canvas 所需响应头；
- 静态构建产物 manifest；
- Tauri 启动配置不泄露秘密。

### 11.4 视觉与无障碍

至少覆盖：

- `1440 × 900` 与 `1180 × 720`；
- 六个内置场景；
- 10 个应用普通/最大化代表状态；
- 100%、125%、150% 缩放；
- motion on/off 与 reduced-motion；
- forced-colors 和 no-backdrop；
- Menu、Dock、应用中心、交通灯和 Dialog 的完整键盘路径；
- 状态不只依赖颜色；
- 现有正文和 focus 对比度边界不降低。

## 12. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 把 Tauri 当作自动性能优化 | P0 建基线，P3 以 Tasks 和真实 WebView 性能预算阻断后续迁移 |
| Svelte 重写丢失安全投影 | 先移植 sanitizer characterization tests，再接组件 |
| 窗口系统出现第二份状态 | desktop store 是唯一 owner，DOM 只投影 |
| 玻璃在 WebKitGTK/WebView2 表现不同 | 真实双平台 headed 测试；交互期使用统一实色回退 |
| Tauri 跨源请求削弱本地保护 | 只允许精确 origin，保留回环 Host，增加写请求与媒体契约测试 |
| 前端源码与后端 `/ui/` 产物漂移 | 单一 dist、manifest/hash 一致性门槛 |
| 一次性大爆炸无法定位回归 | 按 P0–P6 线性推进，Tasks 未过不迁移其余应用 |
| 长期维护两套 UI | 不设生产 feature flag，P5 删除旧实现 |
| 单文件 Python 打包破坏 worker | 使用一个可重定位 Python runtime，保留当前子进程模型 |
| 文档仍描述旧原生 ESM 架构 | P6 同步正式架构文档，并在本文件记录实际完成边界 |

## 13. 完成定义

以下是最终产品完成定义；实施状态必须区分 repository/static evidence 与真实 headed evidence：

- Tauri 是正式桌面入口，后端仍为 Python + FastAPI；
- 当前夜航玻璃和模拟 OS 设计可以直接识别；
- 当前 10 个应用全部由一套 Svelte 前端提供；
- 多窗口、Dock、菜单、路由、交通灯和确认语义无回归；
- Tasks、拖拽和 resize 达到第 6.6 节性能预算；
- 最小化/关闭应用不轮询、不保留活动 listener 或合成层；
- API、SQLite、调度、代理、授权和审核业务契约无回归；
- Tauri capability、CORS 和 local-origin guard 通过安全测试；
- Linux、Windows headed smoke 通过（P6 仓库收口时未执行：任务约束；仍是最终发布门槛）；
- 旧手写 WebUI、重复 facade、无用测试和失效配置已删除；
- README、ARCHITECTURE、后端文档、构建说明和第三方 notices 已同步；
- 构建产物、Tauri 包和后端 `/ui/` 使用同一前端字节。

P0–P6 的 tracked implementation、静态合同和在当前禁止-headed约束下可执行的验证已经收口。
由于上述 headed 双平台、视觉、a11y 和真实性能证据未执行，不能声称最终产品完成定义全部 PASS；
允许 headed 的 Linux/Windows 发布环境必须补齐这些门槛。

## 14. 与历史文档的关系

[2026-08-14-nocturne-glass-webui-design.md](2026-08-14-nocturne-glass-webui-design.md) 继续作为当前视觉与行为的历史证据。

本设计明确覆盖其中下列旧实施限制：

- 不引入 Svelte/Vite；
- 不引入 npm 构建；
- 必须继续使用手写原生 ESM Store/View；
- 不重写窗口管理实现。

本设计不覆盖其中已经成立的产品约束：

- 夜航玻璃视觉；
- 模拟 OS 信息架构；
- 安全响应白名单；
- 单一状态所有者；
- 轮询生命周期；
- 键盘、焦点和无障碍；
- 测试夹具不得进入正式业务数据路径。

P5 已完成正式切换；P6 按实际代码与验证结果同步 [ARCHITECTURE.md](ARCHITECTURE.md)。本文件继续
保留原始目标和最终产品门槛，同时明确区分已完成的仓库实现与尚未执行的 headed 证据。
