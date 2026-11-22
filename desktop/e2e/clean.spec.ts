import type { Page } from "@playwright/test";

import { FakeDatasets } from "./fixtures/datasets";
import { mockInstall, mockModelsBackend, type ModelItem } from "./fixtures/settings";
import { expect, test } from "./fixtures/test";
import { FakeTriage, TRIAGE_MODELS, type FakeTriageInit } from "./fixtures/triage";

// 24 张图里标出 4 张：两张黑白、一张草稿、一张不像角色。命中的图默认剔除。
const FLAGS: FakeTriageInit["clean"] = [
  { asset: "a2-002", reasons: ["monochrome"] },
  { asset: "a2-005", reasons: ["rough"] },
  { asset: "a2-009", reasons: ["monochrome"] },
  { asset: "a2-013", reasons: ["filter_character"] },
];

async function setup(page: Page, init: Omit<FakeTriageInit, "clean"> = {}, models?: ModelItem[]) {
  const datasets = new FakeDatasets();
  const id = datasets.add({ name: "角色 A", members: 24 });
  await datasets.install(page);
  const triage = new FakeTriage(datasets, id, { ...init, clean: FLAGS });
  await triage.install(page);
  if (models) await mockModelsBackend(page, { models: () => models });
  await page.goto(`/#/datasets/${id}/clean`);
  return triage;
}

const removed = (page: Page) => page.getByTestId("stage-rail").locator('[data-stage="clean"] [data-removed]');
const card = (page: Page, index: number) => page.getByTestId("clean-deck").locator(`[data-testid="deck-card"][data-index="${index}"]`);

test("按默认勾选运行清洗，标记的图逐批确认：留下两张、剔除两张", async ({ page }) => {
  const triage = await setup(page);

  // 直接显示独立的过滤开关，默认勾选黑白和草稿。
  const options = page.getByTestId("clean-options");
  await expect(page.getByRole("heading", { name: "清洗选项" })).toBeVisible();
  await expect(options.getByTestId("clean-preset")).toHaveCount(0);
  await expect(options.getByTestId("clean-filter_monochrome")).toHaveAttribute("aria-checked", "true");
  await expect(options.getByTestId("clean-filter_sketch")).toHaveAttribute("aria-checked", "true");
  await expect(options.getByTestId("clean-filter_character")).toHaveAttribute("aria-checked", "false");
  await expect(options.getByTestId("clean-filter_monochrome")).toHaveAccessibleDescription(/deepghs\/monochrome_detect.*mobilenetv3_large_100_dist.*0\.50/);
  await expect(options.getByTestId("clean-filter_sketch")).toHaveAccessibleDescription(/Anime Completeness.*384 × 384.*不设分数阈值.*若同时命中，只显示为草稿/);
  await expect(options.getByText(/CCIP/)).toHaveCount(0);
  await page.getByTestId("triage-run").click();

  expect(triage.runs).toEqual([
    {
      stage: "clean",
      body: {
        options: { filter_monochrome: true, filter_sketch: true, filter_character: false, reference_asset_ids: [] },
      },
    },
  ]);

  // 一批 4 张，都带着原因，默认剔除。
  await expect(page.getByTestId("clean-counter")).toHaveText("第 1 / 1 组");
  await expect(page.getByTestId("clean-progress")).toHaveText("标记 4 张 · 待定 4 张");
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(4);
  await expect(card(page, 0).getByTestId("clean-reason-chip")).toHaveText("黑白");
  await expect(card(page, 1).getByTestId("clean-reason-chip")).toHaveText("草稿");
  for (const index of [0, 1, 2, 3]) await expect(card(page, index)).not.toHaveAttribute("data-kept", "true");

  // 3、4 改成保留，Enter 提交：剔除 1、2 两张。
  await page.keyboard.press("3");
  await page.keyboard.press("4");
  await expect(card(page, 2)).toHaveAttribute("data-kept", "true");
  await expect(card(page, 3)).toHaveAttribute("data-kept", "true");
  await page.keyboard.press("Enter");

  await expect(page.getByText("保留 2 张 · 剔除 2 张")).toBeVisible();
  expect(triage.applies.at(-1)?.body.groups).toEqual([
    { group_id: "clean:a2-002", keep: [] },
    { group_id: "clean:a2-005", keep: [] },
    { group_id: "clean:a2-009", keep: ["a2-009"] },
    { group_id: "clean:a2-013", keep: ["a2-013"] },
  ]);
  await expect(removed(page)).toHaveText("−2");
  await expect(page.getByTestId("clean-done")).toBeVisible();
  await expect(page.getByTestId("clean-progress")).toHaveText("标记 4 张 · 待定 0 张");
  await expect(card(page, 0).getByTestId("deck-card-verdict")).toHaveText("已剔除");

  // 用 Toast 上的撤销按钮撤回。
  await page.getByRole("button", { name: "撤销" }).last().click();
  await expect(page.getByText("已撤销 4 组")).toBeVisible();
  await expect(removed(page)).toHaveCount(0);
});

test("按开启的清洗选项安装独立模型", async ({ page }) => {
  const models = TRIAGE_MODELS.map<ModelItem>((item) =>
    item.key === "monochrome" || item.key === "completeness" ? { ...item, status: "missing", installed_bytes: 0 } : item,
  );
  const installs: string[][] = [];
  await mockInstall(page, ({ keys }) => {
    installs.push(keys);
    return { body: { items: models, started: [] } };
  });
  await setup(page, {}, models);

  const gate = page.getByTestId("model-gate");
  await expect(gate.locator("[data-gate-model]")).toHaveText([/^monochrome\b/, /^completeness\b/]);
  await expect(page.getByTestId("triage-run")).toBeDisabled();

  await page.getByTestId("clean-filter_monochrome").click();
  await expect(gate.locator("[data-gate-model]")).toHaveText([/^completeness\b/]);
  await expect(page.getByTestId("clean-filter_sketch")).not.toHaveAccessibleDescription(/若同时命中/);

  await page.getByTestId("clean-filter_monochrome").click();
  await page.getByTestId("clean-filter_sketch").click();
  await expect(gate.locator("[data-gate-model]")).toHaveText([/^monochrome\b/]);
  await gate.getByRole("button", { name: "安装缺失模型" }).click();
  await expect.poll(() => installs).toEqual([["monochrome"]]);
});

test("按原因筛选；重新运行只提交独立勾选的角色筛选和参考图", async ({ page }) => {
  const triage = await setup(page, { ready: ["clean"] });
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(4);

  await page.getByTestId("clean-reason").getByRole("button", { name: "黑白" }).click();
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(2);
  await page.getByTestId("clean-reason").getByRole("button", { name: "不像角色" }).click();
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(1);

  // 两个默认开关都可以关闭；至少要选一个过滤器。
  await page.getByTestId("clean-rerun").click();
  await page.getByTestId("clean-filter_monochrome").click();
  await page.getByTestId("clean-filter_sketch").click();
  await expect(page.getByTestId("clean-options").getByText(/Anime Completeness/)).toHaveCount(0);
  await expect(page.getByTestId("clean-run-issue")).toBeVisible();
  await expect(page.getByTestId("triage-run")).toBeDisabled();

  // 角色筛选可以单独开启，但要先选参考图。
  await page.getByTestId("clean-filter_character").click();
  await expect(page.getByTestId("clean-filter_character")).toHaveAccessibleDescription(/CCIP.*384 × 384.*每张参考图的距离都大于 0\.35/);
  await expect(page.getByTestId("clean-run-issue")).toHaveText("角色筛选需要先选参考图。");
  await expect(page.getByTestId("triage-run")).toBeDisabled();

  // 从数据集里挑两张参考图。
  await page.getByTestId("clean-references").click();
  const dialog = page.getByTestId("clean-references-dialog");
  await dialog.getByTestId("clean-reference").nth(0).click();
  await dialog.getByTestId("clean-reference").nth(1).click();
  await dialog.getByTestId("clean-references-done").click();
  await expect(page.getByTestId("clean-references")).toHaveText("参考图 2 张");
  await expect(page.getByTestId("clean-run-issue")).toHaveCount(0);
  await expect(page.getByTestId("triage-run")).toBeEnabled();
  await page.getByTestId("triage-run").click();
  await expect.poll(() => triage.runs).toEqual([
    {
      stage: "clean",
      body: {
        options: { filter_monochrome: false, filter_sketch: false, filter_character: true, reference_asset_ids: ["a2-001", "a2-002"] },
      },
    },
  ]);
});
