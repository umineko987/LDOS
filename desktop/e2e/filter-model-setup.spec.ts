import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { appPage } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

const install = "/api/v1/setup/models/install";
const models = "/api/v1/setup/models";

async function galleryPanel(page: Page, preset = "builtin-style") {
  await launchApp(page, "gallery");
  const gallery = appPage(page, "gallery");
  await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
  await gallery.locator("[data-gallery-dedup]").click();
  const panel = gallery.locator("[data-gallery-review-confirmation]");
  await panel.getByLabel("选择预设", { exact: true }).selectOption(preset);
  await panel.locator("[data-gallery-review-options] > summary").click();
  return { panel, start: panel.getByRole("button", { name: "开始处理", exact: true }) };
}
async function reference(panel: ReturnType<typeof appPage>) {
  await panel.getByRole("button", { name: "从图库添加", exact: true }).click();
  await panel.getByRole("button", { name: "E2E 导入目录", exact: true }).click();
  await panel.getByRole("checkbox", { name: "image-02.jpg", exact: true }).check();
  await panel.getByRole("button", { name: "使用所选参考图", exact: true }).click();
}
async function confirm(panel: ReturnType<typeof appPage>) {
  await panel.getByRole("button", { name: /^(准备已选过滤模型|重试准备模型)$/ }).click();
  return panel.locator("[data-filter-model-confirmation]");
}

test("Gallery explicitly prepares only missing checked filters; sketch still requires cancellation", async ({ page }) => {
  const api = await bootDesktop(page);
  const { panel, start } = await galleryPanel(page);
  await panel.getByRole("checkbox", { name: "非目标角色", exact: true }).check();
  await reference(panel);
  await expect(start).toBeDisabled();
  const confirmation = await confirm(panel);
  await expect(confirmation).toContainText("16.8 MB");
  await expect(confirmation).toContainText("150.3 MB");
  expect(api.count("POST", install)).toBe(0);
  expect(await panel.locator("dialog").count()).toBe(0);
  const proxy = confirmation.getByLabel("本次下载代理（可选）", { exact: true });
  await proxy.fill("127.0.0.1:7890");
  await confirmation.getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("代理地址格式不正确");
  expect(api.count("POST", install)).toBe(0);
  await proxy.fill("http://127.0.0.1:7890");
  const accessibility = await new AxeBuilder({ page }).include("[data-filter-model-confirmation]").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await confirmation.getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toBeVisible();
  await expect(start).toBeDisabled();
  expect(api.requests.find(({ method, path }) => method === "POST" && path === install)?.body).toEqual({ proxy_url: "http://127.0.0.1:7890", models: ["monochrome", "ccip"] });
  await expect(panel.locator('[data-filter-capability="filter_monochrome"]')).toContainText("过滤能力已就绪");
  await expect(panel.locator('[data-filter-capability="filter_character"]')).toContainText("过滤能力已就绪");
  await expect(start).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: "素描", exact: true })).toBeChecked();
  await panel.getByRole("checkbox", { name: "素描", exact: true }).uncheck();
  await expect(start).toBeEnabled();
  await expect(panel.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  expect(api.count("PUT", "/api/v1/gallery/review-presets")).toBe(0);
  await start.click();
  await expect(page).toHaveURL(/#\/review$/);
  expect(api.unhandled).toEqual([]);
});

test("Settings prepares CCIP without editing builtin presets; Gallery refreshes the same capability", async ({ page }) => {
  const api = await bootDesktop(page);
  await launchApp(page, "filter-presets");
  const settings = appPage(page, "filter-presets");
  await settings.getByRole("button", { name: "角色 LoRA", exact: true }).click();
  await expect(settings.getByRole("checkbox", { name: "非目标角色", exact: true })).toBeDisabled();
  const confirmation = await confirm(settings);
  await expect(confirmation.getByRole("list")).toContainText("150.3 MB");
  await expect(confirmation.getByRole("list")).not.toContainText("单色模型");
  await page.locator("[data-language-toggle]").evaluate((element: HTMLElement) => element.click());
  await expect(confirmation.getByRole("button", { name: "Confirm preparation", exact: true })).toBeVisible();
  await expect(confirmation.getByLabel("Download proxy (optional)")).toBeVisible();
  await page.locator("[data-language-toggle]").evaluate((element: HTMLElement) => element.click());
  await confirmation.getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(settings.getByRole("progressbar")).toBeVisible();
  await expect(settings.locator('[data-filter-capability="filter_character"]')).toContainText("过滤能力已就绪");
  expect(api.requests.find(({ method, path }) => method === "POST" && path === install)?.body).toEqual({ proxy_url: "", models: ["ccip"] });
  const { panel, start } = await galleryPanel(page, "builtin-character");
  await reference(panel);
  await expect(start).toBeEnabled();
  await expect(panel.getByRole("checkbox", { name: "非目标角色", exact: true })).toBeChecked();
  expect(api.count("POST", install)).toBe(1);
  expect(api.unhandled).toEqual([]);
});

test("Real install errors and failed capability refresh stay blocked and can be retried", async ({ page }) => {
  const api = await bootDesktop(page);
  const { panel, start } = await galleryPanel(page);
  await panel.getByRole("checkbox", { name: "素描", exact: true }).uncheck();
  let fail = true;
  await page.route(`**${install}`, async (route) => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { code: "model_download_failed", message: "Actual download failure" } } }); }
    else await route.fallback();
  });
  await (await confirm(panel)).getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "Actual download failure" })).toBeVisible();
  await expect(start).toBeDisabled();
  await confirm(panel);
  await page.route(`**${models}`, (route) => route.fulfill({ status: 503, json: { error: { code: "probe_failed", message: "Offline probe failed" } } }));
  await panel.getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "Offline probe failed" })).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: "单色 / 灰度", exact: true })).toBeChecked();
  await page.unroute(`**${models}`);
  await panel.getByRole("button", { name: "刷新过滤能力", exact: true }).click();
  await expect(start).toBeEnabled();
  expect(api.requests.filter(({ method, path }) => method === "POST" && path === install).every(({ body }) => JSON.stringify(body).includes('"models":["monochrome"]'))).toBe(true);
  expect(api.unhandled).toEqual([]);
});

test("Filtering-only ready does not claim SSCD/DINO are enabled or bypass the backend entry gate", async ({ page }) => {
  const api = await bootDesktop(page, { baseModelsReady: false });
  const { panel, start } = await galleryPanel(page);
  for (const name of ["素描", "基础去重", "相似图片分组"]) await panel.getByRole("checkbox", { name, exact: true }).uncheck();
  await (await confirm(panel)).getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(panel.locator('[data-filter-capability="filter_monochrome"]')).toContainText("过滤能力已就绪");
  await expect(start).toBeDisabled();
  await expect(panel.locator("[data-gallery-review-base-blocker]")).toContainText("即使本次仅过滤");
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await launchApp(page, "review");
  const review = appPage(page, "review");
  const setup = review.locator(".review-model-setup");
  await expect(setup).toHaveAttribute("data-phase", "idle");
  await expect(setup).not.toContainText("已启用");
  await setup.getByRole("button", { name: "下载并启用", exact: true }).click();
  await expect(review.locator(".review-model-confirmation")).toContainText("190");
  await review.getByRole("button", { name: "开始下载", exact: true }).click();
  await expect(setup.locator("summary")).toContainText("已启用");
  expect(api.requests.filter(({ method, path }) => method === "POST" && path === install).map(({ body }) => body)).toEqual([
    { proxy_url: "", models: ["monochrome"] }, { proxy_url: "" },
  ]);
  expect(api.unhandled).toEqual([]);
});

test("Polling pauses when inactive and preset switches cannot overwrite the current draft", async ({ page }) => {
  const api = await bootDesktop(page);
  const { panel } = await galleryPanel(page);
  await panel.getByRole("checkbox", { name: "素描", exact: true }).uncheck();
  await (await confirm(panel)).getByRole("button", { name: "确认准备", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toBeVisible();
  await panel.getByLabel("选择预设", { exact: true }).selectOption("builtin-character");
  await expect(panel.getByRole("checkbox", { name: "单色 / 灰度", exact: true })).not.toBeChecked();
  await reference(panel);
  await panel.getByRole("button", { name: "另存为预设", exact: true }).click();
  await panel.getByLabel("新预设名称").fill("Temporary draft");
  await panel.getByRole("button", { name: "管理预设…", exact: true }).click();
  await launchApp(page, "diagnostics");
  await page.waitForTimeout(250);
  const count = api.count("GET", models);
  await page.waitForTimeout(1100);
  expect(api.count("GET", models)).toBe(count);
  await launchApp(page, "gallery");
  await expect(panel.getByLabel("新预设名称")).toHaveValue("Temporary draft");
  await expect(panel.getByRole("checkbox", { name: "非目标角色", exact: true })).toBeChecked();
  await expect(panel.getByRole("list", { name: "已保存到配置的参考图" })).toContainText("gal-asset-02");
  await expect(panel.locator('[data-filter-capability="filter_character"]')).toContainText("暂不可执行");
  expect(api.count("POST", install)).toBe(1);
  expect(api.unhandled).toEqual([]);
});
