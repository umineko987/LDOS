import type { Page } from "@playwright/test";

import { MODELS, installing, mockInstall, mockModelsBackend, model, type ModelItem } from "./fixtures/settings";
import { expect, test } from "./fixtures/test";

async function runCommand(page: Page, id: string, label: string | RegExp) {
  await page.keyboard.press("Control+k");
  const command = page.getByRole("dialog").locator(`[data-command-id="${id}"]`);
  await expect(command).toHaveText(label);
  await command.click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
}

test("命令面板：切换减少动效、密度和界面语言", async ({ page }) => {
  await page.goto("/#/settings/preferences");
  await expect(page.getByTestId("preferences")).toBeVisible();
  const html = page.locator("html");

  // 测试环境的系统设置是「减少动态效果」，所以命令是关闭它。
  await runCommand(page, "settings.prefs.motion", "关闭减少动效");
  await expect(html).toHaveAttribute("data-motion", "full");
  await runCommand(page, "settings.prefs.motion", "开启减少动效");
  await expect(html).toHaveAttribute("data-motion", "reduced");

  await runCommand(page, "settings.prefs.density", "使用舒适密度");
  await expect(html).toHaveAttribute("data-density", "comfortable");
  await expect(page.locator('[data-pref="density"] [data-value="comfortable"]')).toHaveAttribute("aria-pressed", "true");
  await runCommand(page, "settings.prefs.density", "使用紧凑密度");
  // 紧凑是默认值，<html> 上不留属性。
  await expect(html).not.toHaveAttribute("data-density", /.+/);
  expect(await page.evaluate(() => [localStorage.getItem("ldos.motion"), localStorage.getItem("ldos.density")])).toEqual(["on", "compact"]);

  await runCommand(page, "settings.prefs.language", "切换界面语言：English");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("sidebar")).toContainText("Settings");
  await runCommand(page, "settings.prefs.language", "Switch language: 中文");
  await expect(html).toHaveAttribute("lang", "zh-CN");
});

test("命令面板：安装缺失模型，受限模型先确认许可", async ({ page }) => {
  let table: ModelItem[] = MODELS;
  const bodies: unknown[] = [];
  let listed = 0;
  await mockModelsBackend(page, {
    models: () => {
      listed += 1;
      return table;
    },
  });
  await mockInstall(page, (body) => {
    bodies.push(body);
    table = installing(table, body.keys);
    return { body: { items: table, started: [{ family: "dedup", keys: body.keys, job_id: "models:dedup", proxy_source: "none" }] } };
  });
  await page.goto("/#/settings/preferences");
  await expect(page.getByTestId("preferences")).toBeVisible();
  // 面板动作挂在每一页，但模型表要到第一次执行时才拉。
  expect(listed).toBe(0);

  await runCommand(page, "settings.models.install-missing", "安装缺失模型");
  const dialog = page.getByTestId("model-license-dialog");
  await expect(dialog.locator('[data-license-model="cl-tagger-v2"]')).toContainText("cl-tagger-license");
  await page.getByTestId("model-license-accept").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toContainText("已开始安装 3 个模型");
  expect(bodies).toEqual([{ keys: ["sscd", "dino", "cl-tagger-v2"], accept_license: true }]);
});

test("命令面板：没有缺失模型时只提示", async ({ page }) => {
  await mockModelsBackend(page, { models: () => [model("sscd", { status: "installed" }), model("ccip", { status: "installed" })] });
  await page.goto("/#/settings/preferences");
  await expect(page.getByTestId("preferences")).toBeVisible();

  await runCommand(page, "settings.models.install-missing", "安装缺失模型");
  await expect(page.locator("[data-sonner-toast]")).toContainText("需要的模型都已安装");
});
