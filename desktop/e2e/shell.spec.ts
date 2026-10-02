import { APPLICATIONS, appPage, prepareRichState } from "./fixtures/app-state";
import { installMockApi } from "./fixtures/mock-api";
import {
  bootDesktop,
  expect,
  expectDesktopInsideViewport,
  expectPageInsideWorkspace,
  launchApp,
  test,
} from "./fixtures/test";

async function expectOnlyCurrentPage(page: Parameters<typeof bootDesktop>[0], appId: string): Promise<void> {
  await expect(page.locator("[data-app-page]:visible")).toHaveCount(1);
  await expect(appPage(page, appId)).toBeVisible();
  await expect(appPage(page, appId)).not.toHaveAttribute("inert");
  for (const inactive of await page.locator(`[data-app-page]:not([data-app-id="${appId}"])`).all()) {
    await expect(inactive).toBeHidden();
    await expect(inactive).toHaveAttribute("hidden", "");
    await expect(inactive).toHaveAttribute("inert", "");
  }
}

test.describe("工作台壳层", () => {
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
      await expect(page.locator('[data-startup-phase="starting"]')).toBeVisible();
    } finally {
      releaseHealth();
    }
    await expect(page.locator('[data-startup-phase="failed"]')).toBeVisible();
    await expect(page.getByText("请求失败（HTTP 503）")).toBeVisible();
  });

  test("默认采集，导航可达全部九页且仅当前页可见，已访问页保持挂载", async ({ page }) => {
    const api = await bootDesktop(page);
    await expect(page).toHaveURL(/#\/crawl$/);
    await expectOnlyCurrentPage(page, "crawl");
    await expect(page.locator("[data-app-window], [data-window-state], [data-application-center]")).toHaveCount(0);
    await expect(page.locator('[data-nav-app="crawl"]')).toBeVisible();
    await expect(page.locator('[data-nav-app="tasks"]')).toBeVisible();
    await expect(page.locator('[data-nav-app="gallery"]')).toBeVisible();
    await expect(page.locator('[data-nav-app="review"]')).toBeVisible();

    const visited = new Set<string>();
    for (const appId of APPLICATIONS) {
      await launchApp(page, appId);
      visited.add(appId);
      await expectOnlyCurrentPage(page, appId);
      for (const visitedId of visited) await expect(appPage(page, visitedId)).toHaveCount(1);
      await expectPageInsideWorkspace(page, appId);
      await expectDesktopInsideViewport(page);
    }
    expect(api.unhandled, "业务 API 必须有显式 mock，不能用兜底响应掩盖接口漂移").toEqual([]);
  });

  test("设置入口默认代理，再次进入恢复最近设置页", async ({ page }) => {
    await bootDesktop(page);
    await page.locator("[data-nav-settings]").click();
    await expect(page).toHaveURL(/#\/proxy$/);
    await expectOnlyCurrentPage(page, "proxy");
    await launchApp(page, "policy");
    await launchApp(page, "gallery");
    await page.locator("[data-nav-settings]").click();
    await expect(page).toHaveURL(/#\/policy$/);
    await expectOnlyCurrentPage(page, "policy");
  });

  test("切页和浏览器前进后退保留采集输入", async ({ page }) => {
    await bootDesktop(page);
    const keyword = appPage(page, "crawl").locator("[data-crawl-keyword]");
    await keyword.fill("unsent collection draft");
    await launchApp(page, "tasks");
    await expect(keyword).toHaveValue("unsent collection draft");
    await page.goBack();
    await expect(page).toHaveURL(/#\/crawl$/);
    await expectOnlyCurrentPage(page, "crawl");
    await expect(keyword).toHaveValue("unsent collection draft");
    await page.goForward();
    await expect(page).toHaveURL(/#\/tasks$/);
    await expectOnlyCurrentPage(page, "tasks");
    await launchApp(page, "crawl");
    await expect(keyword).toHaveValue("unsent collection draft");
  });

  test("未保存站点设置和外观预览切页不要求放弃，后退仍保留草稿", async ({ page }) => {
    const api = await bootDesktop(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await launchApp(page, "policy");
    const concurrency = appPage(page, "policy").locator('[data-policy-field="max_concurrency"]');
    await expect(concurrency).toHaveValue("20");
    await concurrency.fill("16");
    await launchApp(page, "gallery");
    await expect(appPage(page, "policy")).toHaveAttribute("hidden", "");
    await page.goBack();
    await expectOnlyCurrentPage(page, "policy");
    await expect(concurrency).toHaveValue("16");
    await expect(appPage(page, "policy").locator('[data-dirty="true"]')).toBeVisible();
    expect(api.count("PUT", "/api/v1/sites/policies/danbooru")).toBe(0);

    await launchApp(page, "personalization");
    const appearance = appPage(page, "personalization");
    const scene = appearance.locator('label[data-personalization-scene]:not([data-personalization-selected="true"])').first();
    const sceneId = await scene.getAttribute("data-personalization-scene");
    await scene.click();
    await launchApp(page, "tasks");
    await page.goBack();
    await expectOnlyCurrentPage(page, "personalization");
    await expect(appearance.locator(`label[data-personalization-scene="${sceneId}"] input`)).toBeChecked();
    await expect(appearance.locator('[data-personalization-status="dirty"]')).toBeVisible();
    await expect(page.locator("[data-desktop]")).toHaveAttribute("data-scene", sceneId ?? "");
    await expect(page.locator("[data-shell-dialog]")).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
  });

  test("图库隐藏后不响应快捷键，返回仍保留选择", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    await prepareRichState(page, "gallery");
    const gallery = appPage(page, "gallery");
    const selected = gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" });
    await selected.check();
    await launchApp(page, "tasks");
    await appPage(page, "tasks").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("F2");
    await page.keyboard.press("Delete");
    await launchApp(page, "gallery");
    await expect(selected).toBeChecked();
    await expect(gallery.locator("[data-gallery-selection-summary]")).toContainText("1 张图片");
    await expect(gallery.locator('[role="dialog"], [role="alertdialog"], .gallery-dialog')).toHaveCount(0);
    await gallery.focus();
    await page.keyboard.press("Delete");
    await expect(gallery.getByRole("alertdialog", { name: "移入回收区", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery.getByRole("alertdialog")).toHaveCount(0);
    expect(api.unhandled).toEqual([]);
  });

  test("后台未保存设置阻止刷新，取消刷新后草稿仍在", async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, "policy");
    const concurrency = appPage(page, "policy").locator('[data-policy-field="max_concurrency"]');
    await expect(concurrency).toHaveValue("20");
    await concurrency.fill("16");
    await launchApp(page, "crawl");
    const dialog = page.waitForEvent("dialog");
    const reload = page.reload().catch(() => null);
    const warning = await dialog;
    expect(warning.type()).toBe("beforeunload");
    await warning.dismiss();
    await reload;
    await expectOnlyCurrentPage(page, "crawl");
    await launchApp(page, "policy");
    await expect(concurrency).toHaveValue("16");
  });

  test("历史跳转取消旧页面的危险确认，不执行写操作", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "policy");
    const policy = appPage(page, "policy");
    await policy.locator('[data-policy-site="pixiv"]').click();
    const concurrency = policy.locator('[data-policy-field="max_concurrency"]');
    await expect(concurrency).toHaveValue("8");
    await concurrency.fill("16");
    await policy.getByRole("button", { name: "恢复默认设置", exact: true }).click();
    await expect(policy.locator("[data-policy-confirmation]")).toBeVisible();
    await page.goBack();
    await expectOnlyCurrentPage(page, "proxy");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await launchApp(page, "policy");
    await expect(concurrency).toHaveValue("16");
    await expect(policy.locator("[data-policy-confirmation]")).toHaveCount(0);
    expect(api.count("PUT", "/api/v1/sites/policies/pixiv")).toBe(0);
    expect(api.count("DELETE", "/api/v1/sites/policies/pixiv")).toBe(0);
  });
  test("About 保留品牌内容，约束键盘焦点并在关闭后恢复按钮焦点", async ({ page }) => {
    await bootDesktop(page);
    const trigger = page.locator("[data-about-trigger]");
    await trigger.click();
    const about = page.locator("[data-about-dialog]");
    await expect(about).toBeVisible();
    await expect(about).toContainText("LoRA Dataset Operating System");
    await expect(about).toContainText("The operating workspace for LoRA datasets.");
    const close = about.getByRole("button", { name: "关闭关于 LDOS" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(about).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("快捷跳转按钮将焦点移入当前业务页", async ({ page }) => {
    await bootDesktop(page);
    const skip = page.locator("[data-skip-link]");
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => appPage(page, "crawl").evaluate((element) => element.contains(document.activeElement))).toBe(true);
  });

  test("canonical /ui/ 支持原 hash 深链接，切页不改变入口路径", async ({ page }) => {
    const api = await bootDesktop(page, {}, "/ui/#/diagnostics");
    await expect(page).toHaveURL(/\/ui\/#\/diagnostics$/);
    await expectOnlyCurrentPage(page, "diagnostics");
    await expect(page.locator("[data-diagnostics-app]")).toBeVisible();
    await launchApp(page, "crawl");
    await expect(page).toHaveURL(/\/ui\/#\/crawl$/);
    expect(api.unhandled).toEqual([]);
  });

  for (const viewport of [{ width: 1080, height: 740 }, { width: 880, height: 600 }]) {
    test(`${viewport.width}×${viewport.height} 九页无页面级横滚或尺寸阻断`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const api = await bootDesktop(page);
      for (const appId of APPLICATIONS) {
        await launchApp(page, appId);
        await prepareRichState(page, appId);
        await expectOnlyCurrentPage(page, appId);
        await expectPageInsideWorkspace(page, appId);
        await expectDesktopInsideViewport(page);
        await expect(page.getByRole("heading", { name: "请使用更大的桌面窗口" })).toHaveCount(0);
        const workspace = appPage(page, appId).locator('section[tabindex="0"]').first();
        if (await workspace.count()) {
          expect(await workspace.evaluate((element) => element.scrollWidth - element.clientWidth), `${appId} 不应依赖旧三栏横滚`).toBeLessThanOrEqual(1);
        }
      }
      expect(api.unhandled).toEqual([]);
    });
  }
});
