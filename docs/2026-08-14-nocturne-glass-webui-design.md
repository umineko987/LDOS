# ImageWeave 夜航玻璃 WebUI 设计方案

- 日期：2026-08-14
- 状态：用户决策已确认，待实施
- 适用范围：`gallery-dl-backend/gdl_backend/webui/` 及其 WebUI 测试
- 风格名称：Glassmorphism（玻璃拟态）
- 风格来源：`/styles/glassmorphism`
- 现有架构基线：[ARCHITECTURE.md](ARCHITECTURE.md)
- 上一轮壳层重构记录：`2026-08-12-glass-desktop-webui-refactor-plan.md`

## 1. 目标

把当前偏浅色、偏实心的玻璃桌面重绘为统一的“夜航玻璃”界面，同时完整保留 ImageWeave 已有的模拟操作系统结构、业务能力、安全边界和窗口生命周期。

目标界面应具备以下可识别特征：

- 接近黑色的深墨夜景；
- 每个内置背景都有 2–3 个大半径柔和光井，不出现纯色平面桌面；
- 玻璃本身无色，只使用低透明白色表面；
- 40px/60px 高斯模糊与 180% 饱和增强；
- 顶部受光、底部背光、外层深阴影组成的方向性玻璃光学；
- 2%–3% 的全局颗粒噪点；
- 香槟金 `#E4B863` 作为唯一装饰性强调色；
- 所有普通动效使用 500ms spring easing；
- 所有业务内容都使用低透明玻璃或低透明玻璃行，不保留实色内容主题；
- 菜单栏、交通灯窗口、应用中心和 Dock 继续构成完整桌面操作系统体验。

这不是新的前端架构，也不是把仓库迁移到 Tailwind。正式实现继续使用当前无 Node/npm 构建步骤的原生 ES Modules 与静态 CSS。

## 2. 已拍板决策

| 事项 | 决策 |
| --- | --- |
| 全局视觉 | 夜航玻璃是唯一正式视觉，不保留浅色主题。 |
| 界面配色 | 不允许用户自定义界面强调色或窗口底色。 |
| 强调色 | 固定使用香槟金 `#E4B863`；高亮文字可使用 `#F3DCA8`。 |
| 壁纸 | 删除本地图片壁纸导入、预览、保存、遮罩、定位、适应和平铺功能。 |
| 内置背景 | 保留安全的内置背景 ID，但全部改为带光井的深色夜景，不再提供纯色平面背景。 |
| 内容表面 | 所有内容都先采用低透明玻璃方案；正常透明度不超过 12%，hover 上限为 15%。 |
| 状态颜色 | 成功、运行、警告、错误、禁用和交通灯可继续使用语义色，但只能用于图标、文字、细边框或小型标记，并必须配有非颜色说明。 |
| OS 结构 | 保留顶部菜单栏、空桌面、多窗口、交通灯、应用中心、Dock、拖拽、resize、最大化、最小化和关闭。 |
| 响应式范围 | 继续只支持桌面工作流；不增加手机和平板布局。低于 `1180 × 720` CSS 像素时继续显示环境阻断提示。 |
| 前端技术 | 保持原生 ES Modules 与静态 CSS，不引入 Tailwind、框架、打包器、字体服务或新运行时依赖。 |
| 后端范围 | 不修改业务 API、数据库、任务状态机、抓取、代理、授权或去重语义；只允许更新 WebUI 静态资源打包清单、同源提供契约、Python 静态测试和 wheel 验收。 |
| 预览应用 | Gallery、Schedule、Export 继续保持前端预览与 0 个所属业务 API 的正式运行边界。 |
| 无障碍 | 保留键盘路径、焦点恢复、forced-colors、backdrop 不支持回退和 reduced-motion。 |

当前没有待用户拍板项。若实施中出现会改变上述决策或现有业务契约的新问题，应先更新本设计并重新确认，不得自行扩大范围。

## 3. 规则优先级与项目例外

风格参考内部存在少量通用规则与组件必需规则之间的冲突。本项目采用以下优先级：

1. 本文“已拍板决策”；
2. 风格参考的绝对禁止项；
3. 风格参考的组件必需项；
4. 风格参考的一般交互和模板建议；
5. 创意延展。

据此确定：

- 普通业务按钮采用必需规则中的轻微 hover 上移；卡片、窗口和 Dock 不做 hover 缩放；
- Glassmorphism 在本项目中就是唯一默认视觉，风格参考中“不要把玻璃态当默认风格”的通用检查项不适用于本项目；
- 窗口拖拽和 resize 属于直接操控，交互期间必须关闭过渡，不能为了 500ms 动效产生输入延迟；
- forced-colors、backdrop 不支持和高对比度回退可以使用系统实色，这是无障碍/能力回退，不属于正常主题；
- 交通灯、圆形状态点、复选框、单选框和进度指示属于语义或系统控件，不强制使用普通卡片圆角；
- 最大化窗口继续贴合现有 window layer 工作区；边界处的几何直角属于最大化状态，不引入通用方角卡片样式；
- 菜单栏、Dock 图标、交通灯和 resize handle 仍是专用 OS 控件，不机械套用普通业务按钮的完整阴影尺寸，但必须遵守无色玻璃、交互反馈、500ms 非直接操控过渡和可见焦点原则。

## 4. 当前实现基线

正式 WebUI 当前已经完成上一轮玻璃桌面重构，具备：

1. 壁纸层；
2. 顶部菜单栏；
3. 中央窗口层；
4. 应用中心层；
5. 底部 Dock。

当前生产入口和核心文件包括：

- `webui/index.html`：五层壳层、窗口模板、交通灯、应用中心宿主和 Dock；
- `webui/js/core/desktop.js`：壳层组合与生命周期协调；
- `webui/js/core/window-manager.js` 及协作者：窗口几何、焦点、拖拽、resize 和隐藏生命周期；
- `webui/js/core/app-definitions.js`：11 个应用的唯一元数据来源；
- `webui/js/core/store*.js`：业务状态与窗口栈的唯一所有者；
- `webui/styles/tokens.css`：当前主题、表面、阴影、圆角和动效变量；
- `webui/styles/desktop.css`：壁纸、窗口、菜单栏、应用中心和 Dock；
- `webui/styles/apps/*.css`：11 个应用的专用布局。

当前视觉与目标的主要差异：

- 默认界面由浅色表面和深色文字组成；
- 内容表面透明度为 92%–100%；
- backdrop blur 为 18px/24px，饱和度为 118%/124%；
- 普通过渡主要为 120ms/180ms ease-out；
- 默认壁纸是纯色；
- 个性化允许任意强调色、窗口底色和本地图片壁纸；
- 多个应用仍存在视觉上的卡片嵌套、单侧 inset 状态条和 tiny uppercase kicker。

本轮只迁移视觉系统与个性化范围，不重写上述状态和生命周期架构。

### 4.1 前后端影响判断

这次变更在仓库分工上同时涉及“前端”和“后端工程”，但必须区分三种含义：

| 范围 | 是否修改 | 说明 |
| --- | --- | --- |
| WebUI 生产代码 | 是，主要工作 | HTML、CSS、原生 ES Modules、Personalization 状态与浏览器偏好迁移。 |
| 后端业务运行时 | 否 | 不修改 FastAPI 业务路由、ServiceContainer、数据库、调度器、抓取、代理、授权或 Review 服务。 |
| 后端静态交付/打包 | 是，少量 | `pyproject.toml` 需要把 `webui/assets/*.svg` 纳入 wheel；Python 测试需要验证 SVG、删除后的 JS 资源和新版 DOM/CSS 契约。 |
| FastAPI 静态挂载 | 原则上不改 | `app.py` 已用 `StaticFiles(..., html=True)` 递归提供整个 `webui/`，新增 SVG 应自动同源提供；只有实测证明 MIME 或路径不正确时才允许最小修正。 |
| 后端业务测试 | 只运行，不因视觉改造改语义 | 最终仍执行 backend coverage 和 service smoke，确认没有回归。 |

因此，实施时不要把它拆成“先做一套后端主题接口、再做前端”。不存在主题 API、壁纸 API 或服务端主题状态。所谓后端改动仅是静态资源进入 wheel、随后端同源提供，以及对应 Python 契约更新。

## 5. 核心视觉原则

### 5.1 玻璃无色

所有正常玻璃表面只能从以下中性范围取值：

```css
rgb(255 255 255 / 0.04)
rgb(255 255 255 / 0.05)
rgb(255 255 255 / 0.06)
rgb(255 255 255 / 0.08)
rgb(255 255 255 / 0.10)
rgb(255 255 255 / 0.12)
```

hover 表面最高可到：

```css
rgb(255 255 255 / 0.15)
```

禁止使用带蓝、绿、金、红或其他色相的玻璃填充。颜色只能来自：

- 桌面背景光井；
- 香槟金动作/焦点；
- 小面积语义状态；
- 交通灯。

### 5.2 光有方向

所有主要玻璃容器至少包含：

- 顶边白色 inset 高光；
- 底边深墨 inset 暗缘；
- 外部深色投影；
- 细白色透明边框。

普通内部行不重复添加完整大阴影，以免形成层层漂浮的嵌套卡片。

### 5.3 所有内容低透明

正常模式不再存在 92%–100% 的业务内容表面。具体解释如下：

- 每个应用窗口是一个主要 60px backdrop 合成层；
- 窗口内部所有可见列、面板、表格、表单、事实区和图片舞台使用 4%–12% 的白色透明表面；
- 内部元素可以继承外层窗口已经完成的背景模糊，不要求每一行再次创建 backdrop 合成层；
- 独立于窗口的菜单、Dialog、Quick Look、应用中心和 Dock 可以拥有自己的 40px/60px backdrop；
- 图片、Canvas 和原生媒体内容本身不改变像素透明度，但其承载舞台必须是低透明中性玻璃。

“全部低透明玻璃”不等于“每个 DOM 节点都独立 backdrop-filter”。实现必须同时控制 GPU 合成层数量。

### 5.4 唯一装饰强调色

固定颜色：

```text
主强调：#E4B863
高亮文字：#F3DCA8
焦点光环：rgba(228, 184, 99, 0.15–0.20)
```

香槟金用于：

- 页面内最主要动作；
- 当前焦点；
- 选中项的非颜色辅助标记；
- 关键数字或高亮事实；
- 少量高光点。

不得用于：

- 大面积背景；
- 整张卡片填充；
- 所有标题；
- 普通正文；
- 每个按钮；
- 渐变文字。

### 5.5 颗粒

桌面使用一个固定、不可交互的全视口噪点层：

- 使用仓库内的本地 SVG `feTurbulence` 资源；
- 推荐不透明度 2.5%；
- `pointer-events: none`；
- 不读取远程资源；
- 不使用内联 data URI；
- forced-colors 下移除；
- 噪点只建立一次，不在每个窗口重复叠加。

建议新增静态资源：

```text
webui/assets/noise.svg
```

该资源是纯装饰静态文件，不引入依赖或新的运行时架构。

## 6. 精确视觉 Token

正式代码继续使用 CSS 自定义属性。下列命名是设计意图，实施时可在不制造重复事实源的前提下与现有 `--imageweave-*` token 合并。

### 6.1 背景与文字

| 角色 | 值 |
| --- | --- |
| 夜景最深底色 | `#060A13` |
| 默认深墨底色 | `#0B1322` |
| 暖夜底色 | `#120D0A` |
| 深林底色 | `#081210` |
| 正文主色 | `rgb(255 255 255 / 1)` |
| 正文辅色 | `rgb(255 255 255 / 0.80)` |
| 正文弱化色 | `rgb(255 255 255 / 0.50)` |
| 代码/事实值 | `rgb(255 255 255 / 0.85)` |
| 香槟金 | `#E4B863` |
| 香槟高亮文字 | `#F3DCA8` |

正文默认使用 80% 白色，50% 白色只用于非关键元数据、禁用说明或重复辅助信息。关键错误、操作原因、表单帮助和状态说明不得使用弱化色。

### 6.2 玻璃表面

| 角色 | 表面 | 模糊 | 饱和度 |
| --- | --- | ---: | ---: |
| 内部弱行 | `rgb(255 255 255 / 0.04)` | 继承外层 | 继承外层 |
| 次级内容 | `rgb(255 255 255 / 0.05)` | 继承外层 | 继承外层 |
| 输入框 | `rgb(255 255 255 / 0.06)` | 40px | 180% |
| 默认窗口/卡片 | `rgb(255 255 255 / 0.08)` | 60px | 180% |
| 普通按钮 | `rgb(255 255 255 / 0.10)` | 40px | 180% |
| 强环境玻璃 | `rgb(255 255 255 / 0.12)` | 60px | 180% |
| hover 上限 | `rgb(255 255 255 / 0.15)` | 保持原值 | 180% |

### 6.3 边框

```text
弱分隔：rgb(255 255 255 / 0.10)
默认边框：rgb(255 255 255 / 0.15)
按钮边框：rgb(255 255 255 / 0.20)
hover/focus 边框：rgb(255 255 255 / 0.35)
```

所有正常玻璃边框宽度为 1px。危险状态可以使用 2px 完整边框，但禁止单侧粗边框装饰。

### 6.4 圆角

```text
窗口/大卡片：24px
普通卡片：24px
按钮/输入框：16px
紧凑行：16px
胶囊/状态点：999px 或 50%
```

不再使用 7px、9px、10px、12px、13px 等偏传统组件库的小圆角。图片缩略图可以使用 16px；全屏最大化边界和专用 resize handle 按功能例外处理。

### 6.5 阴影

普通卡片：

```css
0 16px 40px rgb(3 7 18 / 0.50),
inset 0 1px 0 rgb(255 255 255 / 0.22),
inset 0 -1px 0 rgb(2 6 16 / 0.35)
```

窗口/大浮层：

```css
0 16px 48px rgb(3 7 18 / 0.55),
0 0 0 1px rgb(255 255 255 / 0.08),
inset 0 1px 0 rgb(255 255 255 / 0.25),
inset 0 -1px 0 rgb(2 6 16 / 0.35)
```

按钮：

```css
0 4px 16px rgb(3 7 18 / 0.45),
inset 0 1px 0 rgb(255 255 255 / 0.25),
inset 0 -1px 0 rgb(2 6 16 / 0.30)
```

### 6.6 动效

```text
默认持续时间：500ms
默认缓动：cubic-bezier(0.16, 1, 0.3, 1)
按下：scale(0.97)
普通按钮 hover：translateY(-2px)
卡片 hover：不位移、不缩放
Dock hover：不放大，只改变表面、边框与光泽
```

以下情况不使用 500ms 过渡：

- 正在拖拽窗口；
- 正在 resize；
- 滚动跟随；
- Canvas 镜片逐帧绘制；
- `data-motion="off"`；
- `prefers-reduced-motion: reduce`；
- forced-colors。

禁止 bounce、elastic 和快速 100ms/150ms 视觉过渡。

## 7. 背景场景

### 7.1 默认夜航场景

默认桌面：

```css
background:
  radial-gradient(
    640px circle at 85% 10%,
    rgb(124 156 196 / 0.25),
    transparent 60%
  ),
  radial-gradient(
    560px circle at 10% 90%,
    rgb(51 81 122 / 0.30),
    transparent 60%
  ),
  radial-gradient(
    420px circle at 58% 48%,
    rgb(228 184 99 / 0.10),
    transparent 64%
  ),
  #0B1322;
```

禁止蓝紫粉连续渐变、渐变文字和高饱和霓虹光斑。

### 7.2 内置场景迁移

为减少 storage 迁移风险，保留当前六个内部 ID，但全部改为深色、有光源的夜景。UI 标签可以同步更新：

| 现有 ID | 新标签 | 基底 | 光井方向 |
| --- | --- | --- | --- |
| `graphite` | 夜航石墨 | `#080D15` | 月光蓝右上、深蓝左下、微金中央 |
| `slate` | 月岩 | `#0B1322` | 冷灰蓝右上、墨蓝左下 |
| `deep-ocean` | 深海 | `#07111B` | 海蓝右上、深青左下、微金远光 |
| `forest` | 深林 | `#081210` | 柔绿右上、墨绿左下、微金中央 |
| `plum-gray` | 雾褐 | `#100C0B` | 暖灰右上、深褐左下；不使用紫粉组合 |
| `warm-paper` | 暖夜 | `#120D0A` | 琥珀右上、深棕左下、克制月光 |

所有预设必须满足：

- 至少两个光井；
- 玻璃可从背景取得可见但克制的颜色；
- 不允许变成纯色平面；
- 不允许紫粉 AI 渐变；
- 正文所在区域保持稳定深色，不让高亮光斑破坏对比度。

## 8. 字体与排版

不引入远程字体或新的字体依赖。

### 8.1 字体栈

标题使用现有平台可用的中文衬线回退：

```css
"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif
```

正文继续使用当前本地系统 UI 字体栈，但不得显式加入 Inter、Roboto 或 Geist。代码、ID、批次号和事实值继续使用现有等宽字体栈。

### 8.2 层级

| 层级 | 建议尺寸 |
| --- | --- |
| 应用 H1 | `clamp(1.8rem, 3vw, 3rem)` |
| 区域 H2 | `1.5rem–1.875rem` |
| 小节 H3 | `1.125rem–1.375rem` |
| 正文 | `0.875rem–1rem` |
| 辅助文字 | `0.75rem–0.8125rem` |
| 窗口标题 | `0.8125rem–0.875rem` |

要求：

- 标题为 semibold 白色，不使用渐变文字；
- 正文默认 80% 白色；
- 正文行宽控制在 65–75ch；
- 不在每一列标题上重复 tiny uppercase tracked kicker；
- 当前 `01 · ...`、`02 · ...` 一类列标可以改为正常句式的小型导航说明，或只保留数字而取消全大写与过宽字距；
- 事实值和正文不依靠颜色区分。

## 9. 间距与布局

保留当前桌面和应用三栏布局，不改造成营销页或移动端页面。

统一基础间距：

```text
紧凑：8px
小：16px
中：24px
大：32px
窗口内容边距：24px–32px
普通卡片内边距：24px，空间允许时 32px
```

继续保留：

- `1440 × 900` 主设计基准；
- `1180 × 720` 最低桌面视口；
- 普通窗口下工作区横向滚动；
- 最大化窗口下多栏同屏；
- 每栏自己的纵向滚动所有权；
- 控件最小命中高度 44px；
- 交通灯视觉小、命中区至少 30px。

不增加：

- 手机断点；
- 平板导航；
- 触控抽屉；
- 单列移动应用；
- 窄屏下被裁切的残缺窗口。

## 10. OS 壳层设计

### 10.1 菜单栏

保留现有菜单、当前应用名称、系统摘要、刷新、诊断和时钟。

视觉：

- 6%–8% 白色环境玻璃；
- 40px 或 60px blur；
- 180% saturate；
- 底部 10% 白色细边；
- 顶部 inset 高光；
- 深色外阴影；
- 文字使用白色/80，品牌与当前应用使用白色；
- 菜单 hover 使用白色/10–15，不使用实心灰底。

### 10.2 应用窗口

保留现有窗口模板和 manager，不修改窗口状态所有权。

视觉：

- 外壳白色/8；
- 60px blur；
- 180% saturate；
- 24px 圆角；
- 15% 白色边框；
- 方向性大阴影；
- 标题栏本身仍是无色玻璃，不再使用实心 accent 混色；
- 聚焦窗口使用更亮边框、外阴影和克制的香槟焦点辉光；
- 非聚焦窗口只降低边缘强调，不降低正文可读性；
- 最大化、恢复、拖拽和 resize 的几何行为不变。

### 10.3 交通灯

保留红、黄、绿语义和现有 DOM/ARIA：

- 颜色只存在于 13px 左右的视觉圆点；
- 30px 命中区保持透明；
- hover 显示符号或增强边缘；
- focus 使用香槟金可见焦点；
- 禁用状态有文字/ARIA 和非颜色提示。

### 10.4 Dock

保留固定应用、动态运行应用、focused/background/minimized 状态和 overflow。

视觉与交互：

- Dock 外壳白色/8–12、60px blur；
- 不使用 hover 邻近放大；
- Dock 项 hover 只改变白色透明度、边框和高光；
- focused 使用香槟金细环或底部标记并保留状态文字；
- background/minimized 继续有非颜色状态文本和运行点；
- active 使用轻微 `scale(0.97)`；
- motion off/reduced-motion 下无位移和缩放。

### 10.5 应用中心与菜单浮层

- 使用独立 60px 玻璃浮层；
- 背景遮罩保持深色但不使用不透明黑色平面；
- 应用项改为低透明行/网格单元，不形成“卡片里面再套卡片”；
- hover 使用白色/10–15；
- 分组标题不使用重复 uppercase eyebrow；
- 焦点环、Escape 和焦点返回语义保持不变。

## 11. 共享组件

### 11.1 普通业务按钮

所有普通业务按钮统一包含：

```css
background: rgb(255 255 255 / 0.10);
backdrop-filter: blur(40px) saturate(180%);
border: 1px solid rgb(255 255 255 / 0.20);
border-radius: 16px;
color: #FFFFFF;
box-shadow:
  0 4px 16px rgb(3 7 18 / 0.45),
  inset 0 1px 0 rgb(255 255 255 / 0.25),
  inset 0 -1px 0 rgb(2 6 16 / 0.30);
transition: all 500ms cubic-bezier(0.16, 1, 0.3, 1);
```

hover：

```css
background: rgb(255 255 255 / 0.15);
border-color: rgb(255 255 255 / 0.35);
box-shadow:
  0 10px 32px rgb(3 7 18 / 0.55),
  inset 0 1px 0 rgb(255 255 255 / 0.35);
transform: translateY(-2px);
```

active：

```css
transform: scale(0.97);
```

主按钮仍保持无色玻璃，只通过以下方式增加优先级：

- 香槟金细边框；
- `#F3DCA8` 文字或图标；
- 克制的香槟焦点辉光；
- 不使用大面积金色填充。

### 11.2 输入框

```css
background: rgb(255 255 255 / 0.06);
backdrop-filter: blur(40px) saturate(180%);
border: 1px solid rgb(255 255 255 / 0.15);
border-radius: 16px;
color: #FFFFFF;
box-shadow:
  inset 0 1px 0 rgb(255 255 255 / 0.15),
  inset 0 -1px 0 rgb(2 6 16 / 0.30);
transition: all 500ms cubic-bezier(0.16, 1, 0.3, 1);
```

focus：

```css
border-color: rgb(255 255 255 / 0.35);
background: rgb(255 255 255 / 0.10);
box-shadow:
  0 0 0 3px rgb(228 184 99 / 0.15),
  inset 0 1px 0 rgb(255 255 255 / 0.25);
```

要求：

- placeholder 使用白色/35；
- 错误使用完整语义边框、图标、文字理由和 `aria-invalid`；
- disabled 不把透明度降到不可读，必须保留禁用说明；
- select、textarea、search、password、number 与普通文本输入使用同一体系。

### 11.3 顶层卡片

真正的顶层卡片、Dialog、Quick Look 和独立功能面板统一包含：

```css
background-color: rgb(255 255 255 / 0.08);
background-image:
  linear-gradient(to bottom, rgb(255 255 255 / 0.12), transparent 50%);
backdrop-filter: blur(60px) saturate(180%);
border: 1px solid rgb(255 255 255 / 0.15);
border-radius: 24px;
box-shadow:
  0 16px 40px rgb(3 7 18 / 0.50),
  inset 0 1px 0 rgb(255 255 255 / 0.22),
  inset 0 -1px 0 rgb(2 6 16 / 0.35);
```

内部的 metric、source、address、fact 等不再全部表现为独立大卡片，而使用：

- 4%–6% 白色弱表面；
- 10% 白色分隔线；
- 16px 圆角；
- 无独立外阴影；
- 继承外层 backdrop。

### 11.4 状态、错误与空状态

状态语义色建议：

| 状态 | 建议颜色 | 用法 |
| --- | --- | --- |
| ready/success | `#7FD3A4` | 图标、文字、完整细边框 |
| running | `#8EBCE6` | 图标、进度、完整细边框 |
| warning | `#E7C273` | 图标、文字、完整细边框 |
| error/danger | `#F08A84` | 图标、文字、完整 1px/2px 边框 |
| disabled | `rgb(255 255 255 / 0.42)` | 文字、图标、禁用边框 |

要求：

- 状态面板填充仍保持无色白色/5–8，不使用红/绿/蓝色大面积填充；
- 不使用左侧或右侧粗色条；
- 每个状态都有文字、图标或可读 marker；
- 错误正文不得使用白色/50；
- empty/error 状态不再通过 inset 3px/4px 单侧阴影表达。

### 11.5 表格、列表和事实区

- 表格外壳为白色/5–8；
- 表头使用白色/8–10，不使用实心 accent 背景；
- 行间使用白色/10 分隔线；
- hover 行为使用白色/8；
- selected 使用完整白色/35 边框、香槟图标和文本状态；
- 事实值使用白色或白色/85 等宽字体；
- 不给每一个单元格添加阴影或 backdrop；
- 横向滚动、粘性区域和当前业务布局继续保持。

### 11.6 图片与 Canvas 舞台

Review、Gallery 和其他图片区域：

- 承载舞台使用白色/5–8 低透明表面；
- 图片本身保持真实颜色，不套品牌滤镜；
- 图片边框使用白色/15；
- 圆角使用 16px；
- Quick Look 使用独立 60px 玻璃窗口；
- Review loupe、Canvas 生命周期和媒体释放契约保持不变。

## 12. 个性化功能收缩

### 12.1 保留内容

“外观设置”应用继续存在，但只保留：

- 六个内置夜景场景选择；
- 动效开启/关闭；
- 当前夜航玻璃的只读预览和状态说明；
- Apply、Cancel、恢复默认及既有未保存内容保护。

窗口透明度不再可选；所有正常内容固定使用本设计的低透明玻璃。

### 12.2 删除内容

删除：

- 强调色原生 color input；
- 窗口底色原生 color input；
- 浅色/深色自动 tone 推导；
- 任意界面配色预览；
- 本地图片 file input；
- 图片解码、重编码与格式探测；
- IndexedDB 壁纸读取、写入、恢复和删除；
- Object URL 创建、挂载和撤销；
- 自定义壁纸来源选择；
- cover/contain/stretch/tile；
- 九宫格图片位置；
- 壁纸遮罩色调与强度；
- 壁纸模糊；
- 窗口 solid/subtle/soft 透明度选择；
- 对应的预览、状态、错误和危险确认 UI。

生产模块处理顺序：

```text
webui/js/core/wallpaper-image-import.js   # 功能移除后删除
webui/js/core/wallpaper-storage.js        # 先收缩为一次性旧数据清理 seam
```

`wallpaper-storage.js` 当前不能在同一批次中直接无条件删除：旧用户浏览器里可能仍有 `imageweave-ui/wallpapers/custom`。本轮先把它收缩为不读取图片内容、只尽力删除已知 record 的兼容清理 seam；正式功能不得再依赖它。待至少一个兼容发布周期完成后，才在后续独立清理任务中删除该 seam。实施前必须通过真实 import graph 和仓内引用确认，不按文件名直接删除。

### 12.3 DOM 清理

从 `webui/index.html` 删除：

- `desktop-wallpaper__image-layer`；
- 自定义壁纸 `<img>`；
- `desktop-wallpaper__mask`。

壁纸层只保留：

- 内置夜景背景；
- 固定颗粒层；
- 无交互、无本地图片、无 Object URL。

### 12.4 偏好迁移

继续使用现有 UI 偏好存储边界，不新增第二套 storage service。

新正式偏好只需要：

- `animations`；
- `wallpaperColor`（语义已变为内置夜景场景 ID）；
- 现有兼容字段 `taskbarDensity` 如仍有调用则按原边界保留。

旧记录迁移规则：

1. 合法 `animations` 继续使用；
2. 合法的六个 `wallpaperColor` ID 继续使用，但视觉映射变为夜景；
3. `wallpaperKind=custom` 安全回退到 `graphite`；
4. `themeAccent`、`themeSurface`、图片显示字段和 `windowOpacity` 不再写回；
5. 损坏或未知数据回退默认夜航石墨；
6. 新写入只包含新白名单字段；
7. 不恢复浅色 tone，不向根节点写任意颜色 token；
8. 根元素固定为 `data-theme-tone="dark"` 和 dark `color-scheme`。

### 12.5 已存本地壁纸清理

当前本地壁纸使用：

```text
IndexedDB database: imageweave-ui
object store: wallpapers
key: custom
```

功能移除时执行一次尽力清理：

- 通过现有启动/持久化组合边界删除 `wallpapers/custom`；
- 清理失败、被阻塞或浏览器不支持 IndexedDB 时不得阻断桌面启动；
- 清理过程不读取或显示图片内容；
- 清理完成后正式运行不再打开该数据库用于壁纸；
- 不新增隐藏开关恢复旧功能。

如果确认 `imageweave-ui` 只有该壁纸 store，也仍优先删除已知 record，而不是无条件删除整个数据库，避免对未来或未知 store 做过宽操作。

## 13. 应用级改造原则

### 13.1 Crawl

- 保留三栏来源/搜索/创建布局；
- 三栏均使用低透明表面；
- 来源、候选和摘要项改为行与弱表面，避免嵌套大卡片；
- 授权、代理、弱证据和验证错误继续使用完整语义说明；
- 搜索、选择、排序、EH 参数和创建 payload 不变。

### 13.2 Tasks

- 保留最近批次/事实/恢复三栏；
- metric 改为无独立阴影的低透明事实单元；
- source/address 层级使用分隔线和 4%–6% 表面；
- 当前地址不再使用单侧 inset 状态条；
- 轮询、重试、重新规划和权威重读不变。

### 13.3 Proxy 与 Vault

- 敏感输入仍使用清晰完整边框和高对比帮助文本；
- 玻璃视觉不得弱化秘密清理、授权状态或危险确认；
- 不把代理、凭据或授权状态色铺满面板；
- 生命周期、轮询、请求取消和脱敏投影不变。

### 13.4 Policy 与 Diagnostics

- 长表单和诊断列表全部使用低透明表面；
- 错误、警告和继承状态由图标、文字、完整边框共同表达；
- 未保存内容保护和 20 秒轮询不变；
- 不制作伪终端、原始日志窗或彩色代码雨。

### 13.5 Review

- 保留全窗口 deck/stage/statusbar；
- 图片舞台改为低透明深玻璃，不使用实色浅底；
- active/selected 使用文本、图标和完整边框；
- 全量组、dirty 保存、快捷键、镜片和图片生命周期不变。

### 13.6 Gallery、Schedule、Export

- 正式 runtime 继续显示受控 unavailable；
- tests-only fixture 继续驱动完整状态；
- 所有预览内容使用同一低透明玻璃体系；
- 不增加业务 API，不把 fixture 引入生产闭包。

### 13.7 Personalization

- 重构为“场景 / 动效 / 应用”工作区；
- 删除主题颜色、本地图片和窗口透明度相关列与操作；
- 保留实时预览、Apply/Cancel、恢复默认和 dirty 离开保护；
- 不再出现“浅色界面”“窗口实色”“本地图片”文案。

## 14. 架构边界

本轮不得改变：

- `app-definitions.js` 的应用元数据单一来源原则；
- Store 对业务状态和窗口栈的所有权；
- Router 的空桌面与深链接语义；
- window manager 的拖拽、resize、z-order、最大化、最小化和关闭语义；
- `context.api` 作为业务请求唯一出口；
- model 白名单投影；
- dialog 焦点与确认边界；
- polling 在 deactivate/unmount 时停止；
- 位置偏好只保存 normal rect/maximized，不恢复工作区；
- import graph 0 个多文件 SCC；
- Store closure 排除 app controller 和 view；
- tests-only fixture 不进入生产依赖闭包。

本轮不得引入：

- React、Vue、Svelte 或其他 UI 框架；
- Tailwind；
- npm/pnpm/yarn/bun 构建步骤；
- 前端开发服务器；
- 远程字体；
- 远程图片；
- CSS-in-JS；
- 第二份主题状态或窗口状态；
- 新业务 API；
- 正式运行 Demo 开关。

## 15. 性能策略

高模糊和全内容透明是本轮最高性能风险，实施必须遵守：

1. 每个应用窗口最多一个主要 60px backdrop 合成层；
2. 内部低透明行默认继承外层模糊，不重复创建 backdrop；
3. 菜单栏、Dock、当前打开的菜单/应用中心/Dialog 可以分别拥有独立 backdrop；
4. 隐藏、最小化或关闭的浮层不得继续保留可见合成效果；
5. 全局噪点只创建一个固定层；
6. 拖拽和 resize 期间停止阴影、光泽和几何过渡；
7. 不使用持续运行的 specular sweep；如后续添加，只能在 hover 时短暂执行并支持 reduced-motion；
8. 不使用 blur 动画；只改变透明度、边框和 transform；
9. 在 1440×900 和 1180×720 下检查滚动、拖动和窗口切换；
10. backdrop 不支持时使用深色高对比实色回退，不能显示透明但不可读的内容。

## 16. 无障碍要求

- 正文与当前玻璃背景的对比度达到 WCAG 2.1 AA；
- 所有关键正文默认使用白色/80 或更高；
- 状态不能只靠颜色传递；
- 所有普通控件有 hover、active、focus-visible 和 disabled 状态；
- focus-visible 使用 3px 香槟金半透明环或 forced-colors 的系统 Highlight；
- 菜单、应用中心、Dock、交通灯、Dialog 和 Quick Look 保留键盘路径与焦点返回；
- 所有交互命中区不小于现有 30px/44px 契约；
- `prefers-reduced-motion` 和 `data-motion="off"` 都关闭非必要过渡；
- forced-colors 下移除渐变、噪点、阴影、透明度和 backdrop，使用系统色；
- `@supports not (backdrop-filter: blur(1px))` 提供可读回退；
- 浏览器缩放导致 CSS viewport 小于最低桌面边界时，继续只显示桌面环境提示；
- 不以“不做移动端”为由删除缩放、键盘、屏幕阅读器或高对比度支持。

## 17. 预计文件范围

### 17.1 壳层与共享样式

```text
webui/index.html
webui/styles/tokens.css
webui/styles/base.css
webui/styles/desktop.css
webui/styles/controls.css
webui/styles/status.css
webui/styles/dialog.css
webui/styles/responsive.css
webui/assets/noise.svg                         # 新增本地静态装饰资源
```

### 17.2 应用样式

```text
webui/styles/apps/crawl.css
webui/styles/apps/tasks.css
webui/styles/apps/proxy.css
webui/styles/apps/vault.css
webui/styles/apps/review.css
webui/styles/apps/policy.css
webui/styles/apps/diagnostics.css
webui/styles/apps/personalization.css
webui/styles/apps/gallery.css
webui/styles/apps/schedule.css
webui/styles/apps/export.css
```

### 17.3 个性化逻辑

```text
webui/js/main.js
webui/js/apps/personalization.js
webui/js/components/personalization-view.js
webui/js/core/personalization.js
webui/js/core/personalization-model.js
webui/js/core/storage-preferences.js
webui/js/core/wallpaper-image-import.js        # 本轮删除
webui/js/core/wallpaper-storage.js             # 本轮收缩为一次性兼容清理 seam
```

只有在引用和测试证明不再需要时才删除模块。不得为了视觉重构顺手修改无关业务 controller/model。

### 17.4 后端静态交付与打包

```text
gallery-dl-backend/pyproject.toml             # 纳入 webui/assets/*.svg
gallery-dl-backend/tests/test_api.py          # 同源静态资源、DOM 和删除资源契约
gallery-dl-backend/tests/test_webui_modules.py # Python 静态边界与禁止项
```

`gallery-dl-backend/gdl_backend/app.py` 原则上不修改。现有 `StaticFiles` 挂载已经递归提供 `webui/`；新增资源应通过打包清单进入 wheel 后自动可访问。

### 17.5 WebUI 测试、runner 与文档

预计更新：

- 新增独立夜航玻璃目标契约，例如 `tests/webui_nocturne_glass_contract.test.mjs`；
- `tests/webui_modules.test.mjs`；
- `tests/webui_stage4_personalization_contract.test.mjs`；
- 受视觉 DOM 变化影响的 Stage 3–5 应用契约；
- `scripts/run-webui-coverage.py` 的 `SOURCE_TESTS`（目标契约转绿后再纳入）；
- WebUI 视觉 token 静态契约；
- Personalization model/runtime/view/controller 测试；
- production fixture isolation；
- backdrop/forced-colors/motion 回退测试；
- 11 个应用浏览器截图与交互验收；
- README 和正式 WebUI 行为文档（最终实现完成后同步）。

## 18. 线性任务顺序

### 18.1 总顺序

本轮按下面的依赖链线性执行，不建议交换顺序：

```text
T0 现状基线
  → T1 red-first 目标契约
  → T2 SVG 静态资源与 wheel 通道
  → T3 Personalization 功能收缩与旧数据迁移
  → T4 夜景/Token/根主题
  → T5 OS 壳层
  → T6 共享组件
  → T7 八个真实应用
  → T8 三个预览应用
  → T9 遗留清理与目标契约转绿
  → T10 后端静态交付/wheel/完整门禁
  → T11 浏览器验收、文档与最终收口
```

| 顺序 | 任务 | 主要性质 | 必须在其后开始的原因 |
| ---: | --- | --- | --- |
| T0 | 现状基线 | 测试/证据 | 后续必须能区分视觉变化和既有回归。 |
| T1 | 目标契约 | 独立前端 red-first 测试 | 先固定删除项、Token 和架构禁止项；Python 正式静态断言等实现转绿时再更新。 |
| T2 | 静态资源通道 | 前端资源 + 后端打包 | 先保证噪点资源能同源提供并进入 wheel。 |
| T3 | Personalization 收缩 | 前端行为 + 浏览器存储迁移 | 任意颜色、浅色和自定义壁纸必须先退出状态模型，后续 CSS 才有唯一事实源。 |
| T4 | 视觉基础 | 前端 CSS/HTML | 为壳层和所有应用提供统一 Token。 |
| T5 | OS 壳层 | 前端 CSS，少量 DOM | 先稳定窗口、菜单、应用中心和 Dock 的最终外壳。 |
| T6 | 共享组件 | 前端 CSS/组件 | 应用迁移前先统一按钮、输入、状态和 Dialog。 |
| T7 | 真实应用 | 前端应用视图/CSS | 逐个消除实色表面和嵌套卡片，不混入预览 fixture。 |
| T8 | 预览应用 | 前端视图/CSS + tests-only fixture | 真实应用稳定后再处理三套完整夹具状态。 |
| T9 | 遗留清理 | 前端/测试 | 所有替代实现完成后才能安全删除旧 selector、模块和断言。 |
| T10 | 静态交付收口 | 后端打包/测试 | 用最终文件集合验证 FastAPI、wheel 和删除资源。 |
| T11 | 最终验收 | 全栈门禁/文档 | 只在生产代码稳定后生成截图和同步正式文档。 |

每个 T 任务建议形成一个独立提交；T7 的每个子任务也各自提交。每个 substantial batch 完成并通过对应门禁后，在仓库根目录执行：

```bash
REPOWISE_SKIP_EDITOR_SETUP=1 repowise update
```

不得运行 `repowise init`，不得改变现有 `.repowise/config.yaml`。

### T0：现状基线（不改生产代码）

**目标**：确认当前 HEAD 的生产和测试基线。

**执行**：

1. 确认 tracked tree 状态，保护现有 untracked/ignored 文件；
2. 执行当前固定 Node WebUI coverage；
3. 执行 `tests.test_webui_modules` 和 `tests.test_api`；
4. 执行 Linux service smoke 与依赖锁检查；
5. 保存 `/ui/`、`#/tasks`、`#/personalization`、`#/review` 在 1440×900 的人工对照截图；
6. 记录当前测试数、覆盖率和已知浏览器 warning。

**完成条件**：旧实现完整 green；没有生产文件改动。

### T1：red-first 夜航目标契约

**目标**：在写实现前固定最终行为与禁止项。

**主要文件**：

```text
gallery-dl-backend/tests/webui_nocturne_glass_contract.test.mjs  # 新增，暂不接入正式 runner
```

Python 的正式静态断言在实现转绿过程中再更新；T1 不向 `unittest discover` 加入故意失败的测试，避免破坏既有 Python 基线。

**契约至少覆盖**：

- 根主题只能是 dark；
- 新偏好只包含场景和动效；
- 没有 color input、file input、自定义壁纸显示路径和可选窗口透明度；
- 六个场景都有 radial light wells；
- 噪点资源存在；
- 4%–12% 玻璃、40px/60px blur、180% saturate、500ms easing；
- 固定香槟金；
- 没有紫粉渐变、渐变文字、单侧粗状态条和旧快速过渡；
- Store、Router、window manager、应用 registry 和业务 endpoint 不变。

**执行约束**：

- 新 Node 目标测试先单独执行并预期失败；
- 此时不要加入 `scripts/run-webui-coverage.py::SOURCE_TESTS`，避免正式 coverage runner 长期红灯；
- 既有完整测试必须继续 green；
- 保存 red 日志，明确每项失败都来自目标尚未实现，而不是测试自身错误。

**完成条件**：目标契约稳定 red，既有套件 green。

### T2：SVG 噪点静态资源与后端打包通道

**性质**：这是第一处“前后端同时改”的任务，但不涉及后端业务代码。

**前端资源**：

```text
gallery-dl-backend/gdl_backend/webui/assets/noise.svg
```

**后端打包/测试**：

```text
gallery-dl-backend/pyproject.toml
gallery-dl-backend/tests/test_api.py
```

**执行**：

1. 创建固定、无脚本、无外链的 `feTurbulence` SVG；
2. 在 `tool.setuptools.package-data` 增加 `webui/assets/*.svg`；
3. 不修改依赖版本，不重生成 requirements 锁；
4. 增加 `/ui/assets/noise.svg` 返回 200、同源、预期 SVG Content-Type 的测试；
5. 构建一次 wheel，确认 SVG 被打包；
6. 确认 `app.py` 无需修改；只有 StaticFiles 实测失败才允许最小修正。

**完成条件**：资源可由正式 FastAPI 提供并存在于 wheel；业务 API 路由集合完全不变。

### T3：Personalization 功能收缩与迁移

**目标**：先消除会让后续视觉漂移的状态源。

#### T3.1 偏好模型

修改：

```text
webui/js/core/personalization-model.js
webui/js/core/storage-preferences.js
```

顺序：

1. 新正式偏好只保留 `animations`、`wallpaperColor` 和仍有调用证据的兼容字段；
2. 读取旧记录时提取合法场景/动效，忽略并丢弃 theme、custom image、mask、fit、position、blur 和 window opacity；
3. `wallpaperKind=custom` 回退 `graphite`；
4. 新序列化结果不再写旧字段；
5. 保持 plain-object、危险键、accessor 和未知字段防护。

#### T3.2 旧 IndexedDB 清理 seam

修改并收缩：

```text
webui/js/core/wallpaper-storage.js
```

顺序：

1. 删除图片读取、校验、写入、恢复和公开展示能力；
2. 只保留 idempotent 的 `wallpapers/custom` 尽力删除；
3. 不读取 Blob 内容；
4. blocked/unavailable/error 不阻断启动；
5. 清理完成后关闭连接；
6. 文件作为一个兼容发布周期的 migration seam 保留，不再作为 Personalization 功能依赖。

#### T3.3 Runtime、View 与 Controller

按依赖从内到外修改：

```text
webui/js/core/personalization.js
webui/js/components/personalization-view.js
webui/js/apps/personalization.js
webui/js/main.js
webui/index.html
```

顺序：

1. runtime 只管理内置场景和 motion；
2. view 删除主题 color input、本地图片和窗口透明度控件；
3. controller 删除导入、删除图片、主题草稿和图片相关事件；
4. `main.js` 不再创建完整 wallpaper storage，不再传 image/mask 节点；只触发一次兼容清理；
5. `index.html` 删除 image layer 与 mask，并固定 dark tone；
6. 删除 `wallpaper-image-import.js` 及所有引用；
7. 更新 Personalization Node/Python 契约和生命周期测试。

**完成条件**：

- 正式 UI 无任意颜色和本地图片入口；
- 正式运行不读取/显示旧壁纸；
- 老偏好安全迁移；
- 清理 seam 失败不影响桌面；
- Personalization 的 Apply/Cancel/reset/dirty/beforeLeave 保持；
- WebUI 行为测试和 Python 静态测试 green。

### T4：夜景、Token 与根主题

**主要文件**：

```text
webui/styles/tokens.css
webui/styles/base.css
webui/styles/desktop.css
webui/index.html
```

**执行顺序**：

1. 固定 dark `color-scheme` 和白色文字体系；
2. 建立香槟金、状态色、玻璃、边框、阴影、圆角和 easing token；
3. 把六个 wallpaper ID 映射为带 2–3 个光井的深色场景；
4. 挂载单一噪点层；
5. 建立 backdrop unsupported、forced-colors、prefers-contrast 和 reduced-motion 回退；
6. 删除 light token 分支和任意颜色衍生；
7. 先验证裸桌面，再验证一个普通窗口和一个最大化窗口。

**完成条件**：夜景和 Token 独立成型；不要求此时所有应用细节已经收口，但正文必须可读。

### T5：OS 壳层

**主要文件**：

```text
webui/styles/desktop.css
webui/js/components/menu-bar.js                 # 仅在 DOM/状态标记确有需要时
webui/js/components/application-center.js       # 同上
webui/js/components/taskbar-windows.js          # 同上
```

**执行顺序**：

1. 菜单栏；
2. 窗口与标题栏；
3. 聚焦/非聚焦边界；
4. 交通灯；
5. 应用中心和菜单 popover；
6. Dock 与 overflow；
7. 删除 Dock hover 放大；
8. 验证 drag/resize 期间 transition 关闭。

**不得修改**：窗口 action、z-order、geometry、Router 或 Store transition。

**完成条件**：空桌面、深链接、普通/最大化、最小化、关闭、Dock 四状态和焦点返回全部 green。

### T6：共享组件

**主要文件**：

```text
webui/styles/controls.css
webui/styles/status.css
webui/styles/dialog.css
webui/js/components/status.js       # 仅在非颜色 marker 需要时
webui/js/components/empty-state.js  # 同上
webui/js/components/error-view.js   # 同上
webui/js/components/dialog.js       # 同上
```

**执行顺序**：

1. 普通/主要/危险/禁用按钮；
2. input/select/textarea；
3. focus、hover、active 和 invalid；
4. status badge；
5. empty/error；
6. Dialog 与 backdrop；
7. 删除所有共享单侧粗状态条；
8. forced-colors 与 motion fallback。

**完成条件**：共享组件在至少 Crawl、Tasks、Vault、Dialog 四种上下文中可读，且不改变组件 API。

### T7：八个真实应用

必须按下面顺序逐个提交；每个子任务完成后运行该应用的 Node 契约、Python 静态套件和一次正式浏览器验收。

#### T7.1 Crawl

- 三栏低透明化；
- 来源/候选/摘要扁平化；
- 保留 autocomplete、排序、EH 规则、验证和 create→Tasks 闭环。

#### T7.2 Tasks

- 三栏低透明化；
- metric/source/address/table 扁平化；
- 保留轮询、写后权威重读、取消/重试/重新规划。

#### T7.3 Proxy 与 Vault

- 先 Proxy，后 Vault；
- 保留敏感输入、轮询、授权会话、秘密清理和确认边界；
- 状态色只做小面积语义表达。

#### T7.4 Policy 与 Diagnostics

- 先 Policy，后 Diagnostics；
- 保留 dirty 保护与 20 秒轮询；
- 不引入伪终端或原始日志视觉。

#### T7.5 Personalization 视觉

- 把 T3 已简化的“场景 / 动效 / 应用”工作区完全适配夜航玻璃；
- 浏览器验证老偏好迁移和旧 custom record 清理失败/成功路径；
- 继续保留 dirty 单飞确认。

#### T7.6 Review

- 最后迁移复杂的全窗口 deck/stage/statusbar；
- 保留 all=true、dirty 串行保存、快捷键、loupe、Canvas 和图片释放；
- 在 1440×900、1180×720、普通 800×560 与最大化下验证。

**T7 完成条件**：八个真实应用行为契约无回归，所有正常可见内容都已进入 4%–12% 玻璃体系。

### T8：三个预览应用

按顺序执行：

1. Gallery；
2. Schedule；
3. Export。

每项验证：

- 正式 runtime 仍是 unavailable；
- 0 个所属业务 API；
- tests-only loading/empty/content/error；
- Gallery Quick Look；
- Schedule dirty/validation；
- Export running/success/error 事实；
- fixture 不进入生产闭包。

**完成条件**：三个应用视觉统一且正式运行边界不变。

### T9：遗留清理与目标契约转绿

**执行**：

1. 确认 T3 已删除 `wallpaper-image-import.js`，并清除所有残余图片导入引用；
2. 确认 `wallpaper-storage.js` 只剩兼容清理 seam；
3. 删除 light theme、themeAccent/themeSurface、window opacity 和 custom wallpaper selector/文案；
4. 删除旧 92%–100% 表面、18px/24px blur、118%/124% saturate 和 120ms/180ms 视觉 token；
5. 删除单侧粗状态条、视觉嵌套大卡片、渐变文字和重复 uppercase kicker；
6. 扫描生产 import graph 和静态资源引用；
7. 运行 T1 目标测试，修到全部 green；
8. 将目标测试加入 `scripts/run-webui-coverage.py::SOURCE_TESTS`；
9. 运行完整 WebUI coverage，不能降低 floor。

**完成条件**：目标契约进入唯一正式 runner，生产闭包不含已删除功能，WebUI coverage green。

### T10：后端静态交付、wheel 与全量门禁

这一任务才是后端工程侧的最终收口；仍不修改业务后端。

**执行**：

1. 更新 `tests/test_api.py` 最终资源清单：新 SVG 为 200，已删除模块为 404；
2. 更新 `tests/test_webui_modules.py` 最终 DOM/CSS/安全契约；
3. 确认 `pyproject.toml` package-data 包含 SVG 且不手工修改 requirements；
4. 从 clean tree 构建 wheel；
5. 检查 wheel 包含 `noise.svg`、11 个 app controller/CSS，不包含已删除的 wallpaper importer；
6. 通过正式 `create_app` 逐一请求 HTML、CSS、JS、SVG；
7. 运行完整 backend coverage；
8. 运行 dedup、Proxy_pool coverage；
9. 运行 Linux service smoke、依赖锁检查和 `git diff --check`；
10. 确认 OpenAPI 路由、业务 endpoint 数量和 schema 无变化。

**完成条件**：静态资源随后端 wheel 同源提供，全部后端/跨组件门禁 green；`gdl_backend` 的 API、ServiceContainer、数据库和领域服务 Python 源码无改动，或只有经实测证明必要的静态挂载最小修正。

### T11：浏览器验收、文档与最终收口

**执行顺序**：

1. 按 19.3 的浏览器矩阵验收六场景和 11 应用；
2. 检查 0 remote、0 非预期 HTTP error、0 非预期 console error；
3. 检查 forced-colors、reduced-motion、motion off、缩放和小视口 blocker；
4. 检查 Crawl 闭环、Review 保存、代表性轮询停止、Gallery Quick Look 和 Personalization 迁移；
5. 记录 GPU/滚动/拖拽风险；
6. 更新 `README.md`、`docs/ARCHITECTURE.md`、`docs/gallery-dl-backend.md` 和正式截图；
7. 执行文档链接、README checker、wheel 清单和所有最终门禁；
8. 执行最终 RepoWise 增量更新；
9. 确认 tracked tree 只包含本轮预期文件。

**完成条件**：第 20 节全部完成定义满足，并追加第 21 节实施记录。

## 19. 测试与验收

### 19.1 静态契约

至少覆盖：

- 根主题固定为 dark；
- 不存在可写的任意界面 accent/surface 控件；
- 不存在本地壁纸 file input、Object URL、图片适应/定位/遮罩控制和正式壁纸读取/显示路径；IndexedDB 只允许一次性删除旧 `wallpapers/custom` 的兼容清理 seam；
- 六个场景都有径向光井，不是纯色平面；
- 正常玻璃透明度为 4%–12%，hover 不超过 15%；
- 主要 blur 为 40px/60px；
- saturate 为 180%；
- 非直接操控过渡为 500ms spring easing；
- 不存在紫粉 AI 渐变和渐变文字；
- 不存在单侧粗边框/阴影状态装饰；
- 不存在 120ms/150ms 等旧快速视觉过渡；
- 不存在每列重复的 uppercase tracked kicker；
- 噪点资源同源、静态、可打包且只引用一次；
- forced-colors、reduced-motion 和 backdrop 不支持回退完整；
- import graph、Store closure 和 fixture isolation 继续通过。

### 19.2 行为契约

视觉改造不得破坏：

- 裸 `/ui/` 空桌面；
- 11 个合法深链接只打开目标窗口；
- Dock closed/focused/background/minimized 动作；
- 窗口拖拽、resize、最大化、最小化、关闭和位置偏好；
- 菜单与应用中心键盘导航；
- dialog/Quick Look 焦点 trap 与返回；
- 各应用 mount/activate/deactivate/unmount；
- dirty 离开/隐藏保护；
- 各应用轮询停止和恢复；
- Crawl 创建到 Tasks 的真实闭环；
- Review 精确保存、镜片和图片释放；
- preview 应用正式运行 0 所属业务 API。

### 19.3 浏览器矩阵

至少验收：

- `1440 × 900`；
- `1180 × 720`；
- `1179 × 719` 只显示环境提示；
- 浏览器缩放 100%、125%、150%；
- 六个内置夜景；
- 普通窗口 800×560 与最大化；
- 11 个应用；
- motion on/off；
- `prefers-reduced-motion`；
- forced-colors；
- backdrop supported 的正式路径；
- backdrop unsupported 的静态契约；
- 键盘启动、菜单、Dock、交通灯和 Dialog；
- 控制台 0 个非预期错误；
- 静态资源 0 个远程请求；
- 正式 DOM、storage、network 和日志不包含本地壁纸内容或旧 Object URL。

### 19.4 标准命令

从仓库根目录执行受影响的 WebUI 门禁，最终收口执行完整项目门禁：

```bash
NODE_24=/absolute/path/to/node-v24.13.0/bin/node
./gallery-dl-backend/.venv/bin/python scripts/run-webui-coverage.py \
  --node "$NODE_24" \
  --output /tmp/imageweave-coverage/webui

cd gallery-dl-backend
./.venv/bin/python -m unittest tests.test_webui_modules -v
cd ..

bash scripts/smoke-linux-service.sh
./scripts/lock-dependencies.sh --check
git diff --check
```

最终收口还应按 `ARCHITECTURE.md` 执行 backend、dedup 和 Proxy_pool 的既有完整 coverage 门槛，不降低 `scripts/coverage-baselines.json`。

## 20. 完成定义

以下条件全部满足后，本轮才视为完成：

- 正式 WebUI 只有深色夜航玻璃主题；
- 不再存在用户可写的任意界面强调色或窗口底色；
- 本地图片壁纸功能、DOM、图片读取/显示运行时和相关 UI 已删除；除一次性删除 `wallpapers/custom` 的兼容清理 seam 外，不再访问壁纸 IndexedDB；
- 六个内置背景全部是深墨夜景与光井组合，不存在纯色平面或紫粉 AI 渐变；
- 菜单栏、窗口、应用中心、Dock、Dialog 和 11 个应用使用同一无色玻璃语言；
- 所有正常内容表面使用 4%–12% 低透明白色，hover 不超过 15%；
- 主要玻璃使用 40px/60px blur 和 180% saturate；
- 方向性顶边高光、底边暗缘和外层深阴影完整；
- 全局 2%–3% 噪点存在且只叠加一次；
- 香槟金是唯一装饰强调色，语义状态色只做小面积状态表达；
- 普通组件统一使用 16px/24px 大圆角；
- 不存在视觉嵌套卡片、单侧粗状态条、渐变文字和重复 uppercase kicker；
- 普通动效使用 500ms spring easing，直接操控与 reduced-motion 正确例外；
- OS 窗口、路由、Dock、菜单和应用中心行为无回归；
- 八个真实应用的 API、状态、安全、轮询和生命周期无回归；
- 三个预览应用继续正式 unavailable 且不发送不存在的业务请求；
- 1180×720 及以上桌面稳定，低于边界继续显示阻断提示；
- WCAG AA、键盘、焦点、forced-colors、reduced-motion 和 backdrop 回退可用；
- WebUI import graph、Store closure、fixture isolation、coverage、service smoke、依赖锁和 `git diff --check` 全部通过；
- 正式文档和截图与最终实现同步。

## 21. 实施记录模板

每个阶段完成后在本文追加：

```text
完成日期：YYYY-MM-DD
阶段：<编号与名称>
提交：<commit>
行为变化：<视觉变化和保持不变的契约>
测试：<新增/更新测试与关键用例>
验证：<实际执行命令和结果>
覆盖率：<受影响分组 line/branch/function>
浏览器验收：<视口、场景、应用、交互与结果>
剩余风险：<明确事项>
```

实施中如发现本文与真实源码发生偏移，应先校正基线、影响范围和验收条件，再修改生产代码；不得用视觉目标覆盖既有业务和安全契约。

### 实施记录：T0 现状基线

- 完成日期：2026-08-14
- 阶段：T0 现状基线
- 提交：无（只验证基线，不改生产代码）
- 行为变化：基线 HEAD `39a2fec8b535b6bf8d1b343419d1596a0f9062f1` 的 tracked tree 保持 clean；未改变 WebUI、后端业务或测试 runner。
- 测试：固定 Node v24.13.0 的既有 311 个 Node 测试、`tests.test_webui_modules` 16 个测试、`tests.test_api` 71 个测试全部通过；Linux service smoke、依赖锁检查和 `git diff --check` 通过。
- 验证：WebUI runner 为 311/311 pass、0 fail、0 skipped；service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；截图和日志保存在 `/tmp/imageweave-nocturne-t0/`。
- 覆盖率：core line/branch/function `86.614746% / 77.481177% / 90.622098%`；apps `74.321196% / 65.497630% / 67.821782%`；components `32.515091% / 76.374443% / 63.218391%`，全部高于既有 floor。
- 浏览器验收：Chromium 在 `1440×900` 完成 `/ui/`、`#/tasks`、`#/personalization`、`#/review` 四张基线截图；截图均成功，前三条命令记录到一次 `ContextResult::kTransientFailure` GPU warning，Review 未记录该 warning。
- 剩余风险：当前实现仍是本文第 4 节所述浅色、高实色表面、纯色背景和旧个性化能力；T0 截图只用于后续视觉对照，不代表夜航目标完成。

### 实施记录：T1 red-first 夜航目标契约

- 完成日期：2026-08-14
- 阶段：T1 red-first 夜航目标契约
- 提交：见本阶段提交
- 行为变化：只新增独立最终目标契约并补充实施记录；没有修改 WebUI 生产实现、Python 正式断言、coverage runner 或 coverage baseline。基线核对发现本设计文件受 `.gitignore` 的 `/docs/*` 命中、此前不在 HEAD；按本任务明确要求只将该指定设计文件连同记录纳入提交，不纳入其他 ignored docs。源码核对确认 `taskbarDensity` 在 `storage-preferences.js` 之外没有生产消费者，因此新写入白名单按场景 `wallpaperColor` 与动效 `animations` 两项固定。业务 endpoint 基线只快照各应用导出的 `*_ENDPOINTS`，不冻结 controller 内部实现。
- 测试：新增 `gallery-dl-backend/tests/webui_nocturne_glass_contract.test.mjs` 共 16 个分组测试；standalone 结果为 6 pass、10 个预期 red。red 分组为固定 dark 根主题、偏好模型白名单/旧 custom 回退、偏好序列化不写回、旧图片壁纸与透明度运行时删除、delete-only IndexedDB seam、六场景光井、安全单例噪点、玻璃/强调色/圆角/光学 token、500ms motion、旧实色表面/着色状态填充/单侧粗条/uppercase kicker。已 green 的 6 组为能力与无障碍回退、渐变安全扫描、Registry/Router、Store/window manager、业务 endpoint 快照、Personalization 与三个 preview 的 0 API/fixture closure。扫描只把背景填充中的语义色算作违规，不误判图标/文字/细边框语义色；forced-colors/backdrop fallback 实色和合法 radial light wells 被明确排除。
- 验证：使用精确 Node v24.13.0 单独执行目标测试，正常装载且仅以 AssertionError 报告目标差距，red 日志为 `/tmp/imageweave-nocturne-t1/standalone-red.log`；目标文件未加入 `scripts/run-webui-coverage.py::SOURCE_TESTS`。既有 runner 仍为 311/311 pass；`tests.test_webui_modules` 为 16/16 pass；`tests.test_api` 为 71/71 pass；Linux service smoke、依赖锁检查和 `git diff --check` 通过。
- 覆盖率：独立 red 目标按约束不计入正式 coverage；既有 runner 指标与 T0 相同且 gate PASS。
- 浏览器验收：T1 没有生产视觉变化，也没有新增浏览器验收；继续使用 `/tmp/imageweave-nocturne-t0/` 的四张基线截图。
- 剩余风险：10 个 red 分组必须在 T2–T9 逐步转绿；T2 首先承担安全 SVG、同源静态提供与 wheel package-data 风险，不能借机改变 FastAPI 业务路由。目标契约在 T9 全绿前保持 standalone；旧 Python 静态断言仍描述当前实现，需在对应实现阶段而非 T1 提前改写。

### 实施记录：T2 SVG 噪点静态资源与后端打包通道

- 完成日期：2026-08-14
- 阶段：T2 SVG 噪点静态资源与后端打包通道
- 提交：见本阶段提交
- 行为变化：新增固定 `256×256`、灰度、可平铺的本地 `feTurbulence` 装饰资源，并把 `webui/assets/*.svg` 纳入 setuptools package-data；未修改 `app.py`、业务 API、依赖、版本或 requirements 锁。T2 只贯通资源与交付通道，不在 HTML/CSS 中视觉挂载；全视口单层挂载、`pointer-events: none`、forced-colors 移除和最终 `2.5%` opacity 明确留给 T4。
- 测试：`tests.test_api` 新增正式 `create_app`/`StaticFiles` 同源 HTTP、SVG MIME、内部结构及脚本/事件/外链/data URI/动态内容禁止项，72/72 pass；`tests.test_webui_modules` 16/16 pass；固定 Node v24.13.0 正式 runner 311/311 pass。
- 验证：`uv 0.12.3 build --wheel` 在 `/tmp/imageweave-nocturne-t2/` 的隔离源码/缓存/输出中成功；wheel 的 104 个 WebUI 成员与构建源精确一致，`gdl_backend/webui/assets/noise.svg` 恰好 1 份、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`，11/11 应用 controller 与 CSS 仍在。工作树和 wheel 解包后的正式 app 请求均返回 `200`、`Content-Type: image/svg+xml` 且响应字节一致；前后 OpenAPI 50 paths/61 operations、FastAPI 61 条业务 route 及唯一 `/ui` StaticFiles mount 快照完全一致。
- 覆盖率：正式 runner 指标保持 core line/branch/function `86.614746% / 77.481177% / 90.622098%`、apps `74.321196% / 65.497630% / 67.821782%`、components `32.515091% / 76.374443% / 63.218391%`，全部通过既有 gate。
- 浏览器验收：T2 没有可见挂载或视觉变化，按阶段边界不新增截图；同源 FastAPI 交付和 wheel 解包运行时已实际请求验收。
- 剩余风险：standalone 夜航契约仍为 6 pass/10 个预期 red；噪点分组从“资源缺失 + 0 引用 + 0 CSS 规则”缩减为“0 引用 + 0 CSS 规则”，须由 T4 只挂载一次并设为 `2.5%`，不能在 T3 越界处理。T3 仍需重点守住偏好白名单、旧 custom 回退和 delete-only IndexedDB 清理 seam，同时保持本阶段静态路径、wheel 通道与业务 route 集合不变。

### 实施记录：T3 Personalization 功能收缩与迁移

- 完成日期：2026-08-14
- 阶段：T3 Personalization 功能收缩与迁移
- 提交：见本阶段独立提交
- 行为变化：正式偏好收缩为 `animations` 与 `wallpaperColor` 两项，六个场景 ID 和默认 `graphite` 不变；仓内取证确认 `taskbarDensity` 在旧 storage 投影外没有生产消费者，故不再写回。读取时保留合法场景/动效，旧 `wallpaperKind=custom` 回退石墨，退役 theme、图片显示、遮罩和窗口透明度字段被忽略；严格写入继续拒绝非普通对象、危险键、accessor、类型污染和未知字段。Runtime/View/Controller 只保留场景、motion、只读夜航玻璃状态、Apply/Cancel/reset、dirty 与单飞离开确认；根固定 dark，删除图片 DOM、Object URL/图片运行时及 `wallpaper-image-import.js`。`main.js` 只独立触发一次不进入 Personalization 状态的兼容清理。
- 测试：固定 Node v24.13.0 正式 runner 为 305/305 pass、0 fail、0 skipped；更新 model/storage/runtime/view/controller/import graph/Stage 4 契约，并覆盖六场景矩阵、custom/损坏/危险记录、严格新写入、Apply/Cancel/reset、busy 单飞、deactivate/unmount、真实 dialog 离开保护。delete-only seam 覆盖成功、无 IndexedDB、同步/open error、blocked 后迟到连接、无 store、transaction error、delete error、关闭连接及 0 record/Blob 读取。`tests.test_webui_modules` 为 16/16，`tests.test_api` 为 72/72；standalone 夜航目标收敛到 11 pass/5 个预期 red。
- 验证：Linux service smoke、依赖锁检查和 `git diff --check` 通过。生产 import graph 所有相对模块可解析、0 个多文件 SCC，删除模块经正式 StaticFiles 与 wheel 解包 app 均为 404；OpenAPI 50 paths/61 operations、FastAPI 61 条业务 route 和唯一 `/ui` mount 与 T2 快照逐项相同。隔离 `uv 0.12.3 build --wheel` 得到 103/103 个精确匹配的 WebUI 成员，`noise.svg` 恰好 1 份、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`，源与 wheel app 请求均为 200 `image/svg+xml`；T3 未挂载噪点。
- 覆盖率：core line/branch/function `90.701754% / 78.266428% / 91.897436%`；apps `76.503844% / 65.354331% / 68.341709%`；components `27.427938% / 76.126878% / 61.087866%`，全部通过既有 floor。
- 浏览器验收：Chromium 150 在 `1440×900` 对 `/ui/#/personalization` 完成两条真实浏览器路径与截图。成功路径先写入含 Blob 的 `imageweave-ui/wallpapers/custom` 和旧 custom 偏好，启动后 record 确认删除、偏好迁移为 `{animations:"off", wallpaperColor:"graphite"}`；失败路径在新文档启动前让 `IDBFactory.open` 抛受控 `UnknownError`，桌面仍正常激活。两条路径均为 6 场景/2 motion、0 color/file/image/mask DOM、0 shell error、0 非同源资源和 0 非预期浏览器错误，并实际验证场景实时预览、Cancel 恢复和 Apply 写回新白名单。证据位于 `/tmp/imageweave-nocturne-t3/`。
- 剩余风险：T4 仍负责六场景径向光井、噪点唯一挂载、完整低透明无色玻璃 token、40px/60px blur、180% saturate、香槟金、16px/24px 圆角、500ms spring 与旧实色/状态装饰清理；standalone 对应 5 组 red 必须保留到 T4 真实实现，不能在 T3 用占位视觉或放宽断言提前转绿。一次性 IndexedDB seam 需保留至少一个兼容发布周期，后续删除须另行取证。

### 实施记录：T4 夜景、Token 与根主题

- 完成日期：2026-08-14
- 阶段：T4 夜景、Token 与根主题
- 提交：见本阶段独立提交
- 行为变化：根主题继续固定 `dark`，移除实际生效的分支式 dark 覆盖和浅色 token；`tokens.css` 成为 `#060A13/#0B1322` 背景、白色 100%/80%/50%/85% 文字、`#E4B863/#F3DCA8` 香槟金、18% focus glow、4%–12% 中性玻璃与 15% hover、10%/15%/20%/35% 边框、40px/60px blur、180% saturate、16px/24px/999px 圆角、三类方向阴影及 500ms spring 的唯一事实源；既有 selector 只通过明确 alias 消费这些事实。六个 ID 在 `desktop.css` 分别使用设计基底与 2–3 个大半径 radial light well，`graphite` 保持默认右上月光、左下深蓝、中央微金方向。删除未被生产消费的旧平面色值 map，使 JS 只拥有合法 ID、CSS 独占视觉事实。`index.html` 新增唯一 `aria-hidden` 噪点节点，CSS 只同源引用一次 `assets/noise.svg`，固定全视口平铺、`opacity: 0.025`、`pointer-events: none` 且位于窗口/Menu/Dock 下方。标题使用本地中文衬线回退，正文/事实继续使用系统 UI/monospace；未引入远程字体。
- 测试：把正式 Python/Node 静态契约从旧纯色/96%–74% 表面/120ms 窗口断言最小校正为 T4 已确认语法和数值，并新增六场景 radial、单噪点 DOM/CSS、canonical alias、fallback、字体及“所有已消费 `--imageweave-*` token 均有定义”断言。真实源码中 Review 仍消费 `radius-lg/md/sm` 等旧 selector 名，按本阶段“canonical token + alias”约束必须写成 `var(--imageweave-radius-card/control)`；T1 原断言只接受直接 `16px/24px`，与合法 alias 语法冲突，因此只把 radius 检查收紧为“精确值或指向四个 canonical radius 的单层 var”，未放宽允许值、未修改其他 T1 目标或 coverage floor。固定 Node v24.13.0 正式 runner 为 305/305 pass；`tests.test_webui_modules` 为 16/16，`tests.test_api` 为 72/72。standalone nocturne 为 15 pass/1 个预期 red：scene、noise、glass token、motion 四个 T4 分组均转绿，只剩跨 T5–T9 的 legacy visual 分组，具体仍有旧 `*-solid` selector、12 处着色状态表面引用、8 处单侧粗条和 9 处 uppercase tracked kicker；本阶段没有越界重写 OS 控件、共享组件和应用布局。
- 验证：Linux service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；依赖锁检查覆盖 Python 3.11–3.14 与测试/Proxy_pool/CPU/CUDA 路径；`git diff --check` 通过。OpenAPI 仍为 50 paths/61 operations、61 条业务 route 和唯一 `/ui` mount。`uv 0.12.3` 隔离构建 wheel 后 103/103 个 WebUI 成员与源精确一致；`noise.svg` 恰好 1 份、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`，wheel 解包同源请求为 200 `image/svg+xml` 且字节一致。`app.py`、`pyproject.toml`、requirements 和 coverage baseline 未变。
- 覆盖率：core line/branch/function `90.699307% / 78.266428% / 91.897436%`；apps `76.503844% / 65.354331% / 68.341709%`；components `27.427938% / 76.126878% / 61.087866%`，全部通过既有 floor。
- 浏览器验收：Chromium 150/CDP 在 `/tmp/imageweave-nocturne-t4/` 保存六场景各一张 `1440×900` 裸桌面、`800×560` 普通窗口、最大化窗口、`1180×720`、`1179×719` blocker、1440×900 物理视口的 125%/150% 等效缩放、prefers-contrast、forced-colors 及汇总证据。computed style 确认根 `dark`、正文 80% 白、每场景 2–3 个 radial、噪点唯一且 2.5%/不可交互、窗口 `rgba(... / 0.08)` + `blur(60px) saturate(1.8)` + 方向阴影、500ms spring；reduced-motion 与实际 `data-motion="off"` 都得到 `transition/animation: none`。Chromium 可可靠模拟 forced-colors，实测渐变/噪点/阴影/backdrop 全部移除并改用系统色；全程远程请求 0、loading failure 0、非预期 console/log/exception 0。与 T0/T3 截图人工对比后确认平面底色已变为深墨定向光井，噪点克制且正文可读。headless 日志有 1 次 `ContextResult::kTransientFailure` GPU warning，已记录但不冒充 T11 性能结论。
- 剩余风险：T5 仍须正式收口 Menu、窗口标题栏/交通灯、Dock、应用中心与菜单浮层的 hover/active/阴影细节；T6–T9 仍负责淘汰应用 CSS 中按旧名字书写的实色 fallback、着色状态填充、单侧粗条和重复 kicker。当前 canonical alias 已让正常浏览器中的旧 `*-solid` 消费者呈现中性低透明表面，但源码级遗留契约保持 red，不能把 alias 视为最终组件清理。60px backdrop 与单全局噪点的合成边界已受控，真实 GPU 性能仍留待 T11 非 headless 验收。

### 实施记录：T5 OS 壳层

- 完成日期：2026-08-14
- 阶段：T5 OS 壳层
- 提交：见本阶段独立提交
- 行为变化：只在 `desktop.css` 正式迁移既有 OS 壳层；菜单栏改为 8% 中性玻璃、40px blur、10% 底边、顶高光/底暗缘与方向深影，菜单浮层、应用中心、Dock 和 overflow 各自使用单层 60px 中性玻璃。窗口保持 `800×560`、24px、8% 表面和单一 60px backdrop，标题栏改为 4% 无色行；focused 仅以 35% 边缘、深影和 18% 香槟辉光增强，background 正文与 8% 表面不降透明度；最大化仍为工作区直角。交通灯继续使用原 DOM/ARIA/action，30px 透明命中区内只有 13px 红黄绿点，hover 显示符号，disabled 用 ARIA、透明点和 `×` 非颜色提示，focus-visible 使用 3px 香槟环。应用中心/菜单项降为 4% 行、hover 10%–12%，分组标题取消 uppercase/tracking。Dock 保留四状态文字和运行点，focused 用细金边/2px 底标，minimized 用空心点/边缘/文字；删除邻项放大和 hover 位移，active 才 `scale(.97)`。壳层正常路径旧 `surface-*-solid` 引用由 6 降至 0，Dock hover 放大声明由 1 降至 0；能力回退的 canonical `fallback-*-solid` token 保留。既有 HTML 已具备 focused/maximized/interacting/hidden/Dock state marker，既有三个组件已具备 ARIA、键盘、trap 和焦点返回，因此未修改 `index.html`、`menu-bar.js`、`application-center.js`、`taskbar-windows.js` 或 window manager，也未触碰 Store/Router/action/z-order/geometry/registry。
- 测试：新增 Python `test_nocturne_os_shell_visual_contract`，严格覆盖中性 alpha/blur/阴影、单 backdrop、30/13px 交通灯、disabled 非颜色提示、应用中心/菜单行、Dock 四状态、无 hover transform、唯一 active scale、motion/fallback/forced-colors 和隐藏层；Phase 2 Node 静态断言只校正为等价且更精确的 grouped motion-off selector，T1 目标未放宽。固定 Node v24.13.0 正式 runner 为 305/305 pass；`tests.test_webui_modules` 为 17/17，`tests.test_api` 为 72/72。standalone nocturne 仍为 15 pass/1 个预期 `[legacy visual]` red：red 分组数为 1→1，且该扫描的四类计数仍为 opaque 175、tinted status 12、one-sided bars 8、tracked kickers 9；原因是 T4 扫描已排除“后接合法透明声明”的壳层 solid fallback，当前剩余定位均在 T6 共享 controls/dialog 或 T7/T8 应用 CSS，T5 没有为制造计数下降而越界修改。
- 验证：Linux service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；依赖锁检查覆盖 Python 3.11–3.14 与测试/Proxy_pool/CPU/CUDA 路径；`git diff --check` 通过。OpenAPI 保持 50 paths/61 operations，61 个业务 operation 与唯一 `/ui` mount 不变；`noise.svg` 仍同源 200 `image/svg+xml`、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`。`app.py`、后端业务源码、`pyproject.toml`、requirements 与 `scripts/coverage-baselines.json` 未改且受保护文件 hash 与 T5 前一致。
- 覆盖率：core line/branch/function `90.699307% / 78.266428% / 91.897436%`；apps `76.503844% / 65.354331% / 68.341709%`；components `27.427938% / 76.126878% / 61.087866%`，全部通过既有 floor。
- 浏览器验收：Chromium 150/CDP 在 `/tmp/imageweave-nocturne-t5/` 保存 10 张截图和结构化证据，`1440×900` 与 `1180×720` 共 62/62 断言通过。真实路径覆盖裸桌面、菜单键盘 Arrow/Home/End/Escape 与 focus return、应用中心 Tab trap/Escape/focus return、单目标深链接、普通窗口、真实 pointer drag/resize、最大化/恢复、交通灯三 action 与键盘 focus、Dock closed/focused/background/minimized 的动作和 overflow。computed style 实测 Menu `8% + blur(40px) saturate(1.8)`，Window `8% + blur(60px) saturate(1.8)`，focused 为 18% 香槟 glow，Dock `10% + 60px`；drag/resize 期间 marker 分别为 `drag/resize`、`transition:none`、`box-shadow:none` 且几何即时变化，恢复后保留 `216,130,872,606`；hover 后全部 Dock transform 为 `none` 且邻项 rect 不变，按下仅为 `matrix(0.970033, ...)`。最小化窗口、已关闭菜单/应用中心/overflow computed backdrop 均为 `none`，closed 窗口 DOM 被移除；真实偏好 `data-motion=off`、emulated reduced-motion/forced-colors 均去除非必要 transition/transform，forced-colors 同时去除噪点、阴影和 backdrop。disabled 交通灯无自然桌面触发条件，验收只在现有 tests-only harness 内临时切换既有 `disabled/aria-disabled` 后立即恢复，未注入生产状态。远程请求、非预期 loading failure/HTTP error、console error/assert、runtime exception 和非预期 log 均为 0；最小化 Proxy 按既有生命周期主动取消 `/api/v1/proxy/status`，记录 1 个预期 `ERR_ABORTED`，不是 HTTP/运行时错误。与 T4 graphite/窗口截图人工对比确认 Menu、窗口边缘、浮层和 Dock 已统一为无色定向玻璃，正文可读且没有大面积金色/状态色；本次 headless 日志未复现 T4 的 `ContextResult::kTransientFailure`，T4 的 1 次 GPU warning 仍只作为已知 headless 记录，不能替代 T11 真机性能结论。
- 剩余风险：T6 必须继续清理 shared controls/status/dialog 的实色命名、危险/禁用着色表面和嵌套卡片，但不得改变本阶段 shell selector、单 backdrop、键盘/focus 或直接操控契约；T7/T8 才能处理 175 个 opaque 应用表面、8 个应用单侧粗条和 9 个重复 kicker。T5 未做真机 GPU 性能结论，60px 多窗口叠放的最终合成性能仍归 T11。

### 实施记录：T6 共享组件

- 完成日期：2026-08-14
- 阶段：T6 共享组件
- 提交：见本阶段独立提交
- 行为变化：只迁移 `controls.css`、`status.css` 与 `dialog.css`，未修改任何生产 JS，`status.js`、`empty-state.js`、`error-view.js`、`dialog.js` 的公开导出、DOM 结构、焦点 trap/return、Escape、确认/取消、危险确认和单飞语义保持不变。普通动作统一为 10% 中性白、20% 完整边缘、16px、方向阴影与 500ms spring，hover 为最高 15%/35%/`translateY(-2px)`，active 为 `scale(.97)`；导航行显式不位移。Primary 只用香槟细边和 `#F3DCA8` 文本，danger 只用语义文字与完整 2px 边缘。Disabled 不再降低整体 opacity，使用完整内边缘、删除线/斜体、原生/ARIA 状态和现有可读 reason 作为非颜色说明，且无 hover/active transform。文本/search/password/number/select/textarea 统一为 6% 中性白、15% 边缘、16px、方向 inset、白/35 placeholder 与 500ms spring；focus 为 35% 边缘、10% 表面、3px/18% 香槟 ring，invalid 保持中性填充并用完整 2px 语义边缘、`aria-invalid`、alert/描述理由，disabled 仍可读。Checkbox/radio/range/progress 保留系统控件例外和可见焦点。按钮、输入、status、empty/error 内部行继承应用窗口的唯一 60px backdrop，不重复建立普通行合成层。
- 行为变化（状态与 Dialog）：五种 status badge 全部保留独立文本图标、邻接标签与 ARIA label，填充统一为 5% 中性玻璃，语义色只用于图标/文字/完整 1–2px 边缘；empty/error 分别使用 5%/8% 中性玻璃、完整边缘、图标、标题、理由和下一步，删除共享范围 3px/4px 单侧 inset 与外层嵌套卡片阴影。Dialog 改为独立 8% 顶层玻璃、顶向 12% 高光、15% 边缘、24px、方向大阴影和 `blur(60px) saturate(180%)`；backdrop 为可透视的深墨 68% 与固定 8px 模糊，内部 panel/action/copy 不重复 backdrop。危险 Dialog 和确认说明只使用完整红色细边、文字与“警告”非颜色文案，不使用着色填充。能力不支持、高对比、forced-colors、motion off 与 reduced-motion 继续消费 T4 canonical token/系统色；无 backdrop fallback 只保留 canonical `fallback-elevated-solid`。
- 测试：正式 Node 新增 T6 静态契约和共享 status/empty/error DOM/ARIA/销毁生命周期覆盖，总计 307/307；Python `tests.test_webui_modules` 新增精确共享视觉/API 边界契约并更新等价 motion 静态断言，总计 18/18；`tests.test_api` 只把旧 `0.001ms` motion 断言收紧为 `animation/transition: none`，72/72。Stage 6 的“无 double/dotted/dashed 旧装饰边框”断言继续原样通过；未删除或放宽 T1 夜航目标。Standalone nocturne 仍为 15 pass/1 个预期 `[legacy visual]` red：opaque `175→174`、tinted status `12→0`、one-sided `8→8`、tracked kicker `9→9`。剩余 174 个 opaque 全部在 11 个 `styles/apps/*.css`；8 个单侧条只在 Proxy 3、Vault 3、Diagnostics 2；9 个 kicker 分别在 Crawl、Tasks、Proxy、Vault、Policy、Diagnostics、Gallery、Schedule、Export。
- 验证：固定 Node v24.13.0 正式 coverage runner 为 307 pass、0 fail、0 skipped；`tests.test_webui_modules` 18/18、`tests.test_api` 72/72；Linux service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；依赖锁覆盖 Python 3.11–3.14 与测试/Proxy_pool/CPU/CUDA 路径，`git diff --check` 通过。OpenAPI 保持 50 paths/61 operations、61 条业务 route 和唯一 `/ui` StaticFiles mount；`noise.svg` 浏览器请求为 200 `image/svg+xml`。`app.py`、业务后端、`pyproject.toml`、requirements 与 `scripts/coverage-baselines.json` 的 SHA-256 全部保持 T5 值。
- 覆盖率：core line/branch/function `90.708081% / 78.297546% / 91.897436%`；apps `76.503844% / 65.354331% / 68.341709%`；components `27.949002% / 77.250409% / 61.825726%`，全部通过既有 floor；新增组件行为覆盖使 components line/branch/function 均高于 T5。
- 浏览器验收：Chromium 150/CDP 在 `1440×900` 对 Crawl、Tasks、Vault、Dialog 与 forced-colors 保存 6 张截图，77/77 断言通过；computed style 实测普通/primary/danger/disabled 的 base/hover/active/focus，search/password/number/select/textarea 的 placeholder/focus/invalid/disabled，五种 status、Crawl/Tasks/Vault 的 5% status panel、empty/error、Dialog/backdrop 及父窗口单 backdrop。真实 Dialog 完成 Tab/Shift+Tab 双向 trap、Escape、取消、危险确认、单飞拒绝与三条 focus return。实际持久化 `data-motion=off`、emulated reduced-motion、prefers-contrast 与 forced-colors 全部通过；tests-only 类型/状态矩阵带 `data-t6-tests-only`、位于所有生产 app closure 外、结束前调用真实 error `destroy()` 并移除，未写入仓库或生产 import graph。远程请求、非预期 HTTP、loading failure、console error/assert、runtime exception 和非预期 log 均为 0。另用 T5 正式 shell 脚本回归 `1440×900`/`1180×720`、Menu、应用中心、窗口 drag/resize/maximize/restore、交通灯与 Dock 四状态，62/62 通过；仅 `/api/v1/proxy/status` 与 `/api/v1/proxy/sources` 两个最小化 Proxy 生命周期预期 `ERR_ABORTED`，非 HTTP/运行时错误。证据位于 `/tmp/imageweave-nocturne-t6/`。
- 剩余风险：T7/T8 仍须在各自 app CSS 中迁移 174 个旧 opaque 表面、8 个单侧粗条、9 个 uppercase tracked kicker，以及应用级表格、嵌套卡片和窄窗口内容密度；T6 不为让 standalone 全绿而越界修改这些文件。当前普通内部控件依赖父窗口单一 60px backdrop，避免每行建立 40px 合成层；多窗口叠放的真机 GPU 性能和最终 WCAG/缩放全矩阵仍归 T11。

### 实施记录：T7.1 Crawl

- 完成日期：2026-08-15
- 阶段：T7.1 Crawl 应用迁移
- 提交：见本阶段独立提交
- 行为变化：生产修改仅限 `styles/apps/crawl.css`，没有修改 Crawl controller/view/model、Store、Router、window manager、其他 app CSS 或后端。来源/搜索/创建三栏继续使用原语义 DOM、普通窗口真实横向滚动、最大化三栏同屏和每栏独立纵向滚动；工作区与列内容统一为 24px 节奏。三列改为 5%–6% 中性玻璃、完整 15% 边缘、24px 圆角和继承窗口模糊，source/candidate/result/summary/fact 改为 4%–6% 弱行、10% 分隔、16px 圆角、无外阴影/backdrop。Autocomplete 列表和创建 footer 改为正常文档流，避免低透明浮层覆盖正文。主搜索/创建动作完全回归 T6 shared controls 的 10% 中性表面、香槟细边与高亮文字；候选/source active 使用 checked/`aria-current`、完整 35% 边缘和 `◆` 非颜色 marker。running/partial/error、授权、代理、弱证据、来源失败和 validation 使用中性 5%–8% 填充、图标/文字及完整语义边缘，关键理由为白色/80 以上；图片路径没有滤镜。Crawl 正常路径 27 个旧 opaque/`*-solid` 引用和 1 个 tracked kicker 均清零，两个旧 3px 单侧 inset selected marker 也删除；无独立内部 backdrop，窗口仍是唯一 60px app 合成层。Capability fallback 只在 `@supports not` 消费 canonical `fallback-elevated-solid`，并保留 contrast、motion off、reduced-motion 与 forced-colors 路径。
- 测试：Stage 3 Node 的 CSS 契约由旧布局存在性断言收紧为 T7.1 精确 alpha/边缘/radius/扁平化/shared primary/状态/marker/motion/fallback 契约，既有 19 项 model/store/controller/view/API/lifecycle 行为断言原样保留，定向结果 20/20；Python 新增同等 Crawl 静态契约，`tests.test_webui_modules` 为 19/19。`tests.test_stage3_webui_harness + tests.test_crawl` 为 7/7，`tests.test_api` 为 72/72。固定 Node v24.13.0 正式 runner 为 307/307、0 fail、0 skipped。Standalone nocturne 仍为 15 pass/1 个预期 `[legacy visual]` red：Crawl opaque `27→0`、tracked kicker `1→0`，全局 opaque `174→147`、tinted status `0`、one-sided `8`、tracked kicker `9→8`；独立明细确认 Crawl 四类均为 0，未放宽 T1 扫描或 coverage floor。
- 验证：Linux service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；依赖锁覆盖 Python 3.11–3.14 与测试/Proxy_pool/CPU/CUDA 路径，`git diff --check` 通过。OpenAPI 保持 50 paths/61 operations、61 条业务 route 和唯一 `/ui` StaticFiles mount；`noise.svg` 为 200 `image/svg+xml`、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`。`app.py`、Crawl/ordered-crawl 后端、`pyproject.toml`、requirements 与 `scripts/coverage-baselines.json` 的 SHA-256 均与 T7.1 前一致。
- 覆盖率：core line/branch/function `90.708081% / 78.297546% / 91.897436%`；apps `76.503844% / 65.354331% / 68.341709%`；components `27.949002% / 77.250409% / 61.825726%`，全部通过原 floor 且与 T6 一致；本阶段没有生产 JS/DOM 变化，新增内容为静态契约。
- 浏览器验收：Chromium 150/CDP 通过真实 `create_app`、正式 `/ui/`、API client、Pydantic route、crawl repository 与 SQLite，只在既有 tests-only discovery adapter/后台执行边界使用受控 fixture；85/85 断言和 16 张截图保存在 `/tmp/imageweave-nocturne-t71/`。矩阵覆盖 `1440×900`、`1180×720`、普通 `800×560`、最大化及 `1179×719` blocker；实测普通 workspace 横向可滚、最大化三栏同屏、三个 column scroll owner 均为 `overflow-y:auto`。覆盖 autocomplete 300ms/URL encode/stale abort/Arrow/Home/End/Enter，loading/partial/content/empty/error/recovery，授权/代理、弱证据与来源失败，来源/候选排序和焦点 token，EH include/exclude/筛选外已选及 `resample+stop`，search/create invalid 的 focus/ARIA/0 请求，以及 minimize cancel、close/unmount/reopen stale-safe 生命周期。真实 create 精确发送 1 个带 `Idempotency-Key` 的 POST，payload 为 source 顺序 `danbooru,pawchive,exhentai`、Pawchive 地址重排、concurrency 7、max_tasks 321、proxy `prefer`、EH `resample+stop`、output `t71-output`；SQLite 事实逐项一致，随后仅 1 个 Tasks 窗口被打开/聚焦且 output 清空。Computed style 确认列 5%–6%/24px/完整 15%，内部行 4%–6%/16px/无 backdrop 外影，primary 10% + 完整香槟边，selected 6% + 完整 35%，Crawl window 内附加 backdrop 层为 0；AX tree/DOM 解析三栏、combobox、validation 与 submit reason 名称。`data-motion=off`、reduced-motion、prefers-contrast、forced-colors 均通过，unsupported backdrop 由静态契约覆盖。浏览器远程请求 0、fixture 请求 0、非预期 HTTP/loading failure 0、console error/assert 0、runtime exception 0、非预期 browser log 0；唯一 422 和 3 个 `ERR_ABORTED` 分别是受控 backend fault 与 autocomplete/minimize/close 取消证据。
- 剩余风险：T7.2 Tasks 是下一阶段，当前精确剩余为 `tasks.css` opaque 19、tracked kicker 1、one-sided 0；不得用 Crawl 规则越界覆盖。全局其余 147 个 opaque、8 个单侧条和 8 个 kicker 分布在 Tasks/Proxy/Vault/Policy/Diagnostics/Personalization/Review 与三个 preview app，须继续按 T7/T8 顺序迁移。当前验收为 headless Chromium；进程日志出现一次既有 `ContextResult::kTransientFailure` GPU warning，但应用 network/console/runtime 与 85 项验收均为 0 异常，真实多窗口 GPU 性能仍归 T11。

### 实施记录：T7.2 Tasks

- 完成日期：2026-08-15
- 阶段：T7.2 Tasks 应用迁移
- 提交：见本阶段独立提交
- 行为变化：生产修改仅限 `styles/apps/tasks.css`，没有修改 Tasks controller/view/model、Store、Router、window manager、其他 app CSS 或后端。最近批次/事实/恢复三栏继续使用原语义 DOM；普通 `800×560` 窗口真实横向滚动，最大化三栏同屏，每栏继续独立纵向滚动，任务表格继续由自身横向 scroll owner 承担 `790px` 宽表。工作区与列使用 24px 节奏；三列为 5%–6% 中性玻璃、完整 15% 边缘、24px 圆角和仅顶/底 inset 光学边缘，内部 metric/source/address/table/fact/recovery 为 4%–5% 弱行、10% 分隔、16px 圆角、无外阴影或独立 backdrop。事实值统一为白色/85 等宽；source/address 标题与辅助说明分层。当前批次、当前地址和原生 selected option 同时保留可读文本、status 图标/ARIA、完整 35% 边缘、下划线或 `◆` marker，不使用单侧色条或大面积语义色。loading/writing/content/partial/terminal/error 继续由既有 T6 badge、文字、完整语义边缘及 5%–8% 中性表面表达；关键错误和操作说明为白色/80 以上。按钮完全复用 T6 shared controls；普通行 hover 不位移缩放，表格 hover 为 8%，状态和行过渡为 500ms spring。Tasks 原有 19 个 opaque/`*-solid` 正常表面和 1 个 uppercase tracked kicker 清零；唯一 `fallback-elevated-solid` 只存在于 no-backdrop capability fallback，Tasks 内部附加 backdrop 层为 0。
- 测试：Stage 4 real-app Node CSS 契约由旧 alias 存在性断言收紧为 T7.2 alpha/完整边缘/radius/扁平化/事实层级/当前 marker/表格 scroll/shared controls/motion/fallback 精确契约；原有 model/Store/controller/view/API/request-gate/lifecycle 断言全部保留，并新增 cancel/rerun 精确空 payload、危险确认及各自 detail/tasks/recent 权威重读，定向 Stage 4 为 56/56。Python 新增同等 Tasks 静态/API 边界契约，`tests.test_webui_modules` 为 20/20；`tests.test_api` 为 72/72；database/transaction 54/54、scheduler/attempt/decision/facade 49/49、crawl/Stage 3 harness/routing/origin 22/22。固定 Node v24.13.0 正式 runner 为 308/308、0 fail、0 skipped。Standalone nocturne 保持 15 pass/1 个预期 `[legacy visual]` red：Tasks opaque `19→0`、tinted status `0`、one-sided `0`、tracked kicker `1→0`；全局 opaque `147→128`、tinted status `0`、one-sided `8`、tracked kicker `8→7`，T1 扫描和 coverage floor 均未放宽。
- 验证：Linux service smoke 为 `healthz=200`、禁用去重 `readyz=200`、缺模型 `readyz=503`；依赖锁覆盖 Python 3.11–3.14 与测试/Proxy_pool/CPU/CUDA 路径；`git diff --check` 通过。OpenAPI 保持 50 paths/61 operations、61 条业务 route 和唯一 `/ui` StaticFiles mount；`noise.svg` 为 200 `image/svg+xml`、497 bytes、SHA-256 `9a525197b6bc88f7a64d8746a50f04aa64f29f08d06d57c3e69514b6db083529`。`app.py`、Tasks API/repository 业务后端、`pyproject.toml`、requirements 与 `scripts/coverage-baselines.json` 均与 T7.2 前逐文件一致。Crawl T7.1、T5 shell 与 T6 shared 定向 Node 回归 38/38。
- 覆盖率：core line/branch/function `90.708081% / 78.297546% / 91.897436%`；apps `76.956128% / 65.658537% / 68.922306%`；components `27.949002% / 77.250409% / 61.825726%`，全部通过原 floor；apps 指标提升来自新增 cancel/rerun 权威重读行为覆盖，生产 JS/DOM 未变。
- 浏览器验收：Chromium 150/CDP 使用正式 `create_app` 静态入口、正式 API client/Tasks controller/view/model/Store/Router/polling/window 生命周期，仅在 tests-only HTTP 边界提供可控安全 Tasks 响应；`1440×900`、`1180×720`、普通 `800×560` 和最大化共 71/71 断言、15 张截图，证据位于 `/tmp/imageweave-nocturne-t72/`。实际覆盖 empty/loading/content/error、最近批次选中、metric/source/address/table、表格与工作区横向滚动、三列纵向 owner、1.5 秒 running poll 更新、cancel/retry/rerun 三种真实确认与精确 payload、每次写后 detail/tasks/recent GET、延迟旧 running 响应不覆盖较新 terminal、minimize/deactivate 和 close/unmount 2.2 秒零请求及 reopen 重读恢复。Computed style 确认列 5%–6%/24px/完整 15%，事实行 4%–5%/16px/无外影/backdrop，事实值白色/85 等宽，current 完整 35% 边缘与 `◆` marker，表头/hover 8%，窗口为唯一 app 60px backdrop；DOM/AX tree 解析三栏、listbox/option、status、table、buttons 和 current address 名称。实际持久化 `data-motion=off`、emulated reduced-motion、prefers-contrast 与 forced-colors 均通过；unsupported backdrop 由双静态契约覆盖。浏览器远程请求 0、生产 fixture 请求/引用 0、非预期 HTTP/loading failure 0、console error/assert 0、runtime exception 0、非预期 log 0；唯一 503 和 1 个 `ERR_ABORTED` 分别是受控 error 与 stale poll 取消证据。最终 Chromium 进程日志未出现 GPU warning；迭代验收曾记录 1 次既有 `ContextResult::kTransientFailure`，未进入应用 console/runtime/network，仍不能替代 T11 真机 GPU 验收。
- 剩余风险：下一阶段 T7.3 应先迁移 Proxy（当前 opaque 18、单侧粗条 3、tracked kicker 1），再迁移 Vault（opaque 15、单侧粗条 3、tracked kicker 1）。Proxy 的 10 秒轮询、status/sources 并发与 stale gate、start/stop/reload/probe、source 保存/删除、写后双权威重读、秘密即时清理和脱敏投影比 Tasks 视觉面更易受卡片扁平化影响；不得用大面积代理状态色、单侧错误条或 tests-only source fixture 换取视觉通过。全局剩余 128 个 opaque、8 个单侧条和 7 个 kicker 必须继续按 T7/T8 顺序处理；多窗口叠放的真机 GPU 性能与完整缩放/WCAG 矩阵仍归 T11。
