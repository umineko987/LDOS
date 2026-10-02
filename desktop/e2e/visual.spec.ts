import { APPLICATIONS, appPage, prepareRichState } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

// Regenerate these baselines only after the shared workbench styles have settled.
test("工作台默认采集视觉基线", async ({ page }) => {
  await bootDesktop(page);
  await expect(page.locator("[data-workbench]")).toHaveScreenshot("workbench.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.002,
  });
});

for (const appId of APPLICATIONS) {
  test(`${appId} 全屏业务页丰富状态视觉基线`, async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, appId);
    await prepareRichState(page, appId);
    await expect(appPage(page, appId)).toHaveScreenshot(`${appId}-page.png`, {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    });
  });
}
