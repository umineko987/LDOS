import AxeBuilder from "@axe-core/playwright";

import { APPLICATIONS, prepareRichState } from "./fixtures/app-state";

import { bootDesktop, expect, launchApp, maximizeApp, test } from "./fixtures/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function report(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string {
  return JSON.stringify(violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    targets: nodes.map((node) => node.target),
  })), null, 2);
}

async function expectNoViolations(page: Parameters<typeof bootDesktop>[0], include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  expect(results.violations, report(results.violations)).toEqual([]);
}

test("桌面和应用中心通过 WCAG A/AA 自动扫描", async ({ page }) => {
  await bootDesktop(page);
  await expectNoViolations(page);

  await page.keyboard.press("Control+o");
  await expect(page.locator("[data-application-center]")).toBeVisible();
  await expectNoViolations(page);
});

for (const appId of APPLICATIONS) {
  test(`${appId} 最大化工作区通过 WCAG A/AA 自动扫描`, async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, appId);
    await maximizeApp(page, appId);
    await prepareRichState(page, appId);
    const selector = `[data-app-window][data-app-id="${appId}"]`;
    await expect(page.locator(selector)).toBeVisible();
    await expectNoViolations(page, selector);
  });
}
