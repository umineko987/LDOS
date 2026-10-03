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
  await expect(app.getByLabel("预设名称")).toBeEnabled();
  await expect(app.getByRole("button", { name: "删除预设" })).toHaveCount(0);
  await app.getByRole("button", { name: "另存为自定义" }).click();
  await app.getByLabel("预设名称").fill("Style draft");
  await expect(app.getByRole("checkbox", { name: "单色" })).toBeChecked();
  await expect(app.locator('[data-filter-capability="filter_monochrome"]')).toContainText("completeness");
  await app.getByRole("checkbox", { name: "单色" }).uncheck();
  await app.getByRole("checkbox", { name: "线稿/草图", exact: true }).uncheck();
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

test("内置画风可直接修改保存，刷新后图库使用已保存配置", async ({ page }) => {
  const api = await bootDesktop(page, {}, "/#/filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByLabel("预设名称").fill("My style");
  await app.getByRole("checkbox", { name: "单色", exact: true }).uncheck();
  await app.getByRole("checkbox", { name: "线稿/草图", exact: true }).uncheck();
  await app.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "My style", exact: true })).toBeVisible();
  expect(api.count("PUT", `${endpoint}/builtin-style`)).toBe(1);
  expect(api.count("POST", endpoint)).toBe(0);
  await page.reload();
  await expect(app.getByLabel("预设名称")).toHaveValue("My style");
  await expect(app.getByRole("checkbox", { name: "线稿/草图", exact: true })).not.toBeChecked();
  await app.getByRole("checkbox", { name: "线稿/草图", exact: true }).check();
  await app.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(app.getByRole("checkbox", { name: "线稿/草图", exact: true })).not.toBeChecked();
  await launchApp(page, "gallery");
  const gallery = appPage(page, "gallery");
  await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).check();
  await gallery.locator("[data-gallery-dedup]").click();
  const panel = gallery.locator("[data-gallery-review-confirmation]");
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-style");
  await panel.getByRole("button", { name: "开始处理", exact: true }).click();
  await expect(page).toHaveURL(/#\/review$/);
  expect(api.requests.find(({ method, path }) => method === "POST" && path === "/api/v1/gallery/reviews")?.body).toMatchObject({
    filter_config: { preset_name: "My style", options: { filter_monochrome: false, filter_sketch: false } },
  });
});

test("统一选图：内置角色草稿全页往返、跨目录与分页、预选取消和空集合确认", async ({ page }) => {
  const api = await bootDesktop(page, {}, "/#/filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByRole("button", { name: "角色 LoRA", exact: true }).click();
  await app.getByLabel("预设名称").fill("References");
  await app.getByRole("checkbox", { name: "相似图片分组", exact: true }).uncheck();
  await app.getByRole("button", { name: "选择参考图…" }).click();
  const picker = page.locator("[data-gallery-picker]");
  await expect(app).not.toBeVisible();
  await expect(page.locator('[data-app-id="gallery"]')).toHaveCount(0);
  await expect(picker.getByRole("heading", { name: "选择角色参考图" })).toBeVisible();
  await expect(picker).toContainText("来自『筛选预设 / References』");
  await expect(page.locator("[data-filter-reference-picker]")).toHaveCount(0);
  const rootResponse = page.waitForResponse((response) => response.url().includes("/gal-dir-root/entries"));
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  const root = await (await rootResponse).json();
  const accessibility = await new AxeBuilder({ page }).include("[data-gallery-picker]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).focus();
  await page.keyboard.press("Space");
  await picker.locator(".gallery-folder").filter({ hasText: "subdir" }).click();
  await picker.getByRole("checkbox", { name: "选择图片 image-05.jpg", exact: true }).check();
  await expect(picker.getByRole("button", { name: "使用这 2 张", exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "使用这 2 张", exact: true }).click();
  await expect(app.getByRole("button", { name: "选择参考图…" })).toBeFocused();
  await expect(app.getByLabel("预设名称")).toHaveValue("References");
  await expect(app.getByRole("checkbox", { name: "相似图片分组", exact: true })).not.toBeChecked();
  await expect(app.getByRole("button", { name: "保存预设", exact: true })).toBeEnabled();
  expect(api.count("PUT", `${endpoint}/builtin-character`)).toBe(0);
  expect(api.count("POST", "/api/v1/gallery/reviews")).toBe(0);

  await page.route("**/api/v1/gallery/directories/gal-dir-root/entries?*", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: {
      ...root,
      directories: url.searchParams.has("asset_cursor") ? [] : root.directories,
      assets: url.searchParams.has("asset_cursor") ? [root.assets[1]] : [root.assets[0]],
      asset_cursor: url.searchParams.has("asset_cursor") ? null : "reference-next",
    } });
  });
  await app.getByRole("button", { name: "选择参考图…" }).click();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true })).toBeChecked();
  // The full Gallery loads more when its viewport reaches the pagination boundary.
  await picker.getByLabel("图片网格", { exact: true }).evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true }).check();
  await picker.getByRole("button", { name: "使用这 3 张", exact: true }).click();
  await app.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(app.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  expect(api.requests.find((request) => request.method === "PUT" && request.path === `${endpoint}/builtin-character`)?.body).toMatchObject({ name: "References", options: { reference_asset_ids: ["gal-asset-01", "gal-asset-05", "gal-asset-02"], filter_character: true, similarity_groups: false } });
  expect(api.count("POST", endpoint)).toBe(0);

  await app.getByRole("button", { name: "选择参考图…" }).click();
  await picker.locator("[data-gallery-picker-footer] summary").click();
  await picker.getByRole("button", { name: "移除参考图 gal-asset-01", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(app.getByRole("button", { name: "选择参考图…" })).toBeFocused();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-01");
  await expect(app.getByRole("button", { name: "保存预设", exact: true })).toBeDisabled();
  await app.getByRole("button", { name: "选择参考图…" }).click();
  await picker.locator("[data-gallery-picker-footer] summary").click();
  for (const id of ["gal-asset-01", "gal-asset-05", "gal-asset-02"]) await picker.getByRole("button", { name: `移除参考图 ${id}`, exact: true }).click();
  await picker.getByRole("button", { name: "使用这 0 张", exact: true }).click();
  await expect(app.getByText("尚未添加参考图", { exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "保存预设", exact: true })).toBeEnabled();
  await app.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(app.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  expect(api.unhandled).toEqual([]);
});

test("选图只读与生命周期：预览先退出、页面切换暂停、后退取消、销毁忽略旧结果与刷新保护", async ({ page }) => {
  const api = await bootDesktop(page, {}, "/#/filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByRole("button", { name: "角色 LoRA", exact: true }).click();
  await app.getByLabel("预设名称").fill("Unsaved origin");
  const open = app.getByRole("button", { name: "选择参考图…", exact: true });
  const picker = page.locator("[data-gallery-picker]");
  await open.click();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("checkbox", { name: /^选择目录/ })).toHaveCount(0);
  await expect(picker.locator('[data-gallery-import], [data-gallery-dedup], .gallery-source__delete')).toHaveCount(0);
  for (const name of ["重新扫描", "来源设置…", "重命名…", "删除…", "回收区", "导出目录…"]) await expect(picker.getByRole("button", { name, exact: true })).toHaveCount(0);
  await picker.locator('[data-gallery-asset="gal-asset-01"]').focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("F2");
  await page.route("**/api/v1/gallery/assets/gal-asset-01/content", (route) => route.fulfill({ status: 404, body: "" }));
  await page.keyboard.press("Enter");
  const viewer = picker.locator(".gallery-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("alert")).toContainText("无法显示 image-01.jpg");
  await expect(viewer.getByRole("button", { name: "移入回收区", exact: true })).toHaveCount(0);
  await expect(viewer.locator("textarea")).toHaveCount(0);
  const stageWidth = await viewer.locator(".gallery-viewer__stage").evaluate((element) => element.clientWidth);
  expect(stageWidth).toBe(await viewer.locator(".gallery-viewer__body").evaluate((element) => element.clientWidth));
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("image-02.jpg");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(picker).toBeVisible();
  await picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).check();
  await page.locator('[data-nav-app="tasks"]').evaluate((button: HTMLElement) => button.click());
  await expect(picker).toBeVisible();
  await expect(page).toHaveURL(/#\/filter-presets$/);
  const staleConfirm = await picker.getByRole("button", { name: "使用这 1 张", exact: true }).elementHandle();
  // An external hash change / browser back cancels, restores the caller, and never applies selection.
  await page.evaluate(() => { history.pushState(null, "", "#/tasks"); });
  await page.goBack();
  await expect(picker).toHaveCount(0);
  await expect(page).toHaveURL(/#\/filter-presets$/);
  await expect(app.getByLabel("预设名称")).toHaveValue("Unsaved origin");
  await expect(app.getByText("尚未添加参考图", { exact: true })).toBeVisible();
  await app.getByRole("button", { name: "取消修改", exact: true }).click();
  await app.getByRole("button", { name: "画风 LoRA", exact: true }).click();
  await open.click();
  await staleConfirm?.evaluate((button: HTMLElement) => button.click());
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "使用这 0 张", exact: true })).toBeVisible();
  // Destroy the keyed editor while the workbench request is still pending.
  await app.getByLabel("预设名称").evaluate((input: HTMLInputElement) => { input.value = "New draft"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await app.getByRole("button", { name: "取消修改", exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.click());
  await expect(picker).toHaveCount(0);
  await expect(app.getByLabel("预设名称")).toHaveValue("画风");
  await page.route("**/api/v1/gallery/sources?*", (route) => route.fulfill({ status: 503, json: { detail: "picker_unavailable" } }));
  await open.click();
  await expect(picker.getByRole("alert")).toContainText("来源加载失败");
  await picker.getByRole("button", { name: "取消选图", exact: true }).click();
  await expect(app.getByLabel("预设名称")).toHaveValue("画风");
  await page.unroute("**/api/v1/gallery/sources?*");
  await app.getByLabel("预设名称").fill("Refresh draft");
  await open.click();
  let unloadType = "";
  page.once("dialog", async (dialog) => { unloadType = dialog.type(); await dialog.accept(); });
  await page.reload();
  expect(unloadType).toBe("beforeunload");
  await expect(picker).toHaveCount(0);
  await expect(app.getByLabel("预设名称")).toHaveValue("画风");
  expect(api.requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(api.unhandled).toEqual([]);
});

test("统一选图跨来源、搜索与列表不丢选择，最多200张且可移除旧引用", async ({ page }) => {
  const api = await bootDesktop(page);
  await page.route(`**${endpoint}`, (route) => route.fulfill({ json: { items: [{
    id: "builtin-character", name: "角色", builtin: true,
    options: { basic_dedup: true, filter_monochrome: false, filter_sketch: false, filter_character: true, similarity_groups: true,
      reference_asset_ids: ["gal-asset-01", ...Array.from({ length: 198 }, (_, index) => `old-reference-${index}`)] },
  }] } }));
  await launchApp(page, "filter-presets");
  const app = appPage(page, "filter-presets");
  await app.getByRole("button", { name: "选择参考图…", exact: true }).click();
  const picker = page.locator("[data-gallery-picker]");
  const rootResponse = page.waitForResponse((response) => response.url().includes("/gal-dir-root/entries"));
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  const root = await (await rootResponse).json();
  const sourceResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/gallery/sources");
  await picker.getByRole("button", { name: "取消选图", exact: true }).click();
  await app.getByRole("button", { name: "选择参考图…", exact: true }).click();
  const sources = await (await sourceResponse).json();
  await picker.getByRole("button", { name: "取消选图", exact: true }).click();
  await page.route("**/api/v1/gallery/sources?*", (route) => route.fulfill({ json: { ...sources, sources: [...sources.sources, { ...sources.sources[0], source_id: "second-source", root_directory_id: "second-root", display_name: "Second source" }] } }));
  await page.route("**/api/v1/gallery/directories/second-root/entries?*", (route) => route.fulfill({ json: {
    ...root, directory: { ...root.directory, directory_id: "second-root", source_id: "second-source", name: "Second source" },
    directories: [], assets: [{ ...root.assets[0], asset_id: "second-asset", source_id: "second-source", directory_id: "second-root", name: "second.jpg" }],
  } }));
  await app.getByRole("button", { name: "选择参考图…", exact: true }).click();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true })).toBeChecked();
  await picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true }).check();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-03.jpg", exact: true })).toBeDisabled();
  await picker.locator(".gallery-source").filter({ hasText: "Second source" }).click();
  await expect(picker.getByRole("checkbox", { name: "选择图片 second.jpg", exact: true })).toBeDisabled();
  await picker.locator("[data-gallery-picker-footer] summary").click();
  await picker.getByRole("button", { name: "移除参考图 old-reference-0", exact: true }).click();
  await picker.getByRole("checkbox", { name: "选择图片 second.jpg", exact: true }).check();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("combobox", { name: "范围", exact: true }).selectOption("library");
  await picker.getByRole("searchbox", { name: "搜索当前范围" }).fill("image-02");
  await picker.getByRole("button", { name: "搜索", exact: true }).click();
  await picker.getByRole("button", { name: "列表", exact: true }).click();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true })).toBeChecked();
  await picker.getByRole("combobox", { name: "TXT 状态", exact: true }).selectOption("normal");
  await expect(picker.getByRole("button", { name: "使用这 200 张", exact: true })).toBeVisible();
  await page.locator("[data-language-toggle]").evaluate((button: HTMLElement) => button.click());
  await expect(picker.getByRole("heading", { name: "Choose character references", exact: true })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Use these 200 images", exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "Use these 200 images", exact: true }).click();
  const references = app.getByRole("list", { name: "Configured reference images" });
  await expect(references.locator("li")).toHaveCount(200);
  await expect(references).toContainText("second-asset");
  await expect(references).not.toContainText("old-reference-0");
  expect(api.count("PUT", `${endpoint}/builtin-character`)).toBe(0);
  expect(api.count("POST", "/api/v1/gallery/reviews")).toBe(0);
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
