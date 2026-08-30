import { installMockApi } from "./fixtures/mock-api";
import {
  bootDesktop,
  closeApp,
  expect,
  expectDesktopInsideViewport,
  expectWindowInsideWorkspace,
  launchApp,
  maximizeApp,
  test,
} from "./fixtures/test";

const APPLICATIONS = [
  "crawl",
  "tasks",
  "proxy",
  "vault",
  "review",
  "policy",
  "diagnostics",
  "personalization",
  "gallery",
] as const;

test.describe("桌面壳层", () => {
  test("启动门显示真实连接阶段并处理健康检查失败", async ({ page }) => {
    await installMockApi(page, { health: "failed" });
    let releaseHealth: () => void = () => {};
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = () => resolve();
    });
    await page.route("**/healthz", async (route) => {
      await healthGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          components: { process: { status: "error" }, database: { status: "ok" } },
          time: 1_700_000_000,
        }),
      });
    });

    try {
      await page.goto("/");
      await expect(page.locator("[data-startup-phase=\"starting\"]")).toBeVisible();
    } finally {
      releaseHealth();
    }
    await expect(page.locator("[data-startup-phase=\"failed\"]")).toBeVisible();
    await expect(page.getByRole("heading", { name: "桌面宿主暂时不可用" })).toBeVisible();
    await expect(page.getByText("请求失败（HTTP 503）")).toBeVisible();
  });

  test("应用中心列出并能真实挂载全部九个应用", async ({ page }) => {
    const api = await bootDesktop(page);
    await page.keyboard.press("Control+o");
    const center = page.locator("[data-application-center]");
    await expect(center).toBeVisible();
    await expect(center.locator("[data-application-center-app]")).toHaveCount(APPLICATIONS.length);
    await page.keyboard.press("Escape");
    await expect(center).toHaveCount(0);

    for (const appId of APPLICATIONS) {
      await launchApp(page, appId);
      await expectWindowInsideWorkspace(page, appId);
      await expectDesktopInsideViewport(page);
      await closeApp(page, appId);
    }

    expect(api.unhandled, "每个应用发出的 API 都必须有显式 mock，不能用兜底响应掩盖接口漂移").toEqual([]);
  });

  test("菜单支持键盘导航、激活与焦点恢复", async ({ page }) => {
    await bootDesktop(page);
    const fileMenu = page.locator("[data-menu-trigger=\"file\"]");
    await fileMenu.focus();
    await page.keyboard.press("ArrowDown");
    const command = page.getByRole("menuitem", { name: /打开应用中心/ });
    await expect(command).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-application-center]")).toBeVisible();
    await expect(page.locator("[data-application-center-app]").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(fileMenu).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-menu-trigger=\"edit\"]")).toBeFocused();
  });

  test("About展示LDOS品牌信息并恢复菜单焦点", async ({ page }) => {
    await bootDesktop(page);
    const helpMenu = page.locator('[data-menu-trigger="help"]');
    await helpMenu.click();
    await page.getByRole("menuitem", { name: /关于 LDOS/ }).click();

    const about = page.locator("[data-about-dialog]");
    await expect(about).toBeVisible();
    await expect(about).toContainText("LoRA Dataset Operating System");
    await expect(about).toContainText("The operating workspace for LoRA datasets.");

    await page.keyboard.press("Escape");
    await expect(about).toHaveCount(0);
    await expect(helpMenu).toBeFocused();
  });

  test("窗口可拖动、键盘缩放、最大化、最小化、恢复和关闭", async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, "crawl");
    const window = page.locator("[data-app-window][data-app-id=\"crawl\"]");
    const beforeMove = await window.boundingBox();
    expect(beforeMove).not.toBeNull();
    const titlebar = window.locator("[data-window-titlebar]");
    const titlebarBox = await titlebar.boundingBox();
    expect(titlebarBox).not.toBeNull();
    if (titlebarBox) {
      await page.mouse.move(titlebarBox.x + titlebarBox.width / 2, titlebarBox.y + titlebarBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(titlebarBox.x + titlebarBox.width / 2 + 55, titlebarBox.y + titlebarBox.height / 2 + 35, { steps: 4 });
      await page.mouse.up();
    }
    const afterMove = await window.boundingBox();
    expect(afterMove).not.toBeNull();
    if (beforeMove && afterMove) expect(afterMove.x).toBeGreaterThan(beforeMove.x);

    const resize = window.locator("[data-resize=\"right\"]");
    const widthBefore = (await window.boundingBox())?.width ?? 0;
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    expect((await window.boundingBox())?.width ?? 0).toBeGreaterThan(widthBefore);

    await window.getByRole("button", { name: "最大化窗口" }).click();
    await expect(window).toHaveAttribute("data-window-state", "maximized");
    await window.getByRole("button", { name: "还原窗口" }).click();
    await expect(window).toHaveAttribute("data-window-state", "normal");

    await window.getByRole("button", { name: "最小化窗口" }).click();
    await expect(window).toHaveCount(0);
    const dockItem = page.locator("[data-dock-item=\"app:crawl\"]");
    await expect(dockItem).toHaveAttribute("data-dock-state", "minimized");
    await dockItem.click();
    await expect(window).toBeVisible();
    await closeApp(page, "crawl");
  });

  test("有未保存设置时关闭会拦截，取消和确认路径都可靠", async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, "personalization");
    const window = page.locator("[data-app-window][data-app-id=\"personalization\"]");
    await window.locator("[data-personalization-scene]:not([data-personalization-selected=\"true\"])").first().click();
    await window.getByRole("button", { name: "关闭窗口" }).click();
    const dialog = page.locator("[data-shell-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "关闭窗口？" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(window).toBeVisible();

    await window.getByRole("button", { name: "关闭窗口" }).click();
    await dialog.getByRole("button", { name: "放弃并关闭" }).click();
    await expect(window).toHaveCount(0);
  });

  test("低于 1180×720 时只显示明确尺寸阻断提示，恢复尺寸后可继续", async ({ page }) => {
    await page.setViewportSize({ width: 1179, height: 719 });
    await installMockApi(page);
    await page.goto("/");
    const blocker = page.getByRole("alert");
    await expect(blocker.getByRole("heading", { name: "请使用更大的桌面窗口" })).toBeVisible();
    await expect(blocker).toContainText("1180 × 720");

    await page.setViewportSize({ width: 1180, height: 720 });
    await expect(blocker).toBeHidden();
    await expect(page.locator("[data-menu-bar]")).toBeVisible();
  });

  test("canonical /ui/ 入口挂载同一桌面而非第二套界面", async ({ page }) => {
    const api = await bootDesktop(page, {}, "/ui/");
    await expect(page).toHaveURL(/\/ui\/$/);
    await launchApp(page, "diagnostics");
    await expect(page.locator("[data-diagnostics-app]")).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("最小支持视口下全部应用保持在工作区内且横向内容可键盘滚动", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 720 });
    const api = await bootDesktop(page);

    for (const appId of APPLICATIONS) {
      await launchApp(page, appId);
      await maximizeApp(page, appId);
      await expectWindowInsideWorkspace(page, appId);
      await expectDesktopInsideViewport(page);
      const window = page.locator(`[data-app-window][data-app-id="${appId}"]`);
      await expect(window.getByRole("button", { name: "还原窗口" })).toBeVisible();

      const workspace = window.locator('section[tabindex="0"]').first();
      if (await workspace.count()) {
        const metrics = await workspace.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        if (metrics.scrollWidth > metrics.clientWidth) {
          await workspace.focus();
          await page.keyboard.press("ArrowRight");
          await expect.poll(() => workspace.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        }
      }

      await closeApp(page, appId);
    }

    expect(api.unhandled).toEqual([]);
  });
});
