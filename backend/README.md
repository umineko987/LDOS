# Go 业务后端

LDOS 的业务逻辑、SQLite 存储、调度、HTTP/SSE 和进程管理已迁入 Go，桌面默认启动原生 `ldos-backend`。Svelte 界面和既有接口、数据格式保留。Python 只作为 gallery-dl、去重/Atlas 和 tagger 的独立执行器，不再承载 HTTP 服务或业务管理器。当前平台为 Linux x86_64。

## 模块与运行边界

| 业务 | 原生实现 |
| --- | --- |
| 配置、来源校验、HTTP 错误、诊断、OpenAPI | `internal/config`、`httpapi`、`diagnostics` |
| SQLite v19、FTS5、历史升级、共享单写入器 | `internal/store` |
| 活动、日志、SSE、任务、取消与重试 | `internal/activity`、`tasks`、`scheduler` |
| 下载设置、站点策略、托管凭据 | `internal/downloads`、`policy`、`credentials` |
| 代理来源、解析、租约、探活、冷却、Mihomo、认证转发与加密 DNS | `internal/proxy*`、`network` |
| 站点发现、别名与证据、搜索、账号补全、顺序抓取 | `internal/discovery*`、`search`、`crawls` |
| 浏览器/CDP 登录、Pixiv OAuth、授权保险库 | `internal/authorization`、`authbrowser`、`pixivauth` |
| 图库扫描、检索、图片/TXT、缩略图、文件操作、回收与恢复 | `internal/gallerycatalog` |
| 抓取/图库审核、过滤器、预设、决定及可恢复文件应用 | `internal/reviews` |
| 数据集、成员、阶段、打标、caption、撤销、续传导出 | `internal/datasets`、`datasetstages`、`captions` |
| 模型安装与状态、推理进程、Atlas | `internal/modelservice`、`atlas` |
| gallery-dl 执行器及其进程管理 | `internal/gallery`、`executors/ldos_gallery` |

`cmd/ldos-backend` 装配全部模块。抓取完成后登记图库并挂入数据集；审核、图库和导出共享安全文件入口与来源锁。取消等待执行器退出，随后才关闭数据库。数据集阶段的完成回调、caption 缓存代次及模型环境更新均接入同一生命周期。

代理节点保留旧 PyYAML ID 契约；同一 owner 只获得一个租约。搜索与发现使用 `prefer` 时，有可用节点就使用代理，没有节点则直连；`required` 不回退直连。请求只检查 URL 格式，不执行额外的 DNS 预检。搜索保持来源顺序、别名扩搜和响应预算；显式凭据仍受允许目录限制。

授权保留 legacy/vault 响应、共享浏览器互斥与取消。X/EH 通过 Chromium CDP 导出 Cookie；Pixiv 的 PKCE 和授权码交换由 Go 完成，缓存可由 gallery-dl 读取。取消后的迟到结果不会写回凭据；重置浏览器资料保留已导出的凭据。授权代理独立于任务代理池，返回值隐藏密码与 Token。

`gallery.migrate_default_auth` 默认开启，只尝试导入默认 gallery-dl 缓存中的 Pixiv 数据，不覆盖有效托管 Token；损坏的可选缓存不会阻止启动。隔离测试设置为 `false`。

## 旧数据与配置

沿用 `gallery-dl-backend/config.json` 和其中指定的 runtime、SQLite 与图库目录，无需把用户数据搬到 `backend/`。配置路径以配置文件为基准解析。升级前停止旧 Python 服务，不要让两个服务同时访问同一 runtime。

旧 schema 的升级在事务中完成。早期站点策略原文保存在 `meta` 的 `legacy_site_policy:*`；旧图库审核数据原样保留并标记为历史快照，重新分析前不能直接操作文件。详情见 [存储契约](internal/store/README.md)。

`gallery.python_executable` 显式配置优先；未指定时选择 `PYTHON`、项目目录中的 `.venv/bin/python`，最后使用 PATH 中的 `python3`。打包模式通过受控资源路径重定位执行器、模型与用户数据。原 Python 业务源码保留作兼容性对照，不作为启动后备，也不进入发布包。

## 构建与运行

需要 Go 1.26+；桌面工程使用其 `go.mod` 指定的工具链。从仓库根目录执行：

```sh
cd backend
go build -trimpath -o build/ldos-backend ./cmd/ldos-backend
./build/ldos-backend --config ../gallery-dl-backend/config.json --executors-dir ./executors
```

也可运行 `./scripts/setup-linux.sh --device cpu` 准备原生后端和独立执行器，再用 `./scripts/run.sh` 启动。`./scripts/doctor.sh --json` 调用 Go 诊断。

全部业务默认启用，不需要 `--allow-incomplete` 或 `--enable-tasks`；这两个旧参数仅兼容解析。`/healthz` 表示进程可响应，`/readyz` 根据数据库、调度器、执行器、代理与配置启用的模型报告实际就绪状态。原生 `/openapi.json`、`/docs` 和 `/redoc` 可用于检查接口。

执行器依赖锁为 `desktop/release/requirements-executors.txt`；模型环境继续使用 `requirements-dedup-*.txt`。详见 [执行器说明](executors/README.md) 与 [桌面构建和发布](../README.md#构建与运行)。

## 验证

```sh
cd backend
go test -race -timeout 5m ./...
go vet ./...
go build ./cmd/ldos-backend
```

测试使用临时数据库、假执行器/CDP 和本地 HTTP/TLS 服务，不启动浏览器或窗口，不读取用户 runtime。集成回归覆盖全部 124 个既有 OpenAPI 路径的挂载、抓取→图库→数据集、审核回收/恢复与重扫、205 张图片的阶段审核、caption 撤销恢复 BOM、代理执行、任务取消和父管道退出。`scripts/smoke-linux-service.sh` 额外启动实际 Go 二进制检查健康与模型就绪状态。

测试通过不代替真实站点登录、真实模型效果或桌面 GUI 人工验收；这些验证不在无窗口回归中执行。
