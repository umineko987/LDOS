import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures/test";

/** 圆点中心和当前项锚点中心的纵向距离。 */
async function dotOffset(dot: Locator, anchor: Locator): Promise<number> {
  const [dotBox, anchorBox] = await Promise.all([dot.boundingBox(), anchor.boundingBox()]);
  if (!dotBox || !anchorBox) return Number.POSITIVE_INFINITY;
  return Math.abs(dotBox.y + dotBox.height / 2 - (anchorBox.y + anchorBox.height / 2));
}

test("侧栏导航切换页面，金色圆点跟到当前项", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByTestId("sidebar");
  const nav = sidebar.getByRole("navigation", { name: "主导航" });
  const dot = nav.getByTestId("nav-dot");

  await expect(nav.getByRole("link", { name: "数据集" })).toHaveAttribute("aria-current", "page");
  await expect(dot).toHaveAttribute("data-visible", "true");
  await expect.poll(() => dotOffset(dot, nav.locator('[data-nav="datasets"] [data-dot-anchor]'))).toBeLessThan(1);

  for (const [name, id, hash] of [
    ["图库", "library", "#/library"],
    ["任务", "jobs", "#/jobs"],
    ["设置", "settings", "#/settings/network"],
  ] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
    await expect.poll(() => dotOffset(dot, nav.locator(`[data-nav="${id}"] [data-dot-anchor]`))).toBeLessThan(1);
  }

  // 圆点只有一个，颜色是金色。
  await expect(nav.getByTestId("nav-dot")).toHaveCount(1);
  expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(230, 189, 117)");

  // 旧版工作台是整页跳转。
  await expect(nav.getByRole("link", { name: "旧版工作台" })).toHaveAttribute("href", "/legacy/index.html");
  await expect(nav.getByRole("link", { name: "旧版工作台" })).toHaveAttribute("data-sveltekit-reload", /^(true)?$/);
});

test("数据集阶段和设置分区各有自己的圆点", async ({ page }) => {
  await page.goto("/#/datasets/demo/tag");
  const rail = page.getByTestId("stage-rail");
  await expect(page.getByRole("heading", { name: "数据集 demo" })).toBeVisible();
  await expect(rail.locator('[data-stage="tag"]')).toHaveAttribute("aria-current", "page");
  await rail.getByRole("link", { name: "导出" }).click();
  await expect(page).toHaveURL(/#\/datasets\/demo\/export$/);
  await expect
    .poll(() => dotOffset(rail.getByTestId("nav-dot"), rail.locator('[data-stage="export"] [data-dot-anchor]')))
    .toBeLessThan(1);
  // 侧栏里数据集仍是当前项。
  await expect(page.getByTestId("sidebar").getByRole("link", { name: "数据集" })).toHaveAttribute("aria-current", "page");

  await page.goto("/#/settings");
  await expect(page).toHaveURL(/#\/settings\/network$/);
  const settings = page.getByRole("navigation", { name: "设置分区" });
  await settings.getByRole("link", { name: "诊断" }).click();
  await expect(settings.getByRole("link", { name: "诊断" })).toHaveAttribute("aria-current", "page");
});

test("Ctrl+K 打开命令面板，搜索并跳转", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-shell]")).toBeVisible();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette.getByPlaceholder("搜索页面和命令…")).toBeFocused();
  await expect(palette.locator('[data-command-id="nav.library"]')).toBeVisible();
  await expect(palette.locator('[data-command-id="nav.settings.diagnostics"]')).toHaveText(/设置 › 诊断/);

  await page.keyboard.type("任务");
  await expect(palette.locator("[data-command-id]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/#\/jobs$/);

  // 英文别名也能搜到；Esc 关闭后焦点回到页面。
  await page.keyboard.press("Control+k");
  await page.keyboard.type("diagnostics");
  await expect(palette.locator("[data-command-id]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/#\/jobs$/);

  // 侧栏的“命令”按钮也能打开。
  await page.getByTestId("sidebar").getByRole("button", { name: /命令/ }).click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(palette).toHaveCount(0);
});

test("? 打开快捷键表，内容来自按键注册表", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-shell]")).toBeVisible();
  await page.keyboard.press("Shift+?");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet.getByRole("heading", { name: "快捷键" })).toBeVisible();
  await expect(sheet.locator('[data-shortcut="shell.palette"]')).toContainText("Ctrl");
  await expect(sheet.locator('[data-shortcut="shell.activity"]')).toContainText("J");
  await expect(sheet.locator('[data-shortcut="shell.escape"]')).toContainText("Esc");
  // 浮层打开时全局按键暂停：Ctrl+K 不会再叠一个命令面板。
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("Ctrl+J 打开活动抽屉，Esc 依次关闭浮层、回到上一级", async ({ page }) => {
  await page.goto("/#/jobs/crawls/batch-7");
  await expect(page.getByRole("heading", { name: "采集批次 batch-7" })).toBeVisible();

  await page.keyboard.press("Control+j");
  const drawer = page.getByTestId("activity-drawer");
  await expect(drawer.getByText("暂无进行中的任务")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/#\/jobs\/crawls\/batch-7$/);

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/jobs$/);
  // 顶层页面没有上一级，Esc 不再跳转。
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/jobs$/);
});

test("未知路由显示 404 页面", async ({ page }) => {
  await page.goto("/#/no/such/page");
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await page.getByRole("link", { name: "回到数据集" }).click();
  await expect(page.getByTestId("sidebar").getByRole("link", { name: "数据集" })).toHaveAttribute("aria-current", "page");
});
