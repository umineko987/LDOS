# 端到端测试

Playwright + Chromium。后端全部在浏览器里模拟，不需要启动 Python 服务。

```sh
npm run test:e2e                      # 两个项目都跑
npx playwright test --project dev     # 只跑开发服务器上的用例
npx playwright test e2e/gfx.spec.ts   # 单个文件
npm run test:e2e:ui                   # 交互式调试
```

Linux 上有 `/usr/bin/chromium` 时直接用它；别的路径用 `LDOS_CHROMIUM_PATH` 指定。

设了 `http_proxy` 的 shell 里，Playwright 等待 `localhost:1420` 的探测会走代理（代理回 502），
等满 60 秒报 `Timed out waiting ... from config.webServer`。代理不用关，把本地地址加进白名单：
`no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1 npm run test:e2e`。

## 两个项目

| 项目 | 匹配 | 服务 | CSP |
| --- | --- | --- | --- |
| `dev` | 除 `*.dist.spec.ts` 外的全部 | `npx vite dev`，`:1420` | `devCsp` 插件（`scripts/external-boot.ts`）给每个文档响应加上 `tauri.conf.json` 的 `devCsp` |
| `dist` | `*.dist.spec.ts` | `npm run build` 后 `scripts/serve-dist.mjs`，`:1421` | 生产 `csp`，和安装包里一致 |

本地会复用已经在跑的服务（`reuseExistingServer`），CI 上每次重新起。

## 自动生效的夹具（`fixtures/test.ts`）

从 `./fixtures/test` 导入 `test` 和 `expect`，不要直接用 `@playwright/test` 的；下面这些对每条用例都生效：

- **runtimeErrors**：出现 `pageerror`、`console.error` 或静态资源 4xx/5xx 时用例失败。接口的 4xx/5xx 不算（错误路径是要测的）。
  只有旧版冒烟测试用 `test.use({ allowConsoleErrors: true })` 关掉它。
- **cspViolations**：页面里任何 `securitypolicyviolation` 事件都会让用例失败。
- **backend**：默认用 `mockHealthyBackend()` 模拟一个健康的后端（`/healthz`、`/readyz`、`/api/v1/config`），启动门直接放行；
  再用 `mockQuietRealtime()` 给外壳一个空的任务快照和不发事件的 SSE 流。
  要测后端不可用的情况就 `test.use({ healthyBackend: false })`，或者在用例里用 `mockApi()` 覆盖单个接口。

运行环境固定为 `zh-CN`、`Asia/Shanghai`、深色、`reducedMotion: "reduce"`，视口 1280×800。

## 模拟接口（`fixtures/api.ts`）

```ts
await mockApi(page, "get", "/readyz", { ...READY, ready: false }); // 直接给正文：200
await mockApi(page, "get", "/api/v1/config", () => ({ status: 403, body: errorEnvelope("forbidden", "只允许本机访问") }));
```

- 第四个参数可以直接是 200 的正文，也可以是返回 `{ status, body, headers }` 的处理函数。
- 路径和方法按 `src/lib/api/schema.d.ts` 的 `paths` 类型化，写错会在 `npm run check`（`tsc -p e2e`）里报错；有响应模型的接口，正文类型也会被检查。
- `{id}` 这类路径参数匹配任意一段。后注册的路由优先，所以用例里的 `mockApi()` 会盖过默认的健康后端。
- `errorEnvelope(code, message)` 生成后端统一的错误正文；`HEALTHY`、`READY`、`DIAGNOSTICS_CONFIG` 是默认响应，可以展开后改字段。
- 处理函数拿到 `Request`，可以计数或检查请求体（见 `diagnostics.spec.ts` 的刷新用例）。

## 模拟实时任务（`fixtures/jobs.ts`）

外壳挂载后先拉 `/api/v1/jobs` 快照，再用它的 `last_event_id` 连 `/api/v1/events`（SSE）。

```ts
await mockJobs(page, [CRAWL_JOB], "e1-0");                       // 快照
const connections = await mockEvents(page, [                      // 第一次连接收到这些事件，之后重连拿到空流
  { event: "job.updated", id: "e1-1", data: { job: CRAWL_JOB } },
]);
```

- 模拟的流是有限的：发完就断开，客户端按退避（约 1s、2s、4s……）重连，并带上收到的最后一个事件 id。
  `mockEvents()` 返回每次连接的 URL，可以检查 `last_event_id`。用例中途再调一次 `mockEvents()`，下一次重连就拿到新的事件。
- `job()` 生成一条运行中的任务，按需覆盖字段；`CRAWL_BATCH`、`CRAWL_TASKS`、`DOWNLOAD_TASKS`、`TASK_LOGS` 等是批次页和任务页的样例响应。

## 模拟宿主和设备

页面脚本运行前用 `page.addInitScript()` 改环境：

- **MyGo 宿主**（`boot.spec.ts`）：给 `window.mygo` 设置 `call(method, ...args)`，按 `Host.BackendStatus`、`Host.RuntimeMetadata` 等完整 Go 方法名返回结果。
  页面实际执行 `mygo-runtime 0.9.1` 的 `isMyGo()` 与 CLI 生成的 Host 绑定；宿主状态放在 `window` 上，用例里用 `page.evaluate()` 改。
- **已就绪的桌面宿主**（`fixtures/exports.ts` 的 `fakeDesktopHost()`）：后端直接就绪，选目录返回给定路径，
  其余方法（例如 `Host.RevealInFileManager`）以 `{ command: method, args: [...] }` 记在 `window.__hostCalls`，用 `hostCalls(page)` 读。
- **GPU**（`gfx.spec.ts` 的 `stubGpu()`）：无头 Chromium 的 WebGL2 是 SwiftShader（软件实现）。
  改掉 `UNMASKED_RENDERER_WEBGL` 返回的设备名，模拟有硬件加速或只有 llvmpipe；或者让 `getContext("webgl2")` 返回 `null`，模拟没有 WebGL2。

## 写用例的约定

- 用例名用中文写清楚行为，一条用例测一条用户能感知的路径。
- 定位优先用角色和可见文字（`getByRole`、`getByText`），其次 `data-testid` 和组件暴露的 `data-*` 状态（`data-boot-phase`、`data-status`、`data-kind`）。
  不按 CSS 类名定位。
- 不用 `waitForTimeout`；等状态就用 `expect(...).toHave*` 或 `expect.poll()`。
- 键盘交互走真实按键（`page.keyboard.press("Control+k")`），这样按键注册表和 Esc 链也一起被测到。

## 黄金路径（真实后端）

`golden/pipeline.golden.ts` 在真实后端上走一遍 建数据集 → 导入文件夹 → 清洗 → 去重 → 打标 → 校对（标签工作室删标签）→ 导出，
最后用 Node 检查导出目录里的图片和 caption。它用单独的配置，`npm run test:e2e` 不会跑到它。

```sh
no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1 npm run test:e2e:golden
```

- `golden/setup.ts`（globalSetup）在系统临时目录里建数据目录、配置和 8 张生成的 PNG（含像素相同和缩小的近重复），
  在空闲端口上启动 `python -m gdl_backend --config …`（和桌面宿主开发模式同一个入口），结束时关掉后端、删掉临时目录。
  不碰 `~/.config` 和真实数据目录，不联网，不要 HF token。
- 页面按桌面模式连后端：用例模拟 MyGo 宿主，`Host.RuntimeMetadata` 返回真实后端的 `apiOrigin`，选目录按队列返回素材和导出目录。
- 模型是替身（`golden/fakes/`）：去重和打标跑真实的 worker / CLI 和后端流水线，只把推理换成按像素判断——
  完成度过滤按灰度 / 近白判黑白和草稿，WD 打标按底色给 `*_theme`。模型文件是占位，探测脚本直接报可用。
- 解释器默认用 `scripts/setup-linux.sh` 建的两个虚拟环境（`gallery-dl-backend/.venv`、`.venv`），
  可用 `LDOS_GOLDEN_BACKEND_PYTHON`、`LDOS_GOLDEN_TOOL_PYTHON` 指定；`LDOS_GOLDEN_KEEP=1` 保留临时目录（后端日志在 `backend.log`）。
- 去重的 Python 替身是 sh 脚本，只在 Linux / macOS 上能跑。

## CSP 检查

- `csp.spec.ts`：开发服务器的响应头等于 `devCsp`，页面里没有内联脚本。
- `csp.dist.spec.ts`：构建产物的响应头等于生产 `csp`，同样没有内联脚本。
- 其余每条用例都带着 `cspViolations` 夹具，所以新页面只要被测到，就同时检查了 CSP。

CSP 里不写 `http://[::1]:*`：CSP 的主机语法不接受 IPv6 字面量。后端监听 `::1` 时，桌面端给前端的源是
`http://localhost:{port}`（见 `src-tauri/src/backend.rs` 的 `api_origin`）。
