import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { TaggerPhase } from "../src/apps/tagger/model";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

const MODEL_THRESHOLDS: Record<string, Record<string, number>> = {
  "wd-vit-v3": { general: 0.35, character: 0.85, rating: 0 },
  "wd-eva02-2026-canary": { general: 0.6094, character: 0.85, rating: 0 },
  "pixai-tagger-v1": { general: 0.17, character: 0.27, copyright: 0.24, meta: 0.17, rating: 0.41, style: 0.15 },
  "cl-tagger-v2": { general: 0.55, character: 0.55, copyright: 0.55, quality: 0.55, meta: 0.55, rating: 0.55 },
};

async function installTaggerApi(page: Page, options: { installed?: boolean; instantPrepare?: boolean; catalogSize?: number; gated?: boolean; multiModels?: boolean } = {}) {
  let installed = options.installed ?? false;
  let phase: TaggerPhase = "idle";
  let lastResult: unknown = null;
  const modelKey = options.gated ? "cl-tagger-v2" : "wd-vit-v3";
  const reads = { catalog: 0, status: 0 };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const completePrepare = () => { installed = true; phase = "idle"; };
  const completeRun = () => {
    phase = "idle";
    lastResult = {
      total: 2, per_model: { [modelKey]: { inferred: 2, cache_hits: 0 } },
      decode_errors: [], captions_written: 2, captions_skipped: 0,
    };
  };
  await page.route("**/api/v1/tagger/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let response: unknown;
    let status = 200;
    if (request.method() === "GET" && path.endsWith("/models")) {
      reads.catalog += 1;
      const keys = options.multiModels ? Object.keys(MODEL_THRESHOLDS)
        : Array.from({ length: options.catalogSize ?? 1 }, (_, index) => index === 0 ? modelKey : `extra-model-${index}`);
      response = keys.map((key, index) => ({
        key, repo: "test/model", revision: "test-revision",
        adapter: options.gated ? "cl_onnx" : "wd_onnx", gated: options.gated ?? false, license: "E2E model license",
        default_thresholds: MODEL_THRESHOLDS[key] ?? MODEL_THRESHOLDS["wd-vit-v3"], installed: installed && (options.multiModels || index === 0),
      }));
    } else if (request.method() === "GET" && path.endsWith("/status")) {
      reads.status += 1;
      response = { phase, stage: phase === "tagging" ? "inferring" : "", done: 0, total: 0,
        message: "", download: {}, last_result: lastResult, enabled: true };
    } else if (request.method() === "POST") {
      calls.push({ path, body: request.postDataJSON() });
      if (path.endsWith("/prepare")) {
        phase = "preparing";
        if (options.instantPrepare) completePrepare();
        status = 202;
      } else if (path.endsWith("/run")) {
        phase = "tagging";
        lastResult = null;
        status = 202;
      } else if (path.endsWith("/cancel")) {
        phase = "failed";
      } else {
        await route.fallback();
        return;
      }
      response = { phase };
    } else {
      await route.fallback();
      return;
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) });
  });
  return { reads, calls, completePrepare, completeRun, startRun: () => { phase = "tagging"; } };
}

function taggerPanel(page: Page) {
  return page.locator('[data-app-page][data-app-id="tagger"]');
}

test("打标：安装后可选模型，图库选择发送真实资源 ID，仅模型支持的阈值进入请求", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page);
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  api.completePrepare();
  await expect(panel.getByRole("checkbox", { name: /wd-vit-v3/ })).toBeVisible();
  expect(api.reads.catalog).toBeGreaterThan(1);
  await panel.getByRole("checkbox", { name: /wd-vit-v3/ }).check();

  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await expect(picker).toBeVisible();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
  await picker.getByRole("checkbox", { name: "选择图片 image-02.jpg" }).check();
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(panel.getByText("已选择 2 张图片 · 0 个目录", { exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: /图片目录或文件路径/ })).toHaveCount(0);
  await expect(panel.locator("textarea")).toHaveCount(0);

  await expect(panel.getByRole("textbox", { name: "一般标签阈值", exact: true })).toHaveAttribute("placeholder", "0.35");
  await expect(panel.getByRole("textbox", { name: "风格阈值", exact: true })).toHaveCount(0);
  for (const [label, value] of [["一般标签阈值", "0.4"], ["角色阈值", "0.8"], ["内容分级阈值", "0.9"]]) {
    await panel.getByRole("textbox", { name: label, exact: true }).fill(value);
  }
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], asset_ids: ["gal-asset-01", "gal-asset-02"],
    thresholds: { "wd-vit-v3": { general: 0.4, character: 0.8, rating: 0.9 } },
    write_captions: true, overwrite_captions: false,
  });
  api.completeRun();
  await expect(panel.getByText("上次：2 张，写入 2 个", { exact: true })).toBeVisible();
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：多模型按勾选顺序合并到同一 TXT，并说明去重追加规则", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true, multiModels: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  const models = panel.locator(".tagger-models");
  await models.getByRole("checkbox", { name: "pixai-tagger-v1", exact: true }).check();
  await models.getByRole("checkbox", { name: "wd-vit-v3", exact: true }).check();
  await expect(models.getByText("按勾选顺序合并到图片同名 TXT：重复标签跳过，新标签追加。", { exact: true })).toBeVisible();
  await expect(models.locator("label").filter({ hasText: "pixai-tagger-v1" }).getByText("首个模型", { exact: true })).toBeVisible();
  await expect(panel.locator(".tagger-task-facts").getByText("pixai-tagger-v1 → wd-vit-v3", { exact: true })).toBeVisible();
  await expect(panel.getByText("其余模型写入", { exact: false })).toHaveCount(0);
  await expect(panel.getByRole("checkbox", { name: "覆盖已存在的 txt", exact: true })).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("merge-desktop.png") });

  await page.setViewportSize({ width: 520, height: 800 });
  await models.scrollIntoViewIfNeeded();
  expect(await panel.locator(".tagger").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("merge-narrow.png") });
  await page.getByRole("button", { name: "切换到英文", exact: true }).click();
  await expect(models.getByText("Merge into one TXT per image in selection order: skip duplicate tags and append new ones.", { exact: true })).toBeVisible();
  await expect(models.getByText("First model", { exact: true })).toBeVisible();
  await models.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("merge-english.png") });
  await page.getByRole("button", { name: "Switch to Chinese", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });

  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true }).check();
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["pixai-tagger-v1", "wd-vit-v3"], directory_ids: ["gal-dir-root"],
    write_captions: true, overwrite_captions: false,
  });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：按模型显示默认值，多模型阈值独立且小窗口可用", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true, multiModels: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await expect(panel.getByText("请先选择打标模型，再设置对应阈值。", { exact: true })).toBeVisible();
  const group = (key: string) => panel.locator(`[data-threshold-model="${key}"]`);
  for (const [key, defaults] of Object.entries(MODEL_THRESHOLDS)) {
    await panel.getByRole("checkbox", { name: key, exact: true }).check();
    await expect(group(key).getByRole("textbox")).toHaveCount(Object.keys(defaults).length);
    for (const [category, value] of Object.entries(defaults)) {
      await expect(group(key).locator(`[id="tagger-${key}-${category}"]`)).toHaveAttribute("placeholder", String(value));
    }
  }
  await expect(group("wd-vit-v3").getByRole("textbox", { name: "元信息阈值", exact: true })).toHaveCount(0);
  await expect(group("pixai-tagger-v1").getByRole("textbox", { name: "质量标签阈值", exact: true })).toHaveCount(0);
  await expect(group("cl-tagger-v2").getByRole("textbox", { name: "风格阈值", exact: true })).toHaveCount(0);
  await expect(group("cl-tagger-v2").getByText("只控制质量标签，不过滤图片。", { exact: true })).toBeVisible();
  await group("wd-vit-v3").getByRole("textbox", { name: "一般标签阈值", exact: true }).fill("0.4");
  await expect(group("pixai-tagger-v1").getByRole("textbox", { name: "一般标签阈值", exact: true })).toHaveValue("");
  for (const [label, value] of [["一般标签阈值", "0.2"], ["版权 / 作品阈值", "0.3"], ["元信息阈值", "0.4"], ["内容分级阈值", "0.5"], ["风格阈值", "0.6"]]) {
    await group("pixai-tagger-v1").getByRole("textbox", { name: label, exact: true }).fill(value);
  }
  await group("cl-tagger-v2").getByRole("textbox", { name: "质量标签阈值", exact: true }).fill("0.7");
  await group("wd-vit-v3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("thresholds-desktop.png") });
  const accessibility = await new AxeBuilder({ page }).include('[data-app-id="tagger"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 520, height: 700 });
  expect(await panel.locator(".tagger").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await group("pixai-tagger-v1").getByRole("textbox", { name: "一般标签阈值", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("thresholds-small-window.png") });
  await page.getByRole("button", { name: "切换到英文", exact: true }).click();
  await expect(group("cl-tagger-v2").getByRole("textbox", { name: "Quality tag threshold", exact: true })).toHaveValue("0.7");
  await expect(group("cl-tagger-v2").getByText("Controls quality tags only; does not filter images.", { exact: true })).toBeVisible();
  await group("cl-tagger-v2").getByRole("textbox", { name: "Quality tag threshold", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("thresholds-english.png") });
  await page.getByRole("button", { name: "Switch to Chinese", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true }).check();
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: Object.keys(MODEL_THRESHOLDS), directory_ids: ["gal-dir-root"],
    thresholds: { "wd-vit-v3": { general: 0.4 }, "pixai-tagger-v1": { general: 0.2, copyright: 0.3, meta: 0.4, rating: 0.5, style: 0.6 }, "cl-tagger-v2": { quality: 0.7 } },
    write_captions: true, overwrite_captions: false,
  });
  await expect(group("wd-vit-v3").getByRole("textbox", { name: "一般标签阈值", exact: true })).toBeDisabled();
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：阈值就地校验，清空恢复默认，取消选择不提交残留值", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true, multiModels: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("checkbox", { name: "wd-vit-v3", exact: true }).check();
  const pixaiCheckbox = panel.getByRole("checkbox", { name: "pixai-tagger-v1", exact: true });
  await pixaiCheckbox.check();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true }).check();
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  const wd = panel.locator('[data-threshold-model="wd-vit-v3"]').getByRole("textbox", { name: "一般标签阈值", exact: true });
  const pixai = panel.locator('[data-threshold-model="pixai-tagger-v1"]').getByRole("textbox", { name: "一般标签阈值", exact: true });
  await wd.fill("1.5");
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect(wd).toBeFocused();
  await expect(wd).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByText("阈值需在 0.01 到 0.99 之间，或留空使用模型推荐值。", { exact: true })).toBeVisible();
  expect(api.calls).toEqual([]);
  await wd.fill("0.4");
  await expect(wd).toHaveAttribute("aria-invalid", "false");
  await pixai.fill("-1");
  await pixaiCheckbox.uncheck();
  await expect(pixai).toHaveCount(0);
  await pixaiCheckbox.check();
  await expect(pixai).toHaveValue("-1");
  await pixaiCheckbox.uncheck();
  await wd.fill("");
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], directory_ids: ["gal-dir-root"], write_captions: true, overwrite_captions: false,
  });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：离开页面停止轮询，后台结束后返回恢复状态和闲置轮询", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true });
  api.startRun();
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect.poll(() => api.reads.status).toBeGreaterThan(1);
  await launchApp(page, "proxy");
  api.completeRun();
  await page.waitForTimeout(100);
  const pausedReads = api.reads.status;
  await page.waitForTimeout(1200);
  expect(api.reads.status).toBe(pausedReads);
  await launchApp(page, "tagger");
  await expect(panel.getByText("上次：2 张，写入 2 个", { exact: true })).toBeVisible();
  expect(api.reads.status).toBeGreaterThan(pausedReads);
  const returnedReads = api.reads.status;
  await expect.poll(() => api.reads.status, { timeout: 3500 }).toBeGreaterThan(returnedReads);
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：下载代理校验、镜像组合与中英文窄窗口布局", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  const manager = panel.locator(".tagger-model-manager");
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await panel.getByRole("button", { name: "镜像与代理（可选）", exact: true }).click();
  const proxy = panel.getByRole("textbox", { name: "下载代理（可选）", exact: true });
  const mirror = panel.getByRole("textbox", { name: "HuggingFace 镜像（可选）", exact: true });
  await proxy.fill("socks5://127.0.0.1:7890");
  await panel.getByRole("button", { name: "收起网络设置", exact: true }).click();
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await expect(proxy).toHaveAttribute("aria-invalid", "true");
  await expect(proxy).toBeFocused();
  await expect(panel.locator("#tagger-download-proxy-error")).toContainText("代理地址格式不正确");
  expect(api.calls).toEqual([]);
  await proxy.fill(" http://127.0.0.1:7890 ");
  await mirror.fill("https://mirror.example");
  await expect(proxy).toHaveAttribute("aria-invalid", "false");
  await panel.getByRole("button", { name: "收起网络设置", exact: true }).click();
  await panel.getByRole("button", { name: "镜像与代理（已配置）", exact: true }).click();
  await expect(proxy).toHaveValue(" http://127.0.0.1:7890 ");
  await page.screenshot({ path: testInfo.outputPath("download-network-desktop.png") });
  const accessibility = await new AxeBuilder({ page }).include('[data-app-id="tagger"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 520, height: 900 });
  await manager.scrollIntoViewIfNeeded();
  expect(await panel.locator(".tagger").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("download-network-narrow.png") });
  await page.getByRole("button", { name: "切换到英文", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Download proxy (optional)", exact: true })).toHaveValue(" http://127.0.0.1:7890 ");
  await expect(panel.getByRole("textbox", { name: "HuggingFace mirror (optional)", exact: true })).toBeVisible();
  await expect(panel.getByText("Only for model downloads. Does not change the global proxy and is not saved.", { exact: true })).toBeVisible();
  await manager.scrollIntoViewIfNeeded();
  expect(await panel.locator(".tagger").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("download-network-english.png") });
  await panel.getByRole("button", { name: "Install", exact: true }).click();
  await expect.poll(() => api.calls[0]?.body).toEqual({
    models: ["wd-vit-v3"], proxy_url: "https://mirror.example", download_proxy: "http://127.0.0.1:7890",
  });
  await expect(panel.getByRole("textbox", { name: "Download proxy (optional)", exact: true })).toBeDisabled();
  await expect(panel.getByRole("textbox", { name: "HuggingFace mirror (optional)", exact: true })).toBeDisabled();
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：清空下载代理后沿用默认网络且不发送配置", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page);
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await panel.getByRole("button", { name: "镜像与代理（可选）", exact: true }).click();
  const proxy = panel.getByRole("textbox", { name: "下载代理（可选）", exact: true });
  await proxy.fill("http://127.0.0.1:7890");
  await proxy.fill("  ");
  await panel.getByRole("button", { name: "收起网络设置", exact: true }).click();
  await expect(panel.getByRole("button", { name: "镜像与代理（可选）", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await expect.poll(() => api.calls[0]?.body).toEqual({ models: ["wd-vit-v3"] });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：快速安装完成刷新模型，镜像配置保留，只选目录也能打标", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { instantPrepare: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await panel.getByRole("button", { name: "镜像与代理（可选）", exact: true }).click();
  await panel.getByRole("textbox", { name: /HuggingFace 镜像/ }).fill("https://mirror.example");
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /wd-vit-v3/ })).toBeVisible();
  expect(api.calls[0].body).toEqual({ models: ["wd-vit-v3"], proxy_url: "https://mirror.example" });
  await panel.getByRole("checkbox", { name: /wd-vit-v3/ }).check();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true }).check();
  const directory = picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true });
  await expect(picker.locator(".gallery-folder__select > span")).toBeHidden();
  const selectionBox = await picker.locator(".gallery-folder__select").boundingBox();
  expect(selectionBox?.height).toBeLessThanOrEqual(32);
  expect(await directory.evaluate((element) => {
    const label = element.closest("label")!;
    const card = label.parentElement!.querySelector(".gallery-folder")!;
    return { inputBorder: getComputedStyle(element).borderTopWidth, labelBorder: getComputedStyle(label).borderTopWidth,
      labelBackground: getComputedStyle(label).backgroundColor, cardBorder: getComputedStyle(card).borderTopWidth,
      cardOutline: getComputedStyle(card).outlineStyle, tickVisibility: getComputedStyle(element, "::before").visibility };
  })).toEqual({ inputBorder: "0px", labelBorder: "0px", labelBackground: "rgba(0, 0, 0, 0)",
    cardBorder: "0px", cardOutline: "none", tickVisibility: "visible" });
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await expect(panel.getByText("已选择 0 张图片 · 1 个目录", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], directory_ids: ["gal-dir-sub"], write_captions: true, overwrite_captions: false,
  });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：全部选择入口共用清晰圆形标记，网格列表一致，部分全选与高对比正确", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  await installTaggerApi(page, { installed: true });
  await launchApp(page, "tagger");
  await taggerPanel(page).getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  const root = picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true });
  const folder = picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true });
  const image = picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true });
  const all = picker.getByRole("checkbox", { name: "全选", exact: true });
  const currentDirectory = picker.getByRole("button", { name: "选择当前目录", exact: true });
  const indicator = currentDirectory.locator(".gallery-selection-indicator");
  const markerStyle = (marker: Locator) => marker.evaluate((element) => {
    const style = getComputedStyle(element);
    return { appearance: style.appearance, width: style.width, height: style.height, radius: style.borderRadius,
      border: style.borderTopWidth, background: style.backgroundColor, color: style.color,
      shadow: style.boxShadow, tick: getComputedStyle(element, "::before").visibility };
  });
  const unselected = await markerStyle(image);
  expect(unselected).toMatchObject({ appearance: "none", width: "24px", height: "24px", radius: "50%", border: "0px", tick: "hidden" });
  expect(unselected.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(unselected.shadow).not.toBe("none");
  for (const marker of [root, folder, all, indicator]) expect(await markerStyle(marker)).toEqual(unselected);
  expect(await picker.locator(".gallery-selection-control").evaluateAll((labels) => labels.map((label) => getComputedStyle(label).borderTopWidth)))
    .toEqual(Array(7).fill("0px"));
  await page.screenshot({ path: testInfo.outputPath("selection-unselected.png") });

  await image.focus();
  await page.keyboard.press("Space");
  await expect(image).toBeChecked();
  await expect(all).toHaveJSProperty("indeterminate", true);
  await folder.check();
  await root.check();
  await expect(currentDirectory).toHaveAttribute("aria-pressed", "true");
  const selected = await markerStyle(image);
  expect(selected.background).not.toBe(unselected.background);
  expect(selected.tick).toBe("visible");
  for (const marker of [root, folder, indicator]) expect(await markerStyle(marker)).toEqual(selected);
  expect((await markerStyle(all)).background).toBe(selected.background);
  expect(await all.evaluate((element) => {
    const dash = getComputedStyle(element, "::before");
    return { height: dash.height, leftBorder: dash.borderLeftWidth, transform: dash.transform };
  })).toEqual({ height: "2px", leftBorder: "0px", transform: "none" });
  for (const card of [picker.locator('[data-gallery-asset="gal-asset-01"]'), picker.locator(".gallery-folder")]) {
    expect(await card.evaluate((element) => ({ border: getComputedStyle(element).borderTopWidth, outline: getComputedStyle(element).outlineStyle })))
      .toEqual({ border: "0px", outline: "none" });
  }
  await page.screenshot({ path: testInfo.outputPath("selection-grid.png") });
  const accessibility = await new AxeBuilder({ page }).include("[data-gallery-picker]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);

  await all.check();
  await expect(all).toHaveJSProperty("indeterminate", false);
  await expect(folder).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-04.jpg", exact: true })).toBeChecked();
  await all.uncheck();
  await expect(root).toBeChecked(); // 全选只作用于当前显示项，不移除整个来源的选区。
  await image.check();
  await folder.check();
  await picker.getByRole("radio", { name: "列表", exact: true }).click();
  await expect(image).toBeChecked();
  expect(await markerStyle(image)).toEqual(selected);
  const row = picker.locator('.gallery-list-row[data-gallery-asset="gal-asset-01"]');
  await expect(row).toHaveAttribute("aria-selected", "true");
  const label = row.locator(".gallery-list-row__select");
  const box = await label.boundingBox();
  expect(box?.width).toBe(32);
  expect(box?.height).toBe(32);
  await page.screenshot({ path: testInfo.outputPath("selection-list.png") });
  await label.click({ position: { x: 1, y: 1 } });
  await expect(image).not.toBeChecked(); // 点击标记周围的热区只切换一次，不冒泡到列表行。
  await expect(row).toHaveAttribute("aria-selected", "false");
  await image.focus();
  await page.keyboard.press("Space");
  await expect(image).toBeChecked();

  await page.emulateMedia({ forcedColors: "active" });
  expect((await markerStyle(image)).tick).toBe("visible");
  const unchecked = picker.getByRole("checkbox", { name: "选择图片 image-02.jpg", exact: true });
  expect((await markerStyle(unchecked)).tick).toBe("hidden");
  expect((await markerStyle(unchecked)).border).not.toBe("0px");
  expect(await markerStyle(root)).toEqual(await markerStyle(image));
  expect(await markerStyle(indicator)).toEqual(await markerStyle(image));
  await page.screenshot({ path: testInfo.outputPath("selection-high-contrast.png") });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：没有子目录的来源可直接勾选根目录，键盘切换并恢复预选", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page, { galleryScenario: "flat" });
  const api = await installTaggerApi(page, { installed: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("checkbox", { name: /wd-vit-v3/ }).check();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  const root = picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true });
  await expect(root).toBeVisible();
  await root.focus();
  await page.keyboard.press("Space");
  await expect(root).toBeChecked();
  await page.keyboard.press("Space");
  await expect(root).not.toBeChecked();
  await root.check();
  expect(await root.evaluate((element) => ({
    inputBorder: getComputedStyle(element).borderTopWidth,
    labelBorder: getComputedStyle(element.closest("label")!).borderTopWidth,
    labelBackground: getComputedStyle(element.closest("label")!).backgroundColor,
    tickVisibility: getComputedStyle(element, "::before").visibility,
  }))).toEqual({ inputBorder: "0px", labelBorder: "0px", labelBackground: "rgba(0, 0, 0, 0)", tickVisibility: "visible" });
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true })).toBeVisible();
  await expect(picker.locator(".gallery-folder")).toHaveCount(0);
  await expect(picker.getByRole("button", { name: "选择当前目录", exact: true })).toHaveAttribute("aria-pressed", "true");
  const accessibility = await new AxeBuilder({ page }).include("[data-gallery-picker]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("root-directory-selected.png") });
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await expect(panel.getByText("已选择 0 张图片 · 1 个目录", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  await expect(root).toBeChecked();
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], directory_ids: ["gal-dir-root"], write_captions: true, overwrite_captions: false,
  });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：目录选区跨导航与重新选图保留，取消不改变选择，清空后不能启动", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("checkbox", { name: /wd-vit-v3/ }).check();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  const picker = page.locator("[data-gallery-picker]");
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("button", { name: "选择当前目录", exact: true }).click();
  await picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true }).check();
  await expect(picker.getByRole("checkbox", { name: "选择目录 E2E 导入目录", exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("directory-picker-light.png") });
  await picker.getByRole("checkbox", { name: "选择图片 image-01.jpg", exact: true }).check();
  await picker.locator(".gallery-folder").filter({ hasText: "subdir" }).click();
  await expect(picker.getByRole("button", { name: "选择当前目录", exact: true })).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "使用所选图片与目录", exact: true }).click();
  await expect(panel.getByText("已选择 1 张图片 · 2 个目录", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /从图库选择图片/ }).click();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await expect(picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true })).toBeChecked();
  await expect(picker.getByRole("button", { name: "选择当前目录", exact: true })).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("checkbox", { name: "选择目录 subdir", exact: true }).uncheck();
  await picker.getByRole("button", { name: "取消选图", exact: true }).click();
  await expect(panel.getByText("已选择 1 张图片 · 2 个目录", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], asset_ids: ["gal-asset-01"], directory_ids: ["gal-dir-root", "gal-dir-sub"],
    write_captions: true, overwrite_captions: false,
  });
  api.completeRun();
  await expect(panel.getByRole("button", { name: "清空选择", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(panel.getByRole("button", { name: "开始打标", exact: true })).toBeDisabled();
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：模型管理默认折叠，八个模型仅显示单行下载控件，小窗口不横向溢出", async ({ page }, testInfo) => {
  const desktopApi = await bootDesktop(page);
  await installTaggerApi(page, { catalogSize: 8 });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  const manager = panel.locator(".tagger-model-manager");
  await expect(manager).not.toHaveAttribute("open");
  await expect(panel.getByRole("button", { name: "安装", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "开始打标", exact: true })).toBeInViewport();
  const folded = await manager.boundingBox();
  expect(folded?.height).toBeLessThan(60);
  await page.screenshot({ path: testInfo.outputPath("tagger-default.png") });
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "下载模型", exact: true })).toBeVisible();
  await expect(manager.locator("option")).toHaveCount(8);
  await expect(panel.getByRole("button", { name: "安装", exact: true })).toHaveCount(1);
  const expanded = await manager.boundingBox();
  expect(expanded?.height).toBeLessThan(230);
  await page.screenshot({ path: testInfo.outputPath("tagger-model-manager.png") });
  await page.setViewportSize({ width: 800, height: 700 });
  expect(await panel.locator(".tagger").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "开始打标", exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "开始打标", exact: true })).toBeInViewport();
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：许可弹窗取消清空凭据，同意后仍能安装模型", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { gated: true, instantPrepare: true });
  await launchApp(page, "tagger");
  const panel = taggerPanel(page);
  await panel.getByRole("button", { name: "去安装模型", exact: true }).click();
  await panel.getByRole("button", { name: "镜像与代理（可选）", exact: true }).click();
  await panel.getByRole("textbox", { name: "下载代理（可选）", exact: true }).fill("http://127.0.0.1:7890");
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型许可确认", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "同意并安装", exact: true })).toBeDisabled();
  await dialog.getByLabel(/HuggingFace 访问令牌/).fill("hf_e2e_discarded");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(api.calls).toEqual([]);
  await panel.getByRole("button", { name: "安装", exact: true }).click();
  await expect(dialog.getByLabel(/HuggingFace 访问令牌/)).toHaveValue("");
  await dialog.getByRole("checkbox").check();
  await dialog.getByLabel(/HuggingFace 访问令牌/).fill("hf_e2e_download");
  await dialog.getByRole("button", { name: "同意并安装", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /cl-tagger-v2/ })).toBeVisible();
  expect(api.calls[0].body).toEqual({ models: ["cl-tagger-v2"], token: "hf_e2e_download", accept_license: true, download_proxy: "http://127.0.0.1:7890" });
  expect(desktopApi.unhandled).toEqual([]);
});

test("打标：英文界面翻译图库目录选择、管理与任务结果", async ({ page }) => {
  const desktopApi = await bootDesktop(page);
  const api = await installTaggerApi(page, { installed: true });
  await launchApp(page, "tagger");
  await page.getByRole("button", { name: "切换到英文", exact: true }).click();
  const panel = taggerPanel(page);
  await expect(panel.getByRole("heading", { name: "Image Tagging", exact: true })).toBeVisible();
  await panel.locator(".tagger-model-manager > summary").click();
  await expect(panel.getByRole("button", { name: "Mirror and proxy (optional)", exact: true })).toBeVisible();
  await panel.getByRole("checkbox", { name: /wd-vit-v3/ }).check();
  await panel.getByRole("button", { name: "Select images or folders from gallery", exact: true }).click();
  const picker = page.locator("[data-gallery-picker]");
  await expect(picker.getByRole("heading", { name: "Select gallery images and folders", exact: true })).toBeVisible();
  await picker.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await picker.getByRole("checkbox", { name: "Select folder subdir", exact: true }).check();
  await picker.getByRole("button", { name: "Use selected images and folders", exact: true }).click();
  await expect(panel.getByText("Selected 0 images · 1 folder", { exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "General tag threshold", exact: true })).toHaveAttribute("placeholder", "0.35");
  await expect(panel.getByRole("textbox", { name: "Content rating threshold", exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Metadata threshold", exact: true })).toHaveCount(0);
  await expect(panel.getByText("(no minimum score)", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Start tagging", exact: true }).click();
  await expect.poll(() => api.calls.find((call) => call.path.endsWith("/run"))?.body).toEqual({
    models: ["wd-vit-v3"], directory_ids: ["gal-dir-sub"], write_captions: true, overwrite_captions: false,
  });
  api.completeRun();
  await expect(panel.getByText("Last: 2 images, 2 captions written", { exact: true })).toBeVisible();
  expect(desktopApi.unhandled).toEqual([]);
});
