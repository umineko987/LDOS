import { expect, test } from "./fixtures/test";

// 旧版启动后会请求很多没有模拟的接口，这里只验证它在生产 CSP 下能加载并渲染。
test.use({ allowConsoleErrors: true });

test("旧版工作台从 /legacy/index.html 加载", async ({ page }) => {
  // 旧版启动门只需要 /healthz；其余接口不在这条冒烟测试的范围内。
  await page.route("**/healthz", (route) => route.fulfill({
    json: { ok: true, components: { process: { status: "ok" }, database: { status: "ok" } }, time: 0 },
  }));
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, json: {} }));
  const response = await page.goto("/legacy/index.html");
  expect(response?.status()).toBe(200);
  await expect(page.locator("#app > *").first()).toBeVisible();
});
