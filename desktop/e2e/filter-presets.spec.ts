import AxeBuilder from "@axe-core/playwright";
import { appPage } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

const endpoint = "/api/v1/gallery/review-presets";

test("筛选预设：内置另存、自定义增改复制删除，保留隐藏页草稿", async ({ page }) => {
  const api = await bootDesktop(page);
  expect(api.count("GET", endpoint)).toBe(0);
  await launchApp(page, "filter-presets");
  const app = appPage(page, "filter-presets");
  await expect(app.getByLabel("预设名称")).toHaveValue("画风");
  await expect(app.getByLabel("预设名称")).toBeDisabled();
  await expect(app.getByRole("button", { name: "删除预设" })).toHaveCount(0);
  await app.getByRole("button", { name: "另存为自定义" }).click();
  await app.getByLabel("预设名称").fill("Style draft");
  await expect(app.getByRole("checkbox", { name: "单色 / 灰度" })).toBeChecked();
  await expect(app.locator('[data-filter-capability="filter_monochrome"]')).toContainText("monochrome");
  await app.getByRole("checkbox", { name: "单色 / 灰度" }).uncheck();
  await app.getByRole("checkbox", { name: "素描", exact: true }).uncheck();
  await app.getByRole("button", { name: "保存预设" }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await app.getByLabel("预设名称").fill("Hidden draft");
  await launchApp(page, "gallery");
  await launchApp(page, "filter-presets");
  await expect(app.getByLabel("预设名称")).toHaveValue("Hidden draft");
  expect(api.count("GET", endpoint)).toBe(1);
  await app.getByRole("button", { name: "取消修改" }).click();
  await expect(app.getByLabel("预设名称")).toHaveValue("Style draft");
  await app.getByLabel("预设名称").fill("Style saved");
  await app.getByRole("button", { name: "保存预设" }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await app.getByRole("button", { name: "复制预设" }).click();
  await app.getByLabel("预设名称").fill("Copy");
  await app.getByRole("button", { name: "保存预设" }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await app.getByRole("button", { name: "删除预设" }).click();
  expect(api.count("DELETE", `${endpoint}/preset-2`)).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await app.getByRole("button", { name: "删除预设" }).click();
  await expect(app.getByText("自定义预设已删除。", { exact: true })).toBeVisible();
  expect(api.count("POST", endpoint)).toBe(2);
  expect(api.count("PUT", `${endpoint}/preset-1`)).toBe(1);
  expect(api.count("DELETE", `${endpoint}/preset-2`)).toBe(1);
  const accessibility = await new AxeBuilder({ page }).include("[data-filter-presets-app]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.locator("[data-language-toggle]").click();
  await expect(app.getByRole("heading", { name: "Filter presets", exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "Save as custom" })).toBeVisible();
  expect(api.unhandled).toEqual([]);
});

test("参考图：图库目录、跨页选择、旧引用可移除、取消不改集合", async ({ page }) => {
  const api = await bootDesktop(page, {}, "/#/filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByRole("button", { name: "角色 LoRA", exact: true }).click();
  await app.getByRole("button", { name: "另存为自定义" }).click();
  await app.getByLabel("预设名称").fill("References");
  await app.getByRole("button", { name: "从图库添加" }).click();
  const picker = app.locator("[data-filter-reference-picker]");
  const rootResponse = page.waitForResponse((response) => response.url().includes("/gal-dir-root/entries"));
  await picker.getByRole("button", { name: "E2E 导入目录", exact: true }).click();
  const root = await (await rootResponse).json();
  const accessibility = await new AxeBuilder({ page }).include("[data-filter-reference-picker]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await picker.getByRole("checkbox", { name: "image-01.jpg", exact: true }).focus();
  await page.keyboard.press("Space");
  await picker.getByRole("button", { name: "subdir", exact: true }).click();
  await expect(picker.getByRole("checkbox", { name: "image-05.jpg", exact: true })).toBeVisible();
  await expect(picker.getByRole("list", { name: "待使用的参考图" })).toContainText("gal-asset-01");
  await picker.getByRole("button", { name: "使用所选参考图" }).click();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-01");

  await page.route("**/api/v1/gallery/directories/gal-dir-root/entries?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: {
      ...root,
      assets: url.searchParams.has("asset_cursor") ? [root.assets[1]] : [root.assets[0]],
      asset_cursor: url.searchParams.has("asset_cursor") ? null : "reference-next",
    } });
  });
  await app.getByRole("button", { name: "从图库添加" }).click();
  await picker.getByRole("button", { name: "E2E 导入目录", exact: true }).click();
  await picker.getByRole("button", { name: "加载更多图片" }).click();
  await picker.getByRole("checkbox", { name: "image-02.jpg", exact: true }).check();
  await expect(picker.getByRole("checkbox", { name: "image-01.jpg", exact: true })).toBeChecked();
  await picker.getByRole("button", { name: "使用所选参考图" }).click();
  await app.getByRole("button", { name: "保存预设" }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  expect(api.requests.find((request) => request.method === "POST" && request.path === endpoint)?.body).toMatchObject({ options: { reference_asset_ids: ["gal-asset-01", "gal-asset-02"], filter_character: true } });

  await app.getByRole("button", { name: "从图库添加" }).click();
  await expect(picker.getByRole("list", { name: "待使用的参考图" })).toContainText("gal-asset-02");
  await picker.getByRole("button", { name: "移除参考图" }).first().click();
  await page.keyboard.press("Escape");
  await expect(app.getByRole("button", { name: "从图库添加" })).toBeFocused();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-01");
  await app.getByRole("button", { name: "移除参考图" }).first().click();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).not.toContainText("gal-asset-01");
  await app.getByRole("button", { name: "清空参考图" }).click();
  await expect(app.getByText("尚未添加参考图", { exact: true })).toBeVisible();
  await app.getByRole("button", { name: "取消修改" }).click();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  expect(api.unhandled).toEqual([]);
});

test("过滤能力加载失败：不假定可用，仍可保存空参考模板和取消勾选", async ({ page }) => {
  const api = await bootDesktop(page, { failPaths: ["/api/v1/setup/models"] }, "/#/filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByRole("button", { name: "角色 LoRA", exact: true }).click();
  await app.getByRole("button", { name: "另存为自定义" }).click();
  await app.getByLabel("预设名称").fill("Empty template");
  await expect(app.getByText("fixture_failure: 模拟服务错误", { exact: true })).toBeVisible();
  await expect(app.locator("[data-filter-capability]")).toHaveCount(3);
  await expect(app.locator('[data-filter-capability="filter_character"]')).toContainText("过滤能力未加载");
  await app.getByRole("button", { name: "保存预设" }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await app.getByRole("checkbox", { name: "非目标角色", exact: true }).uncheck();
  await app.getByRole("button", { name: "取消修改" }).click();
  await expect(app.getByRole("checkbox", { name: "非目标角色", exact: true })).toBeChecked();
  expect(api.unhandled).toEqual([]);
});
