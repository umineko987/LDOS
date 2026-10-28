import { expect, PRODUCTION_CSP, test } from "./fixtures/test";

test("构建产物在生产 CSP 下启动", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(PRODUCTION_CSP);
  await expect(page.locator("[data-app-ready]")).toBeAttached();
  expect(await page.locator("script:not([src])").count()).toBe(0);
});
