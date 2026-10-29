# 界面文案

新前端（`src/`）的文案由 [Paraglide JS](https://paraglidejs.com) 编译。旧版工作台（`legacy-src/`）仍用自己的 i18n，不读这里。

- `zh-CN.json` 是基准语言，也是默认界面语言；`en.json` 是英文。
- 项目配置在 `../project.inlang/`：`settings.json` 列出语言和插件，`paraglide.config.ts` 是编译选项（localStorage 键 `ldos.locale`，没有存过就用 zh-CN）。
- 编译产物在 `src/lib/paraglide/`，不进 git。`npm run dev`、`npm run build` 由 Vite 插件编译；`npm run check`、`npm test` 先跑 `npm run i18n`。

## 键名

`<area>_<name>`，全部小写 snake_case，例如 `nav_library`、`diag_backend_ready`。

| area | 用在哪里 |
| --- | --- |
| `activity` | Ctrl+J 活动抽屉、侧栏的进行中角标、任务结束的 Toast |
| `api` | API 错误说明（`#lib/api/messages.ts`） |
| `app` | 应用名、标语 |
| `atlas` | 数据集 › 图谱（语义地图） |
| `boot` | 启动门（等待后端、失败、重试） |
| `captions` | 打标页和标签工作室共用的 caption 文案：标签类别、改动对比、写入后的撤销 |
| `clean` | 数据集 › 清洗：预设、筛选、参考图、标记卡组 |
| `collect` | 数据集 › 采集：来源、哈希、在线采集、成员网格 |
| `common` | 跨页面的通用词（重试、关闭、复制） |
| `crawl` | 采集批次详情页（`/jobs/crawls/[batchId]`）和下载任务日志面板 |
| `dataset` | 数据集外壳：标题栏、阶段轨道、新建/编辑/删除对话框 |
| `dedup` | 数据集 › 去重：对比卡组、自动处理的组 |
| `diag` | 设置 › 诊断 |
| `downloads` | 设置 › 模型 › 下载（HF 镜像、下载代理、HF token） |
| `export` | 数据集 › 导出：选项、计划预览、进度、历史 |
| `gfx` | `/dev/gfx` 渲染基准 |
| `grid` | 共享虚拟网格的按键说明 |
| `home` | 首页数据集列表 |
| `jobs` | 任务页（`/jobs`），以及各处共用的任务类型、状态文案 |
| `keys` | 按键注册表里的命令标签和分组 |
| `library` | 图库：来源列表、扫描、浏览、搜索、改名、TXT 标注、回收区、加入数据集 |
| `locale` | 语言切换 |
| `models` | 设置 › 模型，以及阶段页共用的模型安装组件（`#lib/components/model-install`） |
| `nav` | 侧栏导航和面包屑 |
| `network` | 设置 › 网络（代理池、站点账号、站点策略） |
| `page` | 各路由的标题和占位说明 |
| `palette` | Ctrl+K 命令面板 |
| `prefs` | 设置 › 偏好（语言、减少动效、密度、地图渲染器） |
| `settings` | 设置各页共用的词（取消、确认） |
| `shell` | 外壳：侧栏按钮、快捷键表 |
| `stage` | 数据集阶段名（采集、清洗……） |
| `tag` | 数据集 › 打标：模型、阈值、实时预览、写入 caption |
| `triage` | 清洗和去重共用的键盘分诊：卡组、分组条、撤销、运行状态 |
| `viewer` | 共享图片查看器 |

新增一个区域时在上表补一行。

## 规则

`scripts/messages.test.ts` 在 `npm test` 里检查：

1. 键名符合上面的格式；
2. 每个文件里的键按字母序（码位序）排列；
3. 各语言的键集合与 zh-CN 完全一致，且没有空文案；
4. 带参数的文案（`{count}`）在各语言里占位符相同。

在代码里这样用：

```svelte
<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
</script>

<h1>{m.app_name()}</h1>
<p>{m.api_error_http_status({ status: 502 })}</p>
```

切换语言用 `#lib/i18n/locale.svelte.ts` 的 `i18n.set(locale)`，不要直接调 Paraglide 的 `setLocale`：前者不刷新页面，并让根布局重新渲染。
