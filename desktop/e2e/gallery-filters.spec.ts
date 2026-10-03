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

async function addReference(panel: ReturnType<typeof appPage>) {
  await panel.getByRole("button", { name: "从图库添加" }).click();
  const picker = panel.locator("[data-filter-reference-picker]");
  await picker.getByRole("button", { name: "E2E 导入目录", exact: true }).click();
  await picker.getByRole("checkbox", { name: "image-02.jpg", exact: true }).check();
  await picker.getByRole("button", { name: "使用所选参考图" }).click();
}

test("图库配置：折叠摘要、三个真实过滤的阻止原因、取消过滤后完整配置与参考图发送", async ({ page }) => {
  const api = await bootDesktop(page);
  const { panel, start } = await openPanel(page);
  await expect(start).toBeDisabled();
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-style");
  await expect(panel.locator("[data-gallery-review-options]")).not.toHaveAttribute("open");
  await expect(panel.locator("[data-gallery-review-enabled]")).toContainText("基础去重");
  const blockers = panel.locator("[data-gallery-review-blockers]");
  await expect(blockers).toContainText("SSCD/DINO");
  await expect(blockers).toContainText("sketch classifier");
  await expect(start).toBeDisabled();
  await panel.locator("[data-gallery-review-options] > summary").click();
  await panel.getByRole("checkbox", { name: "非目标角色", exact: true }).check();
  await expect(blockers).toContainText("CCIP");
  await expect(blockers).toContainText("执行角色过滤前需添加参考图");
  await expect(blockers.locator("li")).toHaveCount(4);
  expect(api.count("POST", reviews)).toBe(0);
  await addReference(panel);
  await expect(blockers.locator("li")).toHaveCount(3);
  for (const name of ["单色 / 灰度", "素描", "非目标角色"]) await panel.getByRole("checkbox", { name, exact: true }).uncheck();
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
  await expect(panel).toContainText("过滤能力加载失败；未加载的过滤项不可执行。");
  await expect(panel.locator("[data-gallery-review-blockers]")).toContainText("过滤能力未加载");
  await expect(start).toBeDisabled();
  await panel.locator("[data-gallery-review-options] > summary").click();
  await panel.getByRole("checkbox", { name: "非目标角色", exact: true }).uncheck();
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
