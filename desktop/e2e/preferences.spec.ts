import { expect, test } from "./fixtures/test";

const rowHeight = () => getComputedStyle(document.documentElement).getPropertyValue("--row").trim();

test("偏好写进本机存储，立即作用到 <html>，刷新后保持", async ({ page }) => {
  await page.goto("/#/settings/preferences");
  const prefs = page.getByTestId("preferences");
  const html = page.locator("html");

  // 测试环境的系统设置是「减少动态效果」，默认跟随系统。
  await expect(prefs.locator('[data-pref="motion"] [data-value="system"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("prefs-motion-hint")).toContainText("系统已开启");
  await expect(html).not.toHaveAttribute("data-motion", /.+/);
  await expect(html).not.toHaveAttribute("data-density", /.+/);
  expect(await page.evaluate(rowHeight)).toBe("32px");

  await prefs.getByRole("button", { name: "舒适（40px 行高）" }).click();
  await expect(html).toHaveAttribute("data-density", "comfortable");
  expect(await page.evaluate(rowHeight)).toBe("40px");

  await prefs.locator('[data-pref="motion"]').getByRole("button", { name: "开" }).click();
  await expect(html).toHaveAttribute("data-motion", "reduced");

  await prefs.getByRole("button", { name: "Canvas2D" }).click();
  expect(
    await page.evaluate(() => [localStorage.getItem("ldos.motion"), localStorage.getItem("ldos.density"), localStorage.getItem("ldos.renderer")]),
  ).toEqual(["on", "comfortable", "canvas2d"]);

  await page.reload();
  await expect(html).toHaveAttribute("data-density", "comfortable");
  await expect(html).toHaveAttribute("data-motion", "reduced");
  await expect(prefs.locator('[data-pref="renderer"] [data-value="canvas2d"]')).toHaveAttribute("aria-pressed", "true");

  // 「关」不理会系统设置：过渡时长恢复。
  await prefs.locator('[data-pref="motion"]').getByRole("button", { name: "关" }).click();
  await expect(html).toHaveAttribute("data-motion", "full");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--t-move").trim())).toBe("180ms");

  await prefs.locator('[data-pref="motion"]').getByRole("button", { name: "跟随系统" }).click();
  await expect(html).not.toHaveAttribute("data-motion", /.+/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--t-move").trim())).toBe("0ms");
});

test("偏好页的语言切换和外壳的是同一个设置", async ({ page }) => {
  await page.goto("/#/settings/preferences");
  await page.locator('[data-pref="language"]').getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("locale-switch").getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("preferences")).toContainText("Reduce motion");
});
