import { DEV_CSP, expect, test } from "./fixtures/test";

test("开发服务器在 devCsp 下启动，没有内联启动脚本", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(DEV_CSP);
  await expect(page.locator("[data-app-ready]")).toBeAttached();
  const inline = await page.locator("script:not([src])").count();
  expect(inline).toBe(0);
});
