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
  await expect(page.locator("[data-desktop]")).toBeVisible();
  return api;
}

export async function launchApp(page: Page, appId: string): Promise<void> {
  await page.getByRole("button", { name: /应用中心；打开全部应用列表/ }).click();
  const center = page.locator("[data-application-center]");
  await expect(center).toBeVisible();
  await center.locator(`[data-application-center-app="${appId}"]`).click();
  await expect(page.locator(`[data-app-window][data-app-id="${appId}"]`)).toBeVisible();
}

export async function maximizeApp(page: Page, appId: string): Promise<void> {
  const window = page.locator(`[data-app-window][data-app-id="${appId}"]`);
  if (await window.getAttribute("data-window-state") !== "maximized") {
    await window.getByRole("button", { name: "最大化窗口" }).click();
  }
  await expect(window).toHaveAttribute("data-window-state", "maximized");
}

export async function closeApp(page: Page, appId: string): Promise<void> {
  const window = page.locator(`[data-app-window][data-app-id="${appId}"]`);
  await window.getByRole("button", { name: "关闭窗口" }).click();
  await expect(window).toHaveCount(0);
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

export async function expectWindowInsideWorkspace(page: Page, appId: string): Promise<void> {
  const window = page.locator(`[data-app-window][data-app-id="${appId}"]`);
  const workspace = page.locator("[data-window-layer]");
  const [windowBox, workspaceBox] = await Promise.all([window.boundingBox(), workspace.boundingBox()]);
  expect(windowBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  if (!windowBox || !workspaceBox) return;
  expect(windowBox.x).toBeGreaterThanOrEqual(workspaceBox.x - 1);
  expect(windowBox.y).toBeGreaterThanOrEqual(workspaceBox.y - 1);
  expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(workspaceBox.x + workspaceBox.width + 1);
  expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(workspaceBox.y + workspaceBox.height + 1);
}
