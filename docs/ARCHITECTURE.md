# ImageWeave 架构与开发约定

本文面向继续开发 ImageWeave 的维护者，记录当前代码边界、必须保持的行为约束，以及新增功能时的推荐落点。项目安装与使用方法见 [README.md](../README.md)。

本文描述的是当前架构约定，不是历史重构报告。新增功能可以扩展这些边界，但不应在没有迁移计划和契约测试的情况下绕过它们。

## 1. 核心原则

ImageWeave 当前采用以下总体风格：

> 单一状态所有者 + 纯逻辑内核 + 显式注入的 I/O 适配器 + 薄兼容 facade。

具体含义：

1. **一个状态只能有一个最终所有者。** 锁、事务、worker 集合、授权会话、代理租约和窗口栈不能由两个组件同时提交最终状态。
2. **先分离决策，再执行副作用。** 校验、归一化、排序、重试策略和状态转移优先实现为纯函数。
3. **I/O 必须可识别、可替换。** HTTP、SQLite、文件、子进程、浏览器和 DOM 操作放在 adapter、transport、repository 或 lifecycle collaborator 中，并通过构造参数或回调注入。
4. **公开入口保持薄而稳定。** 现有 facade 负责兼容导入和调用形状，不重新堆积实现。
5. **安全输出采用白名单。** API、诊断和日志只投影明确允许的字段，不依赖“事后尽量遮盖”原始对象。
6. **按职责拆分，不按行数机械拆分。** 只有出现独立状态、独立副作用边界或可单独测试的决策时才创建新模块。
7. **架构约束必须由可执行测试守护。** 文件名、注释和 RepoWise 分数不能替代契约测试、静态依赖图和覆盖率门槛。

## 2. 总体结构

```text
Browser
  └─ WebUI（静态 ES modules）
       └─ /api/v1、/healthz、/readyz
            └─ FastAPI api_routes
                 └─ ServiceContainer 中的公开 facade / manager
                      ├─ Database ─ repositories ─ SQLite
                      ├─ TaskScheduler ─ AttemptExecutor ─ gallery-dl
                      ├─ DiscoveryService ─ source adapters ─ shared transport
                      ├─ AuthManager ─ browser / Pixiv OAuth adapters
                      ├─ ProxyPoolAdapter ─ coordinator / runtime adapters
                      ├─ OrderedCrawlManager
                      └─ DedupReviewManager ─ 去重 worker
```

主要代码区域：

| 路径 | 职责 |
| --- | --- |
| `gallery-dl-backend/gdl_backend/app.py` | 组合根、服务生命周期、middleware、统一错误处理和 router 装配 |
| `gallery-dl-backend/gdl_backend/api_routes/` | HTTP 输入、业务调用和安全响应投影 |
| `gallery-dl-backend/gdl_backend/database.py` | SQLite 连接、读写边界、事务所有权和兼容 facade |
| `gallery-dl-backend/gdl_backend/_database_*.py` | 按领域拆分的 schema、repository 和行投影 |
| `gallery-dl-backend/gdl_backend/scheduler.py` | dispatch、claim、active worker 和最终任务状态 |
| `gallery-dl-backend/gdl_backend/_scheduler_*.py` | 纯调度决策、artifact 边界和单次 attempt 执行 |
| `gallery-dl-backend/gdl_backend/discovery.py` | 发现服务兼容 facade 和 adapter 装配 |
| `gallery-dl-backend/gdl_backend/discovery_adapters/` | Danbooru、E-Hentai、gallery-dl、Pawchive 来源适配 |
| `gallery-dl-backend/gdl_backend/discovery_transport.py` | 重试、代理租约、DNS/目标校验和共享 HTTP 会话 |
| `gallery-dl-backend/gdl_backend/discovery_transforms.py` | 无网络、无子进程的纯转换 |
| `gallery-dl-backend/gdl_backend/auth*.py` | 授权状态、公开投影、浏览器与 Pixiv OAuth 适配 |
| `gallery-dl-backend/gdl_backend/proxy*.py` | 代理 facade、状态协调、策略、投影和运行时适配 |
| `gallery-dl-backend/gdl_backend/webui/js/` | WebUI 元数据、状态、持久化、窗口、应用和视图 |
| `Proxy_pool/` | 可独立测试和安装的外部代理池边界 |
| 仓库根目录 `dedup_*.py` | 可独立运行的去重组件 |

依赖方向原则：

```text
api_routes ──> 公开 facade / contract
facade / coordinator ──> 纯 policy + 注入的 adapter
repository ──> Database 提供的 read / transaction 回调
纯模块 ──> 标准库、数据 contract；不得反向依赖 I/O 层
app.py ──> 所有实现（仅用于装配）
```

领域实现不应反向导入 `app.py` 或具体 route 模块。

## 3. 后端组合根与 API

### 3.1 `ServiceContainer` 与 `create_app()`

`ServiceContainer` 是进程内服务依赖和生命周期的装配点。`create_app()` 只应负责：

- 加载并校验配置；
- 创建或接收 `ServiceContainer`；
- FastAPI lifespan；
- 本机来源保护、request ID、CORS 和统一异常处理；
- WebUI 静态资源挂载；
- 跨服务回调装配；
- `include_router()`。

禁止把新的大型 endpoint、SQL、来源解析或调度状态机直接写回 `app.py`。

### 3.2 新增路由

新领域路由放在 `gdl_backend/api_routes/<domain>.py`，并导出 router factory：

```python
def create_example_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/v1/example")
    async def example(container: Any = Depends(get_service)):
        return await container.example.read()

    return router
```

要求：

- 服务依赖统一通过 `Depends(get_service)` 从 `request.app.state.container` 获取；
- 不创建模块级可变 service；
- 不让 endpoint 闭包捕获某个 container 实例；
- service-free 路由应有明确理由；
- 使用 `ApiError` 和既有统一错误 envelope；
- 对敏感输入的校验错误不得回显 Pydantic `input` 原文；
- 保持 HTTP 路径、状态码、operation ID 和响应字段白名单稳定；
- 修改公开契约时同步更新 OpenAPI/路由契约测试，而不是只改实现测试。

### 3.3 新业务逻辑的落点

| 问题 | 推荐实现 |
| --- | --- |
| 只做校验、归一化、过滤或状态决策？ | 纯函数模块 |
| 协调一次操作，但不拥有长期状态？ | 显式注入依赖的 collaborator/service |
| 拥有锁、会话、worker 或生命周期？ | 领域现有 owner，或经过论证的新 owner |
| 调用 HTTP、文件、子进程或浏览器？ | adapter/transport |
| 需要保持旧导入或测试 patch 点？ | 带说明的最薄 facade/late-bound seam |

兼容 seam 不是普通扩展点。删除或新增 seam 前，应先审计仓内调用、测试 patch、动态导入和仓外兼容说明。

## 4. 数据库与事务

`Database` 是 ImageWeave 主业务 SQLite 数据库（任务、批次、审核、策略和代理探测）的唯一事务所有者。该约束不包含由 `AuthManager` 管理的 gallery-dl Pixiv 授权缓存。

### 4.1 必须保持的所有权

对于主业务数据库，只有 `database.py` 可以：

- 创建 SQLite 写连接和线程 reader；
- 管理共享 `RLock`；
- 执行 `BEGIN IMMEDIATE`、`COMMIT` 和 `ROLLBACK`；
- 决定 reader 注册与关闭顺序；
- 关闭连接并修复数据库文件权限。

repository 必须接收 `read`、`transaction`、clock、UUID 或领域回调等显式依赖。repository 不得：

- 私自调用 `sqlite3.connect()`；
- 私自 `commit()` 或 `rollback()`；
- 创建嵌套事务；
- 绕过共享写锁；
- 在需要读取当前未提交写入时调用基于独立 reader 的公开方法。

WAL reader 只能看到已提交快照。事务内需要观察本次写入时，必须继续使用 `_transaction()` 提供的同一 `conn`。

### 4.2 Schema 与 repository

- schema 初始化和迁移放在 `_database_schema.py`；
- task、crawl、review、proxy probe、site policy 分别进入对应 repository；
- 行到公开字典的投影集中在 `_database_repository.py` 或领域纯投影中；
- `Database` 保留调用方兼容方法，并将实现委托给 repository；
- 多表、多步骤业务写入必须在一次数据库所有的事务中原子完成。

数据库功能至少应测试：

- `BEGIN IMMEDIATE` 失败后连接仍可使用；
- 中途异常完整回滚；
- `COMMIT` 失败后不会遗留卡住的事务；
- 并发 claim 只有一个成功者；
- reader 不持有写锁；
- 每线程 reader 和 `close()` 行为；
- 重复数据、触发器失败或第二步写失败不会留下半成品。

## 5. 调度与任务状态机

`TaskScheduler` 是以下状态的唯一所有者：

- dispatch loop；
- task claim；
- `_active` worker map；
- wake event；
- start/stop/cancel/retry；
- attempt 结果到最终 task 状态的提交。

`AttemptExecutor` 只负责单次 attempt 的执行协调。它可以使用注入的 Database、GalleryRunner、ProxyPool、TaskLogWriter、ArtifactCatalog、认证回调和 clock，但不得：

- claim task；
- 维护第二份 active worker map；
- 独立决定并提交最终 task 状态；
- 创建第二个 dispatch loop。

重试、代理失败策略、partial artifact 升级、artifact 过滤/统计和 task transition 优先放在 `_scheduler_decisions.py`、`_scheduler_artifacts.py` 等纯边界。

必须保持：

- `required` proxy 永不回退直连；
- `prefer` 只在现有允许条件下回退；
- partial artifact 重试受 `max_attempts` 限制；
- 手工 retry 重置 backoff anchor；
- cancel 和 shutdown 保持可恢复语义；
- lease acquire/release、attempt completion、日志 flush、artifact 统计和最终状态提交顺序稳定；
- clock 和 jitter 可注入，测试不依赖真实等待或随机结果。

## 6. 来源发现

`DiscoveryService` 是调用方兼容 facade；每个来源的协议差异进入独立 adapter。

### 6.1 纯转换

以下逻辑应放入 `discovery_transforms.py` 或更小的纯模块：

- 地址规范化；
- gallery-dl 输出解析；
- 候选排序和去重；
- alias 合并；
- weak evidence 与受控公开投影；
- 站点目录和参数规划。

纯转换模块不得执行网络、DNS、文件、子进程或代理池操作。

### 6.2 Adapter 与 transport

新增来源时：

1. 在 `discovery_adapters/` 创建来源 adapter；
2. 通过构造参数接收共享 `DiscoveryTransport`；
3. 来源只负责协议参数、响应解释和来源特有错误分类；
4. 重试、代理轮换、lease 复用、DNS、目标验证、认证失效通知和通用 HTTP 会话继续走 transport。

不得复制 `requests`/curl 调用模板，也不得绕过 `NetworkTargetValidator`、ProxyPool 或 Auth 回调。

必须保持：

- 候选顺序、alias 和 weak-evidence 语义；
- pagination/cursor、重试次数和 rate-limit 分类；
- 同一 attempt 的 DNS 验证和来源操作复用同一代理 lease；
- 安全代理模式获取不到 lease 时不静默直连；
- `_perform_search` 的跨来源规划、并发顺序和聚合语义。

## 7. 授权与代理

### 7.1 Auth

`AuthManager` 继续拥有：

- 授权会话和锁；
- metadata 与 credential vault；
- Pixiv SQLite cache 生命周期；
- cookie/profile 清理顺序；
- 对外授权状态。

浏览器/CDP 和 gallery-dl Pixiv OAuth 进程操作进入 `auth_adapters.py`；协议校验进入 `pixiv_oauth_protocol.py`；公开投影进入 `auth_projection.py`。

安全约束：

- Pixiv cache 继续使用受限反序列化，禁止 class/global load、persistent ID、尾随数据和超限值；
- OAuth callback 必须严格校验 scheme、host、path、state 和 code；
- cookie 写入必须保持原子性和私有权限；
- 先写凭证再更新 metadata，取消和清理顺序不得随意改变；
- API 不暴露 token、cookie、原始 CDP/worker 错误或本地敏感路径。

### 7.2 Proxy

`ProxyPoolAdapter` 是兼容入口，`ProxyPoolCoordinator` 拥有：

- pool 生命周期和锁；
- revision；
- probe cache；
- lease 状态；
- start/reload/stop/acquire/release 的状态协调。

策略与安全投影放在 `proxy_policy.py`；外部来源、探测和运行时对象由 instance-scoped adapter 注入。不得建立进程级全局 pool、全局 requests session 或第二份 lease registry。

`Proxy_pool/` 保持独立组件边界，不与后端 facade 合并。其依赖环境、测试和 coverage gate 必须能够独立运行。

## 8. WebUI

WebUI 使用后端直接提供的原生 ES modules，不需要单独前端构建流程。模块边界由 Node 行为测试和 Python 静态 import 图共同守护。

### 8.1 应用元数据与 registry

`core/app-definitions.js` 是以下信息的唯一来源：

- `id`、`label`、`icon`、`route`；
- `windowTitle`、`availability`、`defaultWindowState`；
- `DEFAULT_APP_ID` 和 `DEFAULT_ROUTE`。

`app-registry-factory.js` 只负责按 ID 将 controller 与元数据一对一合并。新增应用时必须：

- 添加唯一 ID 和 route；
- 使用完整元数据字段；
- 提供 `mount`、`activate`、`deactivate`、`unmount` lifecycle hooks；
- 根据需要添加 `beforeLeave` 或 `beforeWindowHide`；
- 更新 metadata/registry 一致性测试和静态资源 API 测试。

只需要元数据的模块不得导入 controller registry。

### 8.2 Store

`core/store.js` 保持兼容 re-export facade。实现分别位于：

- `store-data.js`：clone 与深不可变数据；
- `store-runtime.js`：dispatch、subscribe 和运行阶段保护；
- `store-contract.js`：action type 与错误 contract；
- `store-state.js`：初始状态、creator 和 selector；
- `store-*-transition.js`：纯状态转移；
- `store-factory.js`：装配。

新增状态行为时：

1. 在 contract 中定义稳定 action type；
2. 在 state 中增加 creator/selector；
3. 在对应纯 transition 中实现；
4. 通过 facade 保持调用方入口稳定；
5. 测试输入不变性、输出深不可变和 prototype-pollution guard。

reducer 不得访问 DOM、storage、网络或应用 controller。嵌套 dispatch、通知阶段 dispatch 和 subscriber 异常隔离语义必须保持。

### 8.3 Storage

`core/storage.js` 保持薄 facade。纯快照、布局和偏好投影与显式 persistence adapter 分开。

修改持久化时必须保持：

- `STORAGE_KEYS` 稳定，或提供显式迁移；
- snapshot 格式向后兼容；
- 损坏数据安全回退；
- 只通过领域现有 sanitizer 处理模型数据，不复制第二套清洗逻辑；
- storage I/O 不进入 reducer。

### 8.4 Window manager

窗口纯决策位于 `window-policy.js`，几何规则复用 `window-geometry.js`；交互、异步 hide 和 DOM lifecycle 分别位于独立 collaborator。

必须保持：

- store 中的窗口数组是 z-order 唯一事实来源；
- DOM `zIndex` 只是 render plan 的投影；
- pointermove 只做临时 DOM 反馈，不持续写 store；
- pointer interaction 结束时统一提交一次；
- mobile viewport 变化会取消不再有效的 interaction；
- async `beforeHide` 去重并阻止 stale completion；
- mount 失败会清理半创建 DOM；
- `destroy()` 幂等。

### 8.5 静态依赖约束

所有相对静态 import/re-export 使用完整 `.js` 路径。必须持续满足：

- 整个 `webui/js` 没有多文件强连通分量；
- `core/store.js` 的静态依赖闭包不包含 `apps/`；
- 该闭包不包含 `components/*-view.js`；
- store facade 可以加载而不依赖应用 controller 或视图文件。

不要通过字符串搜索伪造依赖测试；使用真实静态 specifier 解析和 Tarjan SCC 检查。

## 9. 安全投影、日志与诊断

token、cookie、密码、API key、代理凭据和代理订阅原文不得进入任何普通公开响应。API 只返回各端点契约明确允许的业务字段，不得把内部对象直接序列化后返回。

日志和诊断还不得包含：

- 完整代理 URI、节点配置或主机详情；
- 任务和第三方来源 URL；
- 浏览器 Profile、运行目录等本地敏感路径；
- 原始第三方响应；
- 未经过分类和投影的异常文本。

使用 `redaction.py` 中的受控投影：

- 对日志优先记录 `safe_exception_category()`；
- 只有明确需要的非敏感文本才使用有长度限制的 `redact_text()`；
- API/诊断结果从空字典构建白名单输出，不对原始对象做“删除几个字段后返回”；
- 敏感请求的验证错误只返回字段名、索引和受控 reason。

新增后台循环时至少记录：

- `state`；
- `consecutive_failures`；
- `last_error_category` / `last_error_at`；
- `last_success_at` / `last_recovery_at`；
- 重复 warning 的限频时间。

`CancelledError` 和正常 stop 不计为故障。瞬时或已恢复故障与 `unexpected_exit` 应分开；是否影响 readiness 必须由显式契约决定。

## 10. 兼容性边界

默认保持以下行为兼容：

- HTTP 路径、方法、状态码和错误 envelope；
- API 响应字段白名单；
- task 状态机和 attempt 顺序；
- SQLite 事务与 reader 可见性；
- WebUI action type、facade export、snapshot 和 storage key；
- 应用 lifecycle 与默认 route/window state；
- proxy required/prefer 语义；
- discovery 候选顺序、别名、重试和公开错误分类。

如果功能确实需要破坏兼容性，应在同一变更中提供：

1. 明确的迁移或版本策略；
2. 旧行为刻画测试；
3. 新行为契约测试；
4. API、snapshot、schema 或调用方迁移；
5. 发布说明，而不是静默改变 facade。

## 11. 新功能开发流程

推荐按以下顺序开发：

1. **确认状态所有者。** 写清谁拥有锁、事务、生命周期和最终提交。
2. **增加行为测试。** 对既有行为先写 characterization；新行为直接写目标 contract。
3. **提取纯决策。** 先实现校验、转换和 transition，并用小型单元测试覆盖边界。
4. **接入显式 adapter。** 注入 I/O、clock、UUID、jitter 和 callback，避免测试依赖真实环境。
5. **收束 facade。** 调用方只依赖稳定入口，内部模块不扩散为事实公共 API。
6. **运行领域测试。** 先运行受影响模块的测试，快速定位问题。
7. **运行全量门槛。** 覆盖后端、根去重、独立 Proxy_pool、WebUI 和服务 smoke。
8. **按可验证边界提交。** 测试、纯逻辑、adapter 和 facade 收束应形成可独立审查的提交；不要混入无关格式化。

测试默认不得访问公共网络、真实订阅、真实代理节点或本机私人数据。需要模型或二进制的测试应使用已提交的可重复 fixture 和固定哈希；需要真实环境的检查放入明确的独立门槛。

## 12. 依赖与锁文件

Python 直接依赖只在 `gallery-dl-backend/pyproject.toml` 维护。`requirements*.txt` 是生成结果，禁止手工编辑。

修改依赖后：

```bash
./scripts/lock-dependencies.sh --upgrade
```

普通变更和 CI 使用漂移检查：

```bash
./scripts/lock-dependencies.sh --check
```

`Proxy_pool` 使用独立虚拟环境和依赖门槛。不要因为后端环境中“刚好已安装”某个包而省略其独立依赖声明。

## 13. 测试与覆盖率门槛

覆盖率最低值记录在 [scripts/coverage-baselines.json](../scripts/coverage-baselines.json)。门槛按 covered/total 精确比例比较。

规则：

- 不得为了通过新功能而降低最低值；
- 不得无理由新增 production omit；
- source 边界变化必须显式更新测试和审查说明；
- skip 数量和原因必须可见；
- WebUI 行为和 coverage 使用固定 Node.js v24.13.0；
- Python 源码字符串断言不计入真实 JavaScript coverage。

在仓库根目录执行标准门槛：

```bash
./gallery-dl-backend/.venv/bin/python scripts/run-python-coverage.py \
  backend --output /tmp/imageweave-coverage/backend

./.venv/bin/python scripts/run-python-coverage.py \
  dedup --output /tmp/imageweave-coverage/dedup

./Proxy_pool/.venv/bin/python scripts/run-python-coverage.py \
  proxy --output /tmp/imageweave-coverage/proxy
```

准备固定版本 Node 后执行 WebUI 门槛：

```bash
NODE_24=/absolute/path/to/node-v24.13.0/bin/node
"$NODE_24" --version

./gallery-dl-backend/.venv/bin/python scripts/run-webui-coverage.py \
  --node "$NODE_24" \
  --output /tmp/imageweave-coverage/webui
```

静态依赖和服务 smoke：

```bash
cd gallery-dl-backend
./.venv/bin/python -m unittest tests.test_webui_modules -v
cd ..

bash scripts/smoke-linux-service.sh
./scripts/lock-dependencies.sh --check
git diff --check
```

修改 API、调度、数据库或安全边界时，还应运行完整后端测试：

```bash
cd gallery-dl-backend
./.venv/bin/python -m unittest discover -s tests -v
```

Windows 可移植性由 `.github/workflows/` 中的 Windows CPU 和 Proxy_pool matrix 守护；平台相关路径、shell 和临时文件处理不能只按本机 Linux 行为实现。

## 14. RepoWise 使用原则

RepoWise 是发现候选问题的辅助工具，不是缺陷计数器或自动删除器。

- 同一位置的重复结构 finding 不视为多个独立缺陷；
- `safe_to_delete` 不能批量执行；
- dead-code 删除前必须检查仓内引用、测试、动态属性访问、CLI、配置字符串、序列化、文档入口和仓外兼容；
- 总分变化不能替代测试、覆盖率、依赖方向和真实复现证据；
- 并行子任务不得更新 `.repowise`；由主任务在线性提交和全部门槛验收后统一重建或更新索引；
- `.repowise/` 是本地工具数据，不提交到 Git。

## 15. Code Review 检查表

### 所有权与依赖

- [ ] 每份可变状态是否只有一个最终所有者？
- [ ] 是否出现第二个事务、worker、lease 或窗口栈 owner？
- [ ] 纯逻辑是否与 I/O 分离？
- [ ] 外部依赖、clock、UUID 和随机性是否显式注入？
- [ ] 是否复用了现有 transport、validator、repository 和 sanitizer？
- [ ] 是否出现领域实现反向依赖 `app.py`、route 或 WebUI view？

### 兼容与安全

- [ ] HTTP、状态码、错误 envelope 和响应白名单是否保持？
- [ ] task、SQLite、snapshot 和 lifecycle 语义是否保持？
- [ ] 是否可能泄露凭据、代理 URI、URL、路径或原始异常？
- [ ] 新公开字段是否采用白名单投影？
- [ ] 保留或新增兼容 seam 是否有明确调用证据和注释？

### WebUI

- [ ] 应用元数据是否仍只有一个来源？
- [ ] reducer 是否纯净且不接触 DOM/storage/network？
- [ ] 是否复用已有模型 sanitizer 和窗口几何规则？
- [ ] import graph 是否仍为 0 个多文件 SCC？
- [ ] store closure 是否仍排除 `apps/` 和 `components/*-view.js`？

### 验证与交付

- [ ] 是否先增加了目标行为或 characterization 测试？
- [ ] 领域测试、全量测试和 branch coverage 是否通过？
- [ ] 是否避免降低 coverage floor 或新增无依据 omit？
- [ ] 依赖锁、服务 smoke 和 `git diff --check` 是否通过？
- [ ] 提交是否按可独立验证的边界组织，且未混入无关修改？
