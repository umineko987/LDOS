import { expect, test as base, type Page } from "@playwright/test";

import { installMockApi, type MockApi, type MockApiOptions } from "./mock-api";

type RuntimeFixtures = {
  runtimeErrors: string[];
};

export const test = base.extend<RuntimeFixtures>({
  runtimeErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of")) {
        errors.push(`console.error: ${message.text()}`);
      }
    });
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      const isStaticAsset = /\.(?:css|ico|jpe?g|js|mjs|png|svg|webp|woff2?)$/i.test(pathname);
      if (response.status() >= 400 && isStaticAsset) {
        errors.push(`static resource HTTP ${response.status()}: ${pathname}`);
      }
    });
    await use(errors);
    expect(errors, "页面运行期间不应出现未处理异常、console.error 或静态资源失败").toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function bootDesktop(page: Page, options: MockApiOptions = {}, entryPath = "/"): Promise<MockApi> {
  const api = await installMockApi(page, options);
  await page.goto(entryPath);
  await expect(page.locator("[data-desktop][data-workbench]")).toBeVisible();
  return api;
}

export async function launchApp(page: Page, appId: string): Promise<void> {
  const navigation = page.locator(`[data-nav-app="${appId}"]`);
  if (!await navigation.isVisible()) await page.locator("[data-nav-settings]").click();
  await navigation.click();
  await expect(page).toHaveURL(new RegExp(`#/${appId}$`));
  await expect(page.locator(`[data-app-page][data-app-id="${appId}"]`)).toBeVisible();
}

export async function expectDesktopInsideViewport(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
}

export async function expectPageInsideWorkspace(page: Page, appId: string): Promise<void> {
  const app = page.locator(`[data-app-page][data-app-id="${appId}"]`);
  const workspace = page.locator("[data-workspace]");
  const [appBox, workspaceBox] = await Promise.all([app.boundingBox(), workspace.boundingBox()]);
  expect(appBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  if (!appBox || !workspaceBox) return;
  expect(appBox.x).toBeGreaterThanOrEqual(workspaceBox.x - 1);
  expect(appBox.y).toBeGreaterThanOrEqual(workspaceBox.y - 1);
  expect(appBox.x + appBox.width).toBeLessThanOrEqual(workspaceBox.x + workspaceBox.width + 1);
  expect(appBox.y + appBox.height).toBeLessThanOrEqual(workspaceBox.y + workspaceBox.height + 1);
  expect(await app.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}
