import { expect, PRODUCTION_CSP, test } from "./fixtures/test";

test("构建产物在生产 CSP 下启动", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(PRODUCTION_CSP);
  const meta = page.locator('head > meta[http-equiv="Content-Security-Policy"]');
  await expect(meta).toHaveAttribute("content", PRODUCTION_CSP);
  expect(await meta.evaluate((element) => element.parentElement?.firstElementChild === element)).toBe(true);
  await expect(page.locator("[data-app-ready]")).toBeAttached();
  expect(await page.locator("script:not([src])").count()).toBe(0);
});

test("嵌入 HTML 自带生产 CSP，无 HTTP 策略头也能启动", async ({ page }) => {
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["content-security-policy"];
    await route.fulfill({ response, headers });
  });
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBeUndefined();
  await expect(page.locator('head > meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", PRODUCTION_CSP);
  await expect(page.locator("[data-app-ready]")).toBeAttached();
});
