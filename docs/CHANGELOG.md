# ImageWeave 图库（含导出）开发 CHANGELOG

本文件记录按 `docs/图库(含导出).md`（本地文档，不入库）实施的图库与数据集导出开发进度：每个原子提交的改动、决策与阻塞。阶段划分为 G0–G6；每阶段独立提交并只提交本阶段所属文件。

条目格式：`[Gx] 类型: 标题`，附改动文件、验证命令与状态（✅ 通过 / 🔴 预期红 / ⛔ 阻塞）。

---

## G0 · 合同、schema 设计与 red-first 测试

### [G0-1] feat(db): schema v9 图库与数据集导表现

- 状态：✅ 后端全量测试通过（569 tests OK）
- `gallery-dl-backend/gdl_backend/_database_schema.py`
  - `CURRENT_SCHEMA_VERSION` 8 → 9；新增 `GALLERY_EXPORT_SCHEMA_VERSION = 9`。
  - 新增表（全部幂等 `CREATE ... IF NOT EXISTS`，fresh 与 v8 升级路径共用）：`gallery_sources`、`gallery_directories`、`gallery_assets`、`gallery_file_operations`、`gallery_file_operation_items`、`dataset_export_jobs`、`dataset_export_sources`、`dataset_export_items`、`dataset_export_events`。
  - 新增 FTS5 虚拟表 `gallery_search_index`（asset_id/source_id UNINDEXED + file_name/relative_path/txt_content）。运行时缺失 FTS5 时抛出明确 RuntimeError（计划 §5.4：不允许静默降级为浏览器全量搜索）。
  - v8 站点策略迁移块改为显式写入版本 `"8"`（原先写 `CURRENT_SCHEMA_VERSION`，版本常量前进后语义错误）；新增 v9 版本标记迁移块。
- `gallery-dl-backend/tests/test_gallery_export_schema.py`（新增）
  - fresh 建库、v8→v9 升级（保留爬取数据）、重复启动幂等、版本标记事务失败回滚后可恢复、FTS5 可用性探测。
  - 断言表级列契约子集，防止后续 repository 退化成无边界 JSON 大表。
- `gallery-dl-backend/tests/test_database.py`
  - 两个 schema 版本断言 `"8"` → `"9"`（合法版本合同前进）。
- `.gitignore`：新增 `!/docs/CHANGELOG.md` 白名单；`docs/图库(含导出).md` 保持本地不入库。

### [G0-2] feat(gallery): 图库目录与导出合同纯函数

- 状态：✅ 后端全量测试通过（602 tests，含新增 33 个合同测试）
- `gallery-dl-backend/gdl_backend/gallery_catalog.py`（新增）：四种受支持扩展名（大小写不敏感、基本名非空）、`foo.bar.jpg ↔ foo.bar.txt` 配对、严格 UTF-8 解码（接受 BOM、绝不替换字符）、六态客观 TXT 分类（优先级 pair_conflict > io_error > missing > invalid_encoding > blank > normal）、跨平台自然排序键（casefold + 数字游程两位长度前缀）、相对路径安全（拒绝绝对/`..`/反斜杠/控制字符/Windows 尾随点与空格；按原始斜杠分段校验以防 PurePosixPath 吞掉 `.`）、`.imageweave` 保留树、来源根 canonical key（realpath + normcase）与 same/ancestor/descendant/disjoint 关系、回收区 `files/` 与 `operation.json` 布局。
- `gallery-dl-backend/gdl_backend/dataset_export.py`（新增）：12 态导出状态机（draft→preflighting→blocked|ready→staging→paused|failed|staged→committing→completed，恢复分支 recovery_required→committing|staged|discarded；staging/committing 进行中不可直接丢弃，必须先暂停/失败/恢复）、输出别名与 `<别名>/<原相对路径>` 构造、暂存区与 manifest 隐藏布局、Manifest v1 任务/样本记录构造与 JSONL 序列化（首行任务记录、样本按输出相对路径自然排序、确定性输出、禁用键与绝对路径式取值校验）。
- 测试：`tests/test_gallery_catalog_contract.py`、`tests/test_dataset_export_contract.py`。

### [G0-3] test(gallery): 后端 API 路由 red-first 契约

- 状态：🔴 预期红（3 个测试失败：28 个 §7 目标路由未实现）
- `gallery-dl-backend/tests/test_gallery_export_api_contract.py`（新增）：
  - §7.1–§7.4 全部 28 个 gallery/dataset-exports 操作清单；
  - 9 个高容量读路由必须声明 `view=desktop` 安全投影（含 query enum 校验）；
  - 16 个稳定错误码词表（source_not_found、asset_not_found、txt_version_conflict、export_target_conflict 等），404 实体缺失走既有 error envelope。
- 决策：`test_app_routing_contract.py` 的全量 OpenAPI 相等断言留到 G1 路由真实落地时一并更新，避免现在把整个路由契约测试变红。

### [G0-4] test(desktop): 桌面端 Gallery/Export 目标合同（red）

- 状态：🔴 预期红（8 个测试失败：目标 model API 未实现）；`npm run check` 保持 0 错误、其余 316 个前端测试通过
- `desktop/tests/g0-gallery-export-target.test.ts`（新增）：
  - 图库：sanitizeGallerySourceSummary / sanitizeGalleryDirectoryEntry / sanitizeGalleryAssetEntry / galleryNaturalCompare；只接受客观 kind/availability/txt_state（拒绝 approved/needs_review 等人工质量标签）、拒绝绝对路径/raw error/`root_path` 泄露/`__proto__` 注入；`2.jpg < 10.jpg` 自然排序；
  - 导出：EXPORT_JOB_STATES 镜像后端 12 态状态机、EXPORT_TERMINAL_STATES；sanitizeExportJobSummary 只接受权威计数（拒绝 `progress_percent` 模拟进度）、sanitizeExportBlocker 固定阻断码（拒绝 raw exception 与负计数）。
- 决策：经命名空间导入 + 运行时 typeof 守卫表达合同，red 期间不破坏 `npm run check`；现有 P4 Preview 断言与 preview 组件测试保持不动（availability 仍为 preview，G2/G6 重写时再收口）。

### G0 阶段收口

- 退出条件核验：✅ 目标测试（后端 3 + 前端 8）只因实现尚未存在而失败；现有正式应用测试无回归（后端 599/602，前端 316/324，check 0 错误）。
- 预期红清单（后续阶段逐一转绿）：`gallery-dl-backend/tests/test_gallery_export_api_contract.py`（G1/G3/G5）、`desktop/tests/g0-gallery-export-target.test.ts`（G2/G6）。
- 阻塞：无。

---

## G1 · 图库 repository、来源注册与扫描

### [G1-1] feat(gallery): 图库索引 repository 与数据库挂载

- 状态：✅ 后端全量测试通过（提交 `feff138`）
- `gallery-dl-backend/gdl_backend/_database_gallery_repository.py`（新增）：来源注册/解除/重关联（realpath 规范化、同路径与祖先/后代冲突检查、批量来源根互不重叠）、单事务整树扫描提交（uuid5 稳定 ID、自然排序 sort_key、封面拼图、direct/recursive 计数、FTS5 重建、缺失资产标记 missing 而非删除）、目录条目与资产搜索的游标分页。
- `gallery-dl-backend/gdl_backend/database.py`：挂载 gallery repository（保持单一写事务边界）。
- 来源级 content/annotation/indexed 版本按计划 §6.1 语义递增；测试 `tests/test_database_gallery_repository.py`（18 tests）。
- 教训记录：本项目 `Database(":memory:")` 会创建字面量 `:memory:` 文件而非内存库，测试一律用临时目录下的真实文件路径。

### [G1-2] feat(gallery): 目录服务、递归扫描与异步扫描任务

- 状态：✅ 后端全量测试通过（提交 `4f4e374`）；Pillow 12.1.1 进入主依赖并重锁（提交 `8fee4a9`，共享运行时架构下与去重 worker 同版本）
- `gallery-dl-backend/gdl_backend/gallery_service.py`（新增）：GalleryCatalogService——导入/改名/解除/重关联（root 存在性与符号链接检查、公开投影剥离 root_path）、同步全量扫描与线程化异步扫描（running/succeeded/failed + 固定 error_code）。
- 扫描遵守 G0 合同：仅 .jpg/.jpeg/.png/.webp（大小写不敏感）、跳过符号链接文件/目录/junction、`.imageweave` 保留树排除、严格 UTF-8 TXT 解码与六态客观分类、增量检查（相对路径+大小+mtime）。
- 测试 `tests/test_gallery_service.py`（12 tests）：真实临时目录、真实小图片、符号链接、编码异常、增量重扫。

### [G1-3] feat(gallery): 图库 API 路由、缩略图与批次来源自动注册

- 状态：✅ 后端 651 tests 中 648 通过，剩余 3 个失败均为 G0 预期红（trash=G3、dataset-exports=G5 未实现）
- `gallery-dl-backend/gdl_backend/api_routes/gallery.py`（新增）：来源列表/详情/改名/解除/重关联/重扫描、目录条目分页（kind/txt_state/recursive 筛选 + 游标）、资产详情/搜索、缩略图与原图媒体端点（ETag、条件请求、声明式 content-type、媒体响应预算）。所有高量读取端点要求 `view=desktop`（`Literal` 校验层拒绝，与 policies 一致）。
- `gallery-dl-backend/gdl_backend/gallery_thumbnails.py`（新增）：有界解码缩略图缓存（Pillow，尺寸上限与磁盘缓存）。
- 批次来源自动注册（计划 §4）：`Database.finish_crawl_batch_if_ready` 终态时经注入的 registrar 钩子自动注册无冲突批次来源（display_name=站点+日期、dedup_required=存在审核记录即视觉去重、dedup_state 初值 pending_analysis）；`ServiceContainer.reconcile_gallery_batch_sources` 启动对账补注册关机期间终态的批次；钩子异常只记日志绝不阻断爬取收尾。
- 线程生命周期：`GalleryCatalogService.stop()` join 扫描线程后关库（ServiceContainer.stop 与测试清理均调用，修复扫描线程写已关闭数据库导致的测试核心转储）。
- 测试：`tests/test_gallery_api_routes.py`（11 tests，HTTP 级集成）、`tests/test_gallery_service.py` 新增自动注册/对账 5 tests、`tests/test_app_routing_contract.py` 收录 gallery 路由域。
- 决策：来源详情 GET 端点为计划 §7 清单的加法式扩展（重扫描轮询需要），已在合同测试固定集合中登记；relink 与 import 一致地自动触发重扫描。
- 遗留：G1 退出条件中的平台目录选择 adapter（desktop 侧）尚未实现，随 G2 界面推进。
- 阻塞：无。

### [G1-4] feat(desktop): 平台目录选择与结果定位 adapter（窄能力）

- 状态：✅ cargo check/test 通过（14 tests）；`npm run check` 0 错误；前端 327 tests 中 319 通过，剩 8 个为 G0 预期红（G2/G6 目标合同）
- Rust（`desktop/src-tauri/src/lib.rs`、`Cargo.toml`）：新增 `tauri-plugin-dialog =2.7.2` 与两个窄命令——`select_directory`（async 命令 + `blocking_pick_folder` 文档模式；None=取消；非 UTF-8 路径报 `dialog_path_not_utf8`）、`reveal_in_file_manager`（opener 只读定位，空/含 NUL 路径拒绝）。WebView 侧不授任何 dialog/fs 权限（capabilities 不变），文件读写仍归 FastAPI。
- TS（`desktop/src/core/platform/adapter.ts`）：`PlatformAdapter` 增加 `capabilities`、`selectDirectory(purpose)`、`revealInFileManager(path)`；浏览器模式两者抛 `PlatformCapabilityError("capability_unavailable")` 并以 capabilities=false 供 UI 禁用按钮说明原因（计划 §8.1：同一组件，不建第二套浏览器页面）；选定路径经最小消毒（非空、非空白、无控制字符）只进短生命周期表单草稿。
- 测试（`adapter.test.ts`，+3）：浏览器能力不可用、取消返回 null/畸形返回拒绝/宿主失败包装、reveal 载荷校验与调用次数断言。
- G1 退出条件至此全部满足（API 注册临时目录/分页/搜索/缩略图 ✅ + 目录选择 adapter ✅）；浏览器与 headed Tauri GUI 测试按验收规则记为未执行。
- 阻塞：无。

---

## G2 · 只读图库正式界面

### [G2-1] feat(desktop): 图库目标模型——安全投影消费与自然排序

- 状态：✅ G0 图库目标合同 5/5 转绿（剩余 3 红为 G6 导出合同）；`npm run check` 0 错误；桌面 333 tests 中 330 通过
- `desktop/src/apps/gallery/model.ts` 新增 G2 目标模型段（P4 preview API 原样保留，G2-2 替换界面时再收口）：
  - `sanitizeGallerySourceSummary` / `sanitizeGalleryDirectoryEntry` / `sanitizeGalleryAssetEntry`：白名单字段 + 客观词汇表（kind、availability、TXT 六态、dedup_visibility、lifecycle、read_state、固定 error_code 集合），未知字段/人工质量标签（approved、needs_review）/绝对路径/反斜杠/`..` 段/控制字符/原型注入一律 TypeError；产出冻结视图模型，缺省字段填客观默认值。
  - `galleryNaturalCompare`：镜像后端 `natural_sort_key`（casefold + 数字游程两位长度前缀，99 位以上回退原数字），折叠并列以原始串代码单元序做确定性 tie-break；`2.jpg < 10.jpg`。
  - 纳秒时间戳（modified_ns）超出 `Number.MAX_SAFE_INTEGER`：按有限非负 double 透传（仅展示），精确比较始终由后端在全精度下进行——真实投影探针确认了该约束。
- 与后端真实投影逐键核对：来源 15 键、目录 11 键、资产 23 键与白名单完全一致（`list_sources`/`list_directory_entries`/`search_assets` 实测）。
- 测试：`model.test.ts` 新增 5 个 describe 用例（全量投影往返+冻结、缺省默认、来源漂移拒绝、目录含空根路径与封面列表上限、资产默认值/危险路径/`__proto__` 注入、比较器边界）；`dedup_state` 词汇暂为 not_required|pending_analysis，G4 落地时扩展。
- 阻塞：无。

### [G2-2a] feat(gallery): 来源投影携带 root_directory_id（加法扩展）

- 状态：✅ 后端 652 tests（3 红为 G3/G5 预期红）
- `gallery_service.py` 的 `_public_source` 新增 `root_directory_id`（未扫描来源为 null）；桌面进入来源首页不再需要额外往返。
- `tests/test_gallery_api_routes.py`：列表与详情投影均断言该键；导入未扫描时为 null。

### [G2-2b] feat(desktop): G2-2 图库浏览界面——目录树、虚拟化网格/列表与来源导航

- 状态：✅ `npm run check` 0 错误 0 警告；桌面 340 tests 中 337 通过（3 红为 G6 导出合同预期红）；后端 652 tests（3 红为 G3/G5 预期红）
- `Gallery.svelte` 由三栏静态预览重写为正式浏览工作区：
  - 左栏：来源卡片（类型/可用性/去重状态/资产数），激活来源显示路径层级快捷返回。
  - 右侧工具条：面包屑（来源名→路径段）、搜索表单（文件名/相对路径/TXT 原文）、范围（目录/来源）与包含子目录联动、TXT 六态筛选、网格/列表切换。
  - 内容区：封面拼图文件夹卡片（最多 4 封面、不足降级单行）、缩略图网格（`galleryVisibleRange` 窗口化 + 滚动触发 loadMore）、ARIA 列表（sticky 表头 + 窗口化行）。
  - 空态/加载/错误三态齐备；缩略图与原图 URL 一律 `api.resourceUrl`，组件零内联路径。
- `service.ts`（新增）：sources/entries 读取显式 `view=desktop`；`thumbnailUrl` 固定 512 档（后端仅支持 256/512）；响应经模型清洗。
- `state.ts`：浏览 store（目录页应用/追加、来源重载保持活跃项、订阅者异常隔离、destroy 后静默）。
- `controller.ts`：activate 自动加载（idle/loading 都触发）、AbortController 竞态防护、面包屑导航、查询词本地校验拒绝（非法输入不触发网络）。
- `gallery.css`：夜间玻璃主题全量使用真实 token（glass-surface/border/state 系列）；forced-colors/prefers-contrast/reduced-motion/data-motion 无障碍块与 export.css 对齐；`:has()` 适配窗口正文全高布局。
- 应用定义 gallery `preview → ready`；`p4-gallery-export-target`、`preview-apps-components`、`api-response-budget-contract`、`applications/definitions.test` 合同同步演进：gallery=live（传输收敛于 service，view=desktop 纳入监管）、export=preview（保持到 G6）。
- 阻塞：无。

### [G2-3] feat(desktop): G2-3 沉浸式查看器与网格多选

- 状态：✅ `npm run check` 0 错误 0 警告；桌面 359 tests 中 356 通过（3 红为 G6 导出合同预期红）；后端 665 tests（3 红为 G3/G5 预期红）
- `Viewer.svelte`（新增，覆盖在 Gallery 工作区之上的沉浸层）：
  - 顶栏：返回目录按钮、文件名+当前位置序号（x / N）、画布缩放按钮（适应画布 `0`、100% `1`、放大 `+`、缩小 `−`）。
  - 中央画布：中性不透明深底、透明图片棋盘底；滚轮以指针位置为中心缩放（1%–800%，1.2 步进）、按住拖拽平移、双指捏合；切换上一张/下一张始终重置为适应画布并居中（不跨图片保留缩放/平移）。
  - 右侧常驻 TXT 面板：默认原文只读视图、可选标签视图（逗号拆分只读展示，不自动改写 TXT 原文）；六态客观状态徽标（missing/blank/invalid_encoding/io_error/pair_conflict/normal）。
  - 底部缩略图片带：当前项高亮、点击跳转、支持方向键持续导航；图片来源一律 512 档缩略图，画布用原图。
  - 键盘：←/→ 上一张/下一张（边界 no-op）、Escape 返回目录；文本输入控件中不劫持按键（`closest("input, textarea, select, [contenteditable=true]")` 防御）。
  - 打开时焦点移入查看器、关闭时焦点归还网格（记录最后聚焦卡片）。
- `model.ts` 新增纯函数：`sanitizeGalleryAnnotation`（注解投影白名单+六态校验）、`parseGalleryTxtTags`（标签解析去空去重、上限 200）、`galleryFitViewport`/`galleryOneToOneViewport`/`galleryZoomAtPointer`（画布几何纯计算，scale 1–800%、指针锚定）、`galleryApplyClickSelection`/`gallerySelectAll`/`galleryClearSelection`（多选补丁：单击重建、Ctrl/Cmd 切换、Shift 区间锚点、Ctrl/Cmd+A 全选、非法索引/互斥标志 TypeError）。
- `service.ts` 新增 `getAnnotation`（`view=desktop`）；`state.ts` 新增 viewer 段（打开/移动/注解三态/关闭重置）与 selection 段（applySelection/clearSelection，翻页与目录切换自动清空选择）。
- `controller.ts` 新增 viewer/selection/refresh 编排：openViewer 校验资产在当前列表、注解 AbortController 竞态防护、越界导航 no-op、注解错误落稳定错误码；clickAsset/selectAllAssets/clearAssetSelection；refreshDirectory 重进目录拉新。
- `Gallery.svelte`：网格卡片与列表行接入单击选择/Ctrl 切换/Shift 区间/双击与 Enter/Space 打开查看器、Ctrl/Cmd+A 全选、Delete 预留（G3 确认流程）；空选择与多选时显示批量栏（选中计数）；查看器打开时主内容 `inert` 防焦点逃逸。
- 测试：`model.test.ts` +9（注解清洗往返、标签解析边界、几何缩放钳制与指针锚定、选择补丁语义）、`controller.test.ts` +6（查看器打开/导航/关闭/错误码、选择五语义）、`state.test.ts` 扩展 viewer/selection 状态机。
- 阻塞：无。
