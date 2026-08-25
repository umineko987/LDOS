# Tauri/Svelte 桌面重构 P0 基线证据

- 日期：2026-08-23
- 范围：仅 P0「基线与目标契约」
- 起始提交：`e9374f5f1a4d1ec092041abd55dc67ed39763a08`
- 环境：Linux x86_64；CPython `3.14.7`；系统 Node.js `v26.7.0`
- 设计来源：`docs/2026-08-23-tauri-svelte-desktop-refactor-design.md`

> **P5 状态（2026-08-25）**：本文是切换前的历史取证快照，不再描述当前生产入口，也不再提供可执行的 legacy WebUI 命令。当前 10 个应用的唯一权威定义与组件树位于 `desktop/src/core/applications/definitions.ts` 和 `desktop/src/apps/`；P0 目标预算已迁至 `desktop/tests/fixtures/p0-performance-budget.json` 并由 desktop Vitest 套件执行。FastAPI `/ui/` 与 Tauri 均消费 `desktop/dist/` 的同一 canonical 构建，历史 `gdl_backend/webui/` 源码、Node runner 和 current/target legacy 测试已在 P5 删除。
本文只记录 P0 时点原生 ESM WebUI 的历史合同、目标 red-first 差距和非 headed 证据；下文路径与命令仅用于审计当时基线，不再是当前运行或测试入口。

## 1. P0 时点旧实现合同

### 1.1 10 个应用

P0 时点权威来源是后来由 P5 删除的 `gdl_backend/webui/js/core/app-definitions.js`，快照测试是同样已删除的 `gallery-dl-backend/tests/webui_p0_current_contract.test.mjs`；当前权威来源是 `desktop/src/core/applications/definitions.ts`。

| id | 标题 / icon | route | 分组 / 顺序 | availability | 默认窗口 |
| --- | --- | --- | --- | --- | --- |
| `crawl` | 图片采集 / `download` | `/crawl` | workflow / 0 | ready | normal |
| `tasks` | 批次管理 / `list` | `/tasks` | workflow / 1 | ready | normal |
| `proxy` | 代理管理 / `network` | `/proxy` | connections / 0 | ready | normal |
| `vault` | 授权管理 / `key` | `/vault` | connections / 1 | ready | normal |
| `review` | 去重审核 / `images` | `/review` | workflow / 3 | ready | maximized |
| `policy` | 站点设置 / `sliders` | `/policy` | connections / 2 | ready | normal |
| `diagnostics` | 系统诊断 / `activity` | `/diagnostics` | system / 0 | ready | normal |
| `personalization` | 外观设置 / `sliders` | `/personalization` | system / 1 | ready | normal |
| `gallery` | 图片库 / `folder` | `/gallery` | workflow / 2 | preview | normal |
| `export` | 数据集导出 / `archive` | `/export` | workflow / 4 | preview | normal |

`DEFAULT_APP_ID=crawl`，`DEFAULT_ROUTE=/crawl`。每个 registry 项必须提供 `mount/activate/deactivate/unmount`；definitions、应用中心、菜单和 Dock 不允许出现第二份应用清单。

### 1.2 API

- 后端 61 项 path/method/OpenAPI operation ID/response 状态合同由 `gallery-dl-backend/tests/test_app_routing_contract.py::_EXPECTED_OPENAPI_OPERATIONS` 固化。
- 前端消费的 base endpoint 由各 ready app 的 `*_ENDPOINTS` 导出固化：
  - Crawl：`/api/v1/search`、`/api/v1/search/autocomplete`、`/api/v1/crawls`
  - Tasks、Review：`/api/v1/crawls`
  - Proxy：`/api/v1/proxy/status|start|reload|probe|stop|sources...`
  - Vault：`/api/v1/auth...`
  - Policy：`/api/v1/sites/policies`
  - Diagnostics：`/healthz`、`/readyz`、diagnostics profile config/scheduler
- Personalization、Gallery、Export 当前没有业务 API endpoint；Gallery、Export 保持 preview/unavailable adapter。
- 所有应用继续只经 `context.api`；GET/POST/PUT/DELETE、AbortError、JSON、Idempotency-Key 和安全错误 envelope 由现有 Node/Python 合同测试守护。

### 1.3 storage 与 sanitizer

精确 key：

```text
imageweave.ui:current-app              sessionStorage
imageweave.ui:active-batch             sessionStorage
imageweave.window-layout.v1            localStorage（一次性迁移来源）
imageweave.window-placements.v2        localStorage
imageweave.ui:ui-preferences           localStorage
```

固化行为：

- current app 只接受已定义应用 ID；batch ID 只接受既有 1–128 字符格式。
- JSON 非对象、损坏 JSON、超过 4096 字符、危险键、accessor、未知字段安全回退或拒绝。
- v2 只保存 `{appId, rect:{x,y,w,h}, maximized}`；不恢复 running/focused/minimized。
- v1 只迁移 normal rect 与 maximized 偏好，并按 definitions 顺序输出。
- UI 偏好只保留六个内置场景和 `animations=on|off`；旧 custom wallpaper 回到 graphite。

### 1.4 Hash、窗口、键盘/焦点/无障碍

- `#/route` 只解析 10 个已定义应用；空 Hash 返回桌面；未知或带 query 的 Hash 规范化为空。
- 多窗口栈数组是 z-order 唯一事实源；打开、聚焦、最小化、恢复、最大化、关闭及焦点回落由纯 reducer 固化。
- Review 首次打开最大化；已最小化窗口通过 open/restore 回到 normal；持久化不恢复运行窗口。
- 最大化前 normal rect 保留；聚焦最大化窗口隐藏 Dock，后台最大化窗口不隐藏前台普通窗口的 Dock。
- Menu 使用 menu/menuitem、方向键/Home/End/Escape；Application Center 与 Dialog 限制 Tab 并返回焦点；Dock 提供 closed/focused/background/minimized 文本和 `aria-pressed`。
- 交通灯、三个 resize handle、skip link、route live announcer、forced-colors、reduced-motion 和 no-backdrop fallback 均由当前静态/行为测试固化。

## 2. P0 时点性能特征与目标差距

下表中“当前”是 characterization，不是应迁移的目标。

| 路径 | 当前真实实现 | P0 目标状态 |
| --- | --- | --- |
| Tasks 页大小 | `TASK_DISPLAY_LIMIT=1000`，单表最多 1000 行 | **RED**：目标 100 |
| Tasks poll | detail 与 tasks 并发；一次 `batchSnapshotReceived`，随后 imperative phase 更新再次 full render | **RED**：一次领域 commit、无第二次 render |
| Tasks 生命周期 | 终态、deactivate、destroy、最小化 scope 停止/挂起并 abort | characterization 通过；最小化后两个周期请求数 0 的单元证据通过 |
| drag/resize | 每次 pointermove 直接写 `left/top/width/height`；Store/storage 仅结束时提交一次 | **RED**：缺少 rAF 合并与 drag `translate3d` |
| Crawl | 有稳定 source/candidate key 和焦点 token，但列表仍 `replaceChildren()` | **RED**：目标 keyed 局部更新 |
| Review | deactivate/destroy 释放 listener、ResizeObserver、rAF/timer、img src、canvas、预加载与订阅 | 静态 characterization 通过；Svelte 20 次循环仍待目标单元测试 |
| 交互期玻璃 | 关闭 transition/shadow，但主 backdrop 仍保留 | **RED**：目标交互期关闭 backdrop 并使用低成本回退 |

P0 时点目标预算位于后来删除的 legacy fixture；P5 后的同一目标预算位于 `desktop/tests/fixtures/p0-performance-budget.json`，由 `desktop/tests/p0-budget.test.ts` 及对应 P3/P4 target suite 执行。

## 3. P0 时点非 headed 验证证据

以下命令均在 P0 时点从仓库根目录执行；legacy 路径已删除，不是当前验证命令。

| 命令 | 结果 |
| --- | --- |
| `node --test gallery-dl-backend/tests/webui_p0_current_contract.test.mjs` | PASS；7/7 |
| `python scripts/run-webui-coverage.py --node node --test-only` | PASS；exit 0；authoritative WebUI Node 列表（含 P0 current） |
| `node --test gallery-dl-backend/tests/webui_p0_target.target.mjs` | EXPECTED RED；exit 1；8 项中 3 pass / 5 fail |
| `cd gallery-dl-backend && ./.venv/bin/python -m unittest tests.test_app_routing_contract -v` | PASS；6/6；61 项 OpenAPI 合同 |
| `cd gallery-dl-backend && ./.venv/bin/python -m unittest discover -s tests -v` | PASS；567/567；49.769s |
| `.venv/bin/python -m unittest discover -s tests -v` | PASS；43/43；2.153s |
| `python -m compileall -q gallery-dl-backend/gdl_backend gallery-dl-backend/tests scripts tests` | PASS |
| `find gallery-dl-backend/gdl_backend/webui/js gallery-dl-backend/tests -type f \( -name '*.js' -o -name '*.mjs' \) -print0 \| xargs -0 -n1 node --check` | PASS |
| `.venv/bin/python -m pip wheel --no-deps --no-build-isolation --wheel-dir /tmp/imageweave-p0-wheel ./gallery-dl-backend` | PASS；wheel 561756 bytes；SHA-256 `b8b6dd49b829b7a8c14bfea389cc67ac86e7ec6aa24e607b3484d2f25cc0f9a2` |
| `git diff --check` | PASS |

Expected RED 的 5 个准确原因：

1. Tasks 当前上限为 1000，不是 100；
2. Tasks poll 后仍有 imperative phase full render；
3. drag/resize 没有 rAF，drag 没有 `translate3d`，pointermove 仍立即写 rect；
4. Crawl source/candidate 列表仍整体 `replaceChildren()`；
5. 直接操控期间没有关闭主 backdrop，也没有低成本背景回退。

常规测试没有包含 target suite，因此 expected RED 不会掩盖回归。

## 4. 明确未执行

以下项目均为 **未执行（按本次任务约束）**，没有数字、trace、截图或通过结论：

- 任何浏览器、Chromium、Playwright、Selenium 或浏览器截图测试；
- Chromium Performance trace；
- headed Tauri、WebView2、WebKitGTK 或 DevTools 实测；
- 连续 drag/resize 10 秒的 p95 帧间隔和 Long Task 数；
- Tasks 100 行在真实 WebView 中的 Long Task；
- Review/应用打开关闭 20 次的 headed 资源基线；
- 6 个可见窗口 + 2 个最小化窗口的 headed 合成层检查；
- Linux/Windows 桌面 smoke。

此外：

- 仓库尚无 `desktop/`、`package.json`、Tauri Cargo 工程，故 npm/Vite/Svelte/Tauri check/build 不适用；这是 P1 之后的门槛。
- coverage 基线要求固定 Node `v24.13.0`，当前仅有 `v26.7.0`；因此未用错误版本宣称 coverage gate 通过。`--test-only` 行为测试已通过。

## 5. P1 的准确前置条件

1. 先建立单一 `desktop/` Svelte 5 + TypeScript + Vite + Tauri 2 测试入口，不创建生产 `/ui-next/` 或第二套运行时实现。
2. 将 P0 current contract 作为移植输入；不得改变 10 应用元数据、61 项后端 API、storage key/sanitizer、Hash/窗口/键盘/焦点/a11y 语义。
3. P1 只建立 platform/API/runtime sanitizer 与测试基础设施；Tasks 100 行、窗口 rAF、Crawl keyed 更新和 Review Svelte 生命周期分别留给 P2–P4。
4. 随目标实现落地，把 `webui_p0_target.target.mjs` 的对应 probe 迁到 `desktop/`，每次只消除与该阶段相符的 RED；不得通过 skip、放宽预算或修改当前快照伪造通过。
5. headed 性能预算只能在真实 Tauri WebView 阶段补测；Chromium 结果只能作对照。
