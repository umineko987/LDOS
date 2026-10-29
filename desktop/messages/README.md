# 界面文案

新前端（`src/`）的文案由 [Paraglide JS](https://paraglidejs.com) 编译。旧版工作台（`legacy-src/`）仍用自己的 i18n，不读这里。

- `zh-CN.json` 是基准语言，也是默认界面语言；`en.json` 是英文。
- 项目配置在 `../project.inlang/`：`settings.json` 列出语言和插件，`paraglide.config.ts` 是编译选项（localStorage 键 `ldos.locale`，没有存过就用 zh-CN）。
- 编译产物在 `src/lib/paraglide/`，不进 git。`npm run dev`、`npm run build` 由 Vite 插件编译；`npm run check`、`npm test` 先跑 `npm run i18n`。

## 键名

`<area>_<name>`，全部小写 snake_case，例如 `nav_library`、`diag_backend_ready`。

| area | 用在哪里 |
| --- | --- |
| `api` | API 错误说明（`#lib/api/messages.ts`） |
| `app` | 应用名、标语 |
| `boot` | 启动门（等待后端、失败、重试） |
| `common` | 跨页面的通用词（重试、关闭、复制） |
| `diag` | 设置 › 诊断 |
| `gfx` | `/dev/gfx` 渲染基准 |
| `keys` | 按键注册表里的命令标签和分组 |
| `locale` | 语言切换 |
| `nav` | 侧栏导航和面包屑 |
| `page` | 各路由的标题和占位说明 |
| `palette` | Ctrl+K 命令面板 |
| `shell` | 外壳：活动抽屉、快捷键表、Toast |
| `stage` | 数据集阶段名（采集、清洗……） |

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
