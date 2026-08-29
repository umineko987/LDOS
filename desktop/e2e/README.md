# ImageWeave GUI E2E

这组测试通过 Playwright 驱动 canonical Svelte GUI。浏览器访问的 API 由 `fixtures/mock-api.ts` 确定性模拟，因此可以稳定覆盖成功、空结果和错误状态，不读取或修改真实下载、凭据、代理及审核数据。

## 运行

```bash
cd desktop
npm ci
npx playwright install chromium   # 首次运行或 CI
npm run test:e2e
```

Linux 本机若已有 `/usr/bin/chromium`，配置会直接复用；也可设置 `IMAGEWEAVE_CHROMIUM_PATH=/path/to/chromium`。调试可运行 `npm run test:e2e:headed` 或 `npm run test:e2e:ui`。

## 测试层

- `shell.spec.ts`：启动门、应用中心、菜单、窗口拖动/缩放/最小化/最大化、关闭确认、最小支持视口和 `/ui/` 入口。
- `apps.spec.ts`：九个应用的关键操作、请求载荷、空状态、服务失败、危险操作和 Preview 能力边界。
- `accessibility.spec.ts`：桌面、应用中心和九个最大化应用的 WCAG 2 A/AA axe 扫描。
- `visual.spec.ts`：应用中心和九个应用丰富状态的 Linux Chromium 截图基线。

只更新视觉基线时先检查实际差异，再执行：

```bash
cd desktop
npm run test:e2e -- visual.spec.ts --update-snapshots
```

## 边界

- Playwright 覆盖真实 DOM、CSS、鼠标、键盘、焦点、网络状态及 Chromium 可访问性树。
- `/ui/` 与 Tauri 使用同一 canonical 前端，因此业务 UI 用例共用；这不等于验证了 Linux/macOS/Windows WebView 宿主差异。
- Tauri 启动、Python sidecar 和系统 WebView 仍由打包/宿主 smoke 独立验证，不从 Chromium 结果推断。
