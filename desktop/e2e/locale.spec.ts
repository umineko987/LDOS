import { expect, test } from "./fixtures/test";

test("默认中文，切到英文后不刷新页面，重启后保持", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByText("数据集工作台")).toBeVisible();

  const switcher = page.getByTestId("locale-switch");
  await expect(switcher.getByRole("button", { name: "中" })).toHaveAttribute("aria-pressed", "true");

  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await switcher.getByRole("button", { name: "EN" }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Dataset workbench")).toBeVisible();
  await expect(switcher.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
  expect(navigations, "切换语言不应重新加载文档").toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("ldos.locale"))).toBe("en");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("Dataset workbench")).toBeVisible();
});
