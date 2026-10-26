import { appPage, prepareRichState } from "./fixtures/app-state";
import { bootDesktop, expect, expectDesktopInsideViewport, expectPageInsideWorkspace, launchApp, test } from "./fixtures/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 720 }]) {
  test(`紧凑工作台 ${viewport.width}px：视图单选、键盘和图库选区保持一致`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await bootDesktop(page, {}, "/#/gallery");
    await prepareRichState(page, "gallery");
    const gallery = appPage(page, "gallery");
    const grid = gallery.getByRole("radio", { name: "网格", exact: true });
    const list = gallery.getByRole("radio", { name: "列表", exact: true });
    const image = gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true });
    await image.check();

    // 当前视图必须始终被选中，不能出现内容仍为网格而两个控件都未选中的情况。
    await grid.click();
    await expect(grid).toBeChecked();
    await grid.focus();
    await page.keyboard.press("ArrowRight");
    await expect(list).toBeFocused();
    await page.keyboard.press("Space");
    await expect(list).toBeChecked();
    await expect(image).toBeChecked();
    await grid.click();
    await expect(grid).toBeChecked();
    await expect(image).toBeChecked();
    await expect(gallery.locator("[data-gallery-dedup]")).toBeVisible();
    await expectDesktopInsideViewport(page);
    await expectPageInsideWorkspace(page, "gallery");
    const clippedControls = await gallery.locator(".gallery-toolbar").evaluate((toolbar) => {
      const bounds = toolbar.getBoundingClientRect();
      return Array.from(toolbar.querySelectorAll("button, input, select")).filter((control) => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
      }).map((control) => control.getAttribute("aria-label") || control.textContent);
    });
    expect(clippedControls, "工具栏控件应自动换行，不得被内部滚动容器裁切").toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("gallery-rhea.png") });

    await image.uncheck();
    await prepareRichState(page, "review");
    const review = appPage(page, "review");
    await expect(review.getByRole("button", { name: "采纳并前进" })).toBeVisible();
    await expect(review.locator("[data-review-group-select]")).toBeVisible();
    await expectDesktopInsideViewport(page);
    await expectPageInsideWorkspace(page, "review");
    await page.screenshot({ path: testInfo.outputPath("review-rhea.png") });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 720 }]) {
  test(`剩余工作台 ${viewport.width}px：组件、布局与功能入口`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const api = await bootDesktop(page);
    await page.route("**/api/v1/tagger/models", (route) => route.fulfill({
      json: [{ key: "wd-vit-v3", repo: "test/model", revision: "test-revision", adapter: "wd_onnx",
        gated: false, license: "E2E model license", default_thresholds: { general: 0.35, character: 0.85 }, installed: true }],
    }));
    await page.route("**/api/v1/tagger/status", (route) => route.fulfill({
      json: { phase: "idle", stage: "", done: 0, total: 0, message: "", download: {}, last_result: null, enabled: true },
    }));
    const apps = ["crawl", "tasks", "tagger", "proxy", "vault", "policy", "filter-presets", "personalization", "diagnostics"] as const;
    for (const id of apps) {
      await launchApp(page, id);
      if (id !== "tagger" && id !== "filter-presets") await prepareRichState(page, id);
      const app = appPage(page, id);
      await expect(app.locator('[data-slot="button"]').first()).toBeVisible();
      await expectDesktopInsideViewport(page);
      await expectPageInsideWorkspace(page, id);
      const overflow = await app.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll('input[data-slot], select[data-slot], textarea[data-slot], button[data-slot]'))
          .filter((control) => {
            const box = control.getBoundingClientRect();
            return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
          }).map((control) => control.getAttribute("aria-label") || control.textContent);
      });
      expect(overflow, `${id} 的控件不能超出工作区`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${id}-rhea.png`) });
    }
    expect(api.unhandled).toEqual([]);
  });
}
