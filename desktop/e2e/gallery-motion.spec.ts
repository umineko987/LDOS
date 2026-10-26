import type { Page } from "@playwright/test";
import { appPage } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

interface MotionRecord { target: string; duration: number; finished: boolean }
declare global { interface Window { galleryMotionLog: MotionRecord[]; galleryMotionPause?: boolean } }

test.use({ contextOptions: { reducedMotion: "no-preference" }, viewport: { width: 1440, height: 1000 } });

async function openGallery(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.galleryMotionLog = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (window.galleryMotionPause && this.classList.contains("gallery-motion-image")) animation.pause();
      const record = { target: this.className.toString(), duration: Number(animation.effect?.getTiming().duration), finished: false };
      window.galleryMotionLog.push(record);
      void animation.finished.then(() => { record.finished = true; }, () => {});
      return animation;
    };
  });
  await bootDesktop(page, { galleryScenario: "flat" });
  await launchApp(page, "gallery");
  await page.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect.poll(() => page.locator('[data-gallery-asset="gal-asset-01"] img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

const bridges = (page: Page) => page.evaluate(() => window.galleryMotionLog.filter((record) => record.target === "gallery-motion-image"));

test("展片与收回使用原位置，选区保留且没有残留动画层", async ({ page }) => {
  await openGallery(page);
  const gallery = appPage(page, "gallery");
  await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).check();
  await gallery.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true }).check();
  await expect(gallery.locator("[data-gallery-selection-summary]")).toContainText("2 张图片");
  expect(await gallery.locator("[data-gallery-selection-bar]").evaluate((element) => getComputedStyle(element).animationName)).toBe("gallery-dock-in");
  const opener = gallery.locator('[data-gallery-asset="gal-asset-01"]');
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => bridges(page)).toEqual([{ target: "gallery-motion-image", duration: 280, finished: true }]);
  await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(gallery.locator(".gallery-viewer")).toHaveCount(0);
  await expect.poll(() => bridges(page)).toEqual([
    { target: "gallery-motion-image", duration: 280, finished: true },
    { target: "gallery-motion-image", duration: 210, finished: true },
  ]);
  await expect(page.locator(".gallery-motion-image, .gallery-motion-backdrop")).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(gallery.locator("[data-gallery-selection-summary]")).toContainText("2 张图片");
});

test("展开可被翻图立即打断，TXT 未保存时不收回", async ({ page }) => {
  await openGallery(page);
  const gallery = appPage(page, "gallery");
  await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
  await page.keyboard.press("ArrowRight");
  await expect(gallery.locator(".gallery-viewer")).toHaveAttribute("data-gallery-viewer-asset", "gal-asset-02");
  await expect(page.locator(".gallery-motion-image")).toHaveCount(0);
  await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
  await gallery.getByRole("button", { name: "编辑原文", exact: true }).click();
  await gallery.getByLabel("TXT 原文编辑器").fill("motion draft");
  const before = (await bridges(page)).length;
  await page.keyboard.press("Escape");
  await expect(gallery.getByRole("alertdialog", { name: "TXT 有未保存更改" })).toBeVisible();
  expect((await bridges(page)).length).toBe(before);
  await gallery.getByRole("button", { name: "取消", exact: true }).click();
  await expect(gallery.getByLabel("TXT 原文编辑器")).toHaveValue("motion draft");
});

test("用户关闭、系统减少动态和高对比均不播放空间转场", async ({ page }) => {
  await openGallery(page);
  const gallery = appPage(page, "gallery");
  for (const mode of ["off", "reduce", "forced"] as const) {
    await page.evaluate((mode) => { document.documentElement.dataset.motion = mode === "off" ? "off" : "on"; }, mode);
    await page.emulateMedia({ reducedMotion: mode === "reduce" ? "reduce" : "no-preference", forcedColors: mode === "forced" ? "active" : "none" });
    await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
    await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery.locator(".gallery-viewer")).toHaveCount(0);
    if (mode !== "forced") {
      expect(await gallery.locator("[data-gallery-selection-bar]").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    }
  }
  expect(await page.evaluate(() => window.galleryMotionLog)).toEqual([]);
});

test("列表与不可见返回目标自然淡出，切换页面会清理视觉层", async ({ page }) => {
  await openGallery(page);
  const gallery = appPage(page, "gallery");
  await gallery.getByRole("radio", { name: "列表", exact: true }).click();
  await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
  await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(gallery.locator(".gallery-viewer")).toHaveCount(0);
  expect(await bridges(page)).toEqual([]);
  await expect(page.locator(".gallery-motion-backdrop")).toHaveCount(0);
  await gallery.getByRole("radio", { name: "网格", exact: true }).click();
  await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
  // Simulate virtualisation removing the target while the viewer is open.
  await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
  const beforeClose = (await bridges(page)).length;
  await gallery.locator('[data-gallery-asset="gal-asset-01"]').evaluate((element) => { element.style.visibility = "hidden"; });
  await page.keyboard.press("Escape");
  await expect(gallery.locator(".gallery-viewer")).toHaveCount(0);
  expect((await bridges(page)).length).toBe(beforeClose);
  await launchApp(page, "tasks");
  await expect(page.locator(".gallery-motion-image, .gallery-motion-backdrop")).toHaveCount(0);
});

test("动效途中关闭开关立即恢复真实图片", async ({ page }) => {
  await openGallery(page);
  await page.evaluate(() => { window.galleryMotionPause = true; });
  const gallery = appPage(page, "gallery");
  await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
  await expect(page.locator(".gallery-motion-image")).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.dataset.motion = "off"; });
  await expect(page.locator(".gallery-motion-image")).toHaveCount(0);
  await expect(gallery.locator(".gallery-viewer__stage img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".gallery-motion-image, .gallery-motion-backdrop")).toHaveCount(0);
});


test("大图加载慢时保留缩略图，不会在展片结束后闪黑", async ({ page }) => {
  await openGallery(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/gallery/assets/*/content*", async (route) => {
    await pending;
    await route.fallback();
  });
  const gallery = appPage(page, "gallery");
  try {
    await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
    await expect.poll(() => bridges(page)).toEqual([{ target: "gallery-motion-image", duration: 280, finished: true }]);
    const image = gallery.locator(".gallery-viewer__stage img");
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("thumbnail");
    release();
    await expect.poll(() => image.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe("none");
  } finally { release(); }
});
