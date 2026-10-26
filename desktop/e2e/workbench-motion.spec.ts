import { appPage, prepareRichState } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

test.use({ contextOptions: { reducedMotion: "no-preference" } });

test("动效推广：导航、进度和弹层保留焦点并响应关闭设置", async ({ page }) => {
  await bootDesktop(page);
  const sidebar = page.locator(".workbench-sidebar");
  await expect(sidebar).toHaveAttribute("data-selection-track", "ready");
  await launchApp(page, "tasks");
  await expect.poll(() => sidebar.evaluate((host) => {
    const selected = host.querySelector('[aria-current="page"]')!;
    const target = selected.getBoundingClientRect();
    const track = getComputedStyle(host, "::before");
    return Math.abs(parseFloat(track.height) - target.height) < 1
      && track.transitionProperty.includes("transform");
  })).toBe(true);
  await prepareRichState(page, "tasks");
  await expect(appPage(page, "tasks").locator(".workbench-progress")).toHaveAttribute("data-running", "true");
  await expect.poll(() => page.locator(".workbench-progress").evaluate((el) => getComputedStyle(el, "::after").animationName)).toBe("workbench-scan");
  await launchApp(page, "proxy");
  await launchApp(page, "personalization");
  await expect(page.locator(".workbench-settings-nav")).toHaveAttribute("data-selection-track", "ready");
  await page.setViewportSize({ width: 800, height: 800 });
  await page.locator("[data-about-trigger]").click();
  await expect(page.locator(".about-dialog")).toBeVisible();
  await expect.poll(() => page.locator(".about-dialog").evaluate((el) => getComputedStyle(el).animationName)).toBe("workbench-unfold");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-about-trigger]")).toBeFocused();
  await page.evaluate(() => { document.documentElement.dataset.motion = "off"; });
  await page.locator("[data-about-trigger]").click();
  await expect.poll(() => page.locator(".about-dialog").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect.poll(() => sidebar.evaluate((el) => getComputedStyle(el, "::before").transitionDuration)).toBe("0s");
});

test("动效推广：去重换组可打断，减少动态与高对比不改变审核", async ({ page }) => {
  await bootDesktop(page);
  await prepareRichState(page, "review");
  const review = appPage(page, "review");
  const stage = review.locator(".review-deck-stage");
  await review.getByRole("button", { name: "下一组", exact: true }).click();
  await expect(stage).toHaveAttribute("data-review-motion", /[01]/);
  await expect.poll(() => review.locator(".review-deck-cards").evaluate((el) => getComputedStyle(el).animationName)).toMatch(/^review-deal-/);
  // Escape immediately returns to the previous group, without waiting for animation.
  await page.keyboard.press("Escape");
  await expect(review.locator(".review-deck-header h2")).toContainText("组 1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await review.getByRole("button", { name: "下一组", exact: true }).click();
  await expect.poll(() => review.locator(".review-deck-cards").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
  await review.getByRole("button", { name: "上一组", exact: true }).click();
  await expect.poll(() => review.locator(".review-deck-cards").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await expect(review.getByRole("button", { name: "采纳并前进", exact: true })).toBeEnabled();
});
