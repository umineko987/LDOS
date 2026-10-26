import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { appPage, configureExistingDedup } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

const reviews = "/api/v1/gallery/reviews";
const presets = "/api/v1/gallery/review-presets";

async function openPanel(page: Parameters<typeof bootDesktop>[0]) {
  await launchApp(page, "gallery");
  const gallery = appPage(page, "gallery");
  await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await gallery.getByRole("checkbox", { name: "选择目录 subdir" }).check();
  await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
  await gallery.locator("[data-gallery-dedup]").click();
  const panel = gallery.locator("[data-gallery-review-confirmation]");
  await expect(panel).toBeVisible();
  return { gallery, panel, start: panel.getByRole("button", { name: "开始处理", exact: true }) };
}

for (const view of ["网格", "列表"]) {
  test(`图库根目录可在${view}视图选择并提交去重，导航和筛选不改变完整目录范围`, async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    const source = gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" });
    await source.click();
    await gallery.getByRole("radio", { name: view, exact: true }).click();
    const currentDirectory = gallery.getByRole("button", { name: "选择当前目录", exact: true });
    const summary = gallery.locator("[data-gallery-selection-summary]");
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "false");
    await currentDirectory.click();
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "true");
    await expect(summary).toContainText("1 个目录");
    await expect(gallery.getByRole("button", { name: "删除…", exact: true })).toBeDisabled();
    await expect(gallery.getByRole("checkbox", { name: "选择目录 subdir", exact: true })).not.toBeChecked();
    await currentDirectory.click();
    await expect(summary).toBeHidden();
    await currentDirectory.click();
    await gallery.getByRole("button", { name: "清除选择", exact: true }).click();
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "false");
    await expect(summary).toBeHidden();
    await currentDirectory.click();

    await gallery.locator(".gallery-folder").filter({ hasText: "subdir" }).click();
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "false");
    await expect(summary).toContainText("1 个目录");
    await expect(gallery.getByRole("button", { name: "删除…", exact: true })).toBeDisabled();
    await gallery.getByRole("button", { name: "导出目录…", exact: true }).click();
    const directoryExport = gallery.getByRole("dialog", { name: "导出完整目录" });
    await expect(directoryExport.locator(".gallery-export-selection-list li")).toHaveCount(1);
    await expect(directoryExport.locator(".gallery-export-selection-list")).toContainText("来源根目录");
    await directoryExport.getByRole("button", { name: "关闭目录导出", exact: true }).click();
    await source.click();
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "true");
    await gallery.getByRole("searchbox", { name: "搜索当前范围" }).fill("image-01");
    await gallery.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(currentDirectory).toHaveAttribute("aria-pressed", "true");
    await gallery.locator("[data-gallery-dedup]").click();
    const panel = gallery.locator("[data-gallery-review-confirmation]");
    await expect(panel).toContainText("勾选目录 1 · 勾选图片 0");
    await panel.getByText("查看选区详情", { exact: true }).click();
    await expect(panel).toContainText("E2E 导入目录 / 来源根目录");
    await configureExistingDedup(panel);
    await panel.getByRole("button", { name: "开始处理", exact: true }).click();
    await expect(page).toHaveURL(/#\/review$/);
    expect(api.requests.find(({ method, path }) => method === "POST" && path === reviews)?.body).toEqual({
      directory_ids: ["gal-dir-root"], asset_ids: [],
      filter_config: { preset_name: "画风", options: { basic_dedup: true, filter_monochrome: false, filter_sketch: false, filter_character: false, similarity_groups: true, reference_asset_ids: [] } },
    });
    expect(api.unhandled).toEqual([]);
  });
}

test("已选参考图在图库面板和预设编辑器中都使用跨来源图片请求并成功解码", async ({ page }) => {
  const api = await bootDesktop(page);
  const origin = new URL(page.url()).origin;
  // A separate loopback media server enforces the backend's configured-Origin requirement.
  const media = createServer((request, response) => {
    response.writeHead(request.headers.origin === origin ? 200 : 403, {
      "Access-Control-Allow-Origin": origin,
      "Cache-Control": "no-store",
      "Content-Type": "image/svg+xml",
    });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="gold"/></svg>');
  });
  await new Promise<void>((resolve) => media.listen(0, "127.0.0.1", resolve));
  try {
    const mediaUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/reference.svg`;
    const { panel } = await openPanel(page);
    await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-character");
    await panel.locator("[data-gallery-review-options] > summary").click();
    await addReference(panel);
    const image = panel.getByRole("list", { name: "已保存到配置的参考图" }).locator("img");
    // Desktop uses a different API origin; keep the component's image attributes unchanged.
    await image.evaluate((element: HTMLImageElement, url) => { element.src = url; }, mediaUrl);
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement, url) => element.currentSrc === url && element.complete && element.naturalWidth > 0, mediaUrl)).toBe(true);
    await panel.getByRole("button", { name: "取消", exact: true }).click();

    await launchApp(page, "filter-presets");
    const settings = appPage(page, "filter-presets");
    await settings.getByRole("button", { name: "角色 LoRA", exact: true }).click();
    await addReference(settings);
    const savedImage = settings.getByRole("list", { name: "已保存到配置的参考图" }).locator("img");
    await savedImage.evaluate((element: HTMLImageElement, url) => { element.src = url; }, mediaUrl);
    await savedImage.scrollIntoViewIfNeeded();
    await expect.poll(() => savedImage.evaluate((element: HTMLImageElement, url) => element.currentSrc === url && element.complete && element.naturalWidth > 0, mediaUrl)).toBe(true);
    expect(api.unhandled).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => media.close((error) => error ? reject(error) : resolve()));
  }
});

test("图库调用同一选择器：独立勾选、原目录搜索滚动与同一个处理面板完整恢复", async ({ page }) => {
  const api = await bootDesktop(page);
  await launchApp(page, "gallery");
  const gallery = appPage(page, "gallery");
  await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(gallery.getByRole("status").filter({ hasText: "扫描完成" })).toBeVisible();
  await gallery.getByRole("checkbox", { name: "选择目录 subdir", exact: true }).check();
  await gallery.getByRole("searchbox", { name: "搜索当前范围" }).fill("image-");
  await gallery.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(gallery.getByRole("checkbox", { name: "选择目录 subdir", exact: true })).toHaveCount(0);
  await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).check();
  const scroll = await gallery.getByLabel("图片网格", { exact: true }).evaluate((element) => { element.scrollTop = 77; return element.scrollTop; });
  await gallery.locator("[data-gallery-dedup]").click();
  const panel = gallery.locator("[data-gallery-review-confirmation]");
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-character");
  await panel.locator("[data-gallery-review-options] > summary").click();
  await panel.getByRole("checkbox", { name: "基础去重", exact: true }).uncheck();
  await panel.getByRole("button", { name: "另存为预设", exact: true }).click();
  await panel.getByLabel("新预设名称").fill("Unsaved panel name");
  const originalDialog = await panel.elementHandle();
  await panel.getByRole("button", { name: "选择参考图…", exact: true }).click();
  const picker = page.locator("[data-gallery-picker]");
  await expect(panel).not.toBeVisible();
  await expect(picker).toContainText("来自『图库 / 本次去重与筛选』");
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("searchbox", { name: "搜索当前范围" })).toHaveValue("");
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true })).not.toBeChecked();
  await panel.dispatchEvent("cancel", { cancelable: true });
  await picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true }).check();
  await picker.getByRole("button", { name: "使用这 1 张", exact: true }).click();
  await expect(panel).toBeVisible();
  expect(await originalDialog?.evaluate((dialog) => dialog === document.querySelector('[data-app-id="gallery"] [data-gallery-review-confirmation]'))).toBe(true);
  await expect(panel.getByRole("button", { name: "选择参考图…", exact: true })).toBeFocused();
  await expect(panel.getByLabel("新预设名称")).toHaveValue("Unsaved panel name");
  await expect(panel.getByRole("checkbox", { name: "基础去重", exact: true })).not.toBeChecked();
  await expect(panel.locator("[data-gallery-review-options]")).toHaveAttribute("open");
  await expect(panel.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  await expect(panel).toContainText("勾选目录 1 · 勾选图片 1");
  await panel.getByRole("button", { name: "选择参考图…", exact: true }).click();
  await picker.locator("[data-gallery-picker-footer] summary").click();
  await picker.getByRole("button", { name: "移除参考图 gal-asset-02", exact: true }).click();
  await page.evaluate(() => { location.hash = "#/tasks"; });
  await expect(picker).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/#\/gallery$/);
  await expect(panel.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(gallery.getByRole("searchbox", { name: "搜索当前范围" })).toHaveValue("image-");
  await expect(gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true })).toBeChecked();
  expect(await gallery.getByLabel("图片网格", { exact: true }).evaluate((element) => element.scrollTop)).toBe(scroll);
  await gallery.getByRole("searchbox", { name: "搜索当前范围" }).fill("");
  await gallery.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(gallery.getByRole("checkbox", { name: "选择目录 subdir", exact: true })).toBeChecked();
  expect(api.count("POST", reviews)).toBe(0);
  expect(api.count("POST", presets)).toBe(0);
  expect(api.count("PUT", `${presets}/builtin-character`)).toBe(0);
  expect(api.unhandled).toEqual([]);
});

async function addReference(panel: ReturnType<typeof appPage>) {
  await panel.getByRole("button", { name: "选择参考图…" }).click();
  const picker = panel.page().locator("[data-gallery-picker]");
  await expect(panel).not.toBeVisible();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true }).check();
  await picker.getByRole("button", { name: "使用这 1 张", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "选择参考图…" })).toBeFocused();
}

test("图库配置：折叠摘要、三个真实过滤的阻止原因、取消过滤后完整配置与参考图发送", async ({ page }) => {
  const api = await bootDesktop(page);
  const { panel, start } = await openPanel(page);
  await expect(start).toBeDisabled();
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-style");
  await expect(panel.locator("[data-gallery-review-options]")).not.toHaveAttribute("open");
  await expect(panel.locator("[data-gallery-review-enabled]")).toContainText("基础去重");
  const blockers = panel.locator("[data-gallery-review-blockers]");
  await expect(blockers).toContainText("completeness");
  await expect(blockers).toContainText("completeness");
  await expect(start).toBeDisabled();
  await panel.locator("[data-gallery-review-options] > summary").click();
  await panel.getByRole("checkbox", { name: "非目标角色", exact: true }).check();
  await expect(blockers).toContainText("ccip");
  await expect(blockers).toContainText("执行角色过滤前需添加参考图");
  await expect(blockers.locator("li")).toHaveCount(4);
  expect(api.count("POST", reviews)).toBe(0);
  await addReference(panel);
  await expect(blockers.locator("li")).toHaveCount(3);
  for (const name of ["单色", "线稿/草图", "非目标角色"]) await panel.getByRole("checkbox", { name, exact: true }).uncheck();
  await expect(start).toBeEnabled();
  await panel.getByText("查看选区详情", { exact: true }).click();
  await expect(panel).toContainText("E2E 导入目录 / subdir");
  await expect(panel).toContainText("勾选的 1 张图片");
  const accessibility = await new AxeBuilder({ page }).include("[data-gallery-review-confirmation]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await start.click();
  await expect(page).toHaveURL(/#\/review$/);
  expect(api.requests.find(({ method, path }) => method === "POST" && path === reviews)?.body).toEqual({
    directory_ids: ["gal-dir-sub"], asset_ids: ["gal-asset-01"],
    filter_config: { preset_name: "画风", options: { basic_dedup: true, filter_monochrome: false, filter_sketch: false, filter_character: false, similarity_groups: true, reference_asset_ids: ["gal-asset-02"] } },
  });
  const review = appPage(page, "review");
  await review.locator("[data-review-filter-config] > summary").click();
  await expect(review.locator("[data-review-reference-count]")).toHaveText("1");
  await expect(review.getByRole("list", { name: "本次参考图" })).toContainText("gal-asset-02");
  expect(api.unhandled).toEqual([]);
});

test("另存不覆盖，管理预设往返保留选区与草稿，审核展示只读冻结快照和旧任务", async ({ page }) => {
  const api = await bootDesktop(page);
  const { gallery, panel, start } = await openPanel(page);
  await configureExistingDedup(panel);
  await addReference(panel);
  await panel.getByRole("button", { name: "另存为预设", exact: true }).click();
  await panel.getByLabel("新预设名称").fill("Saved copy");
  await panel.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(panel.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  expect(api.count("POST", presets)).toBe(1);
  expect(api.count("PUT", presets)).toBe(0);
  await panel.getByRole("checkbox", { name: "基础去重", exact: true }).uncheck();
  await panel.getByRole("button", { name: "另存为预设", exact: true }).click();
  await panel.getByLabel("新预设名称").fill("Uncommitted name");
  const reads = api.count("GET", "/api/v1/gallery/directories/gal-dir-root/entries");
  await panel.getByRole("button", { name: "管理预设…", exact: true }).click();
  await expect(page).toHaveURL(/#\/filter-presets$/);
  // A native cancel arriving after navigation must not discard Gallery's draft.
  await panel.dispatchEvent("cancel", { cancelable: true });
  const settings = appPage(page, "filter-presets");
  await settings.getByRole("button", { name: "Saved copy", exact: true }).click();
  await settings.getByLabel("预设名称").fill("Changed later");
  await settings.getByRole("checkbox", { name: "相似图片分组", exact: true }).uncheck();
  await settings.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(settings.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await launchApp(page, "gallery");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("新预设名称")).toHaveValue("Uncommitted name");
  await expect(panel.locator("[data-gallery-review-enabled]")).toContainText("Saved copy");
  await expect(panel.getByRole("checkbox", { name: "基础去重", exact: true })).not.toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "相似图片分组", exact: true })).toBeChecked();
  expect(api.count("GET", "/api/v1/gallery/directories/gal-dir-root/entries")).toBe(reads);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(gallery.getByRole("checkbox", { name: "选择目录 subdir" })).toBeChecked();
  await expect(gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" })).toBeChecked();
  await gallery.locator("[data-gallery-dedup]").click();
  await expect(panel.getByLabel("选择预设", { exact: true })).toHaveValue("preset-1");
  await panel.locator("[data-gallery-review-options] > summary").click();
  await expect(panel.getByRole("checkbox", { name: "基础去重", exact: true })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "相似图片分组", exact: true })).not.toBeChecked();
  const response = page.waitForResponse((response) => /\/api\/v1\/gallery\/reviews\/review-created-\d+\?/.test(response.url()));
  await start.click();
  const frozen = await (await response).json();
  const review = appPage(page, "review");
  const config = review.locator("[data-review-filter-config]");
  await config.locator("summary").click();
  await expect(config).toContainText("Changed later");
  await expect(config.getByRole("checkbox")).toHaveCount(0);
  await expect(config.locator("input, select")).toHaveCount(0);
  await launchApp(page, "filter-presets");
  await settings.getByLabel("预设名称").fill("After task");
  await settings.getByRole("button", { name: "保存预设", exact: true }).click();
  await expect(settings.getByText("筛选预设已保存。", { exact: true })).toBeVisible();
  await launchApp(page, "review");
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(config).toContainText("Changed later");
  await expect(config).not.toContainText("After task");
  await page.route(`**${reviews}/${frozen.review_id}?*`, (route) => route.fulfill({ json: { ...frozen, totalImageCount: 7, automaticRejectedImageCount: 3, filteredImageCount: 2 } }));
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(review.locator("[data-review-directories]")).toContainText("机器初筛回收 3 张");
  await expect(review.locator("[data-review-filtered-count]")).toContainText("2");
  await page.route(`**${reviews}/${frozen.review_id}?*`, (route) => {
    const legacy = { ...frozen }; delete legacy.filter_config; delete legacy.filteredImageCount;
    return route.fulfill({ json: legacy });
  });
  await review.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(config).toHaveCount(0);
  await expect(review.getByRole("alert")).toHaveCount(0);
  expect(api.unhandled).toEqual([]);
});

test("能力加载失败不能当作可用；后端 409 原因和 422 参考图错误保留草稿", async ({ page }) => {
  await bootDesktop(page, { failPaths: ["/api/v1/setup/models"] });
  const { panel, start } = await openPanel(page);
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-character");
  await expect(panel).toContainText("fixture_failure: 模拟服务错误");
  await expect(panel.locator("[data-gallery-review-blockers]")).toContainText("过滤能力未加载");
  await expect(start).toBeDisabled();
  await panel.locator("[data-gallery-review-options] > summary").click();
  await panel.getByRole("checkbox", { name: "非目标角色", exact: true }).uncheck();
  await expect(start).toBeDisabled();
  await page.route("**/api/v1/setup/models", (route) => route.fulfill({ json: {
    phase: "ready", installed: true, enabled: true, using_proxy: false, downloaded_bytes: 190_000_000, expected_bytes: 190_000_000, message: "", requested_models: ["dedup"],
    models: { sscd: { installed: true }, dino: { installed: true } },
    review_filters: { filter_monochrome: { available: false, reason: "missing" }, filter_character: { available: false, reason: "missing" }, filter_sketch: { available: false, reason: "deferred" } },
  } }));
  await panel.getByRole("button", { name: "刷新模型能力", exact: true }).click();
  await expect(start).toBeEnabled();
  await page.route(`**${reviews}`, (route) => route.fulfill({ status: 409, json: { error: { code: "review_filter_unavailable", message: "Unavailable", details: { filters: [{ option: "filter_character", reason: "Capability changed before submission" }] } } } }));
  await start.click();
  await expect(panel).toContainText("review_filter_unavailable");
  await expect(panel).toContainText("Capability changed before submission");
  await page.route(`**${reviews}`, (route) => route.fulfill({ status: 422, json: { error: { code: "filter_reference_invalid", message: "Reference image is no longer available" } } }));
  await start.click();
  await expect(panel).toContainText("filter_reference_invalid");
  await expect(panel).toContainText("Reference image is no longer available");
  await expect(panel.getByRole("checkbox", { name: "基础去重", exact: true })).toBeChecked();
  await page.locator("[data-language-toggle]").evaluate((button: HTMLElement) => button.click());
  await expect(panel.getByRole("heading", { name: "Deduplication and filtering", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start processing", exact: true })).toBeEnabled();
});
