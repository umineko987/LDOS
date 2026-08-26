import { APPLICATIONS, appWindow, prepareRichState } from "./fixtures/app-state";

import { bootDesktop, expect, launchApp, maximizeApp, test } from "./fixtures/test";

test("应用中心视觉基线", async ({ page }) => {
  await bootDesktop(page);
  await page.keyboard.press("Control+o");
  const center = page.locator("[data-application-center]");
  await expect(center).toBeVisible();
  await expect(center).toHaveScreenshot("application-center.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.002,
  });
});

for (const appId of APPLICATIONS) {
  test(`${appId} 丰富状态视觉基线`, async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, appId);
    await maximizeApp(page, appId);
    await prepareRichState(page, appId);
    await expect(appWindow(page, appId)).toHaveScreenshot(`${appId}-maximized.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    });
  });
}
