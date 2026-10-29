import type { Page } from "@playwright/test";

import { FakeDatasets } from "./fixtures/datasets";
import { expect, test } from "./fixtures/test";
import { FakeTriage, type FakeTriageInit } from "./fixtures/triage";

// 24 张图里标出 4 张：两张黑白、一张草稿、一张不像角色。命中的图默认剔除。
const FLAGS: FakeTriageInit["clean"] = [
  { asset: "a2-002", reasons: ["monochrome"] },
  { asset: "a2-005", reasons: ["rough"] },
  { asset: "a2-009", reasons: ["monochrome"] },
  { asset: "a2-013", reasons: ["filter_character"] },
];

async function setup(page: Page, init: Omit<FakeTriageInit, "clean"> = {}) {
  const datasets = new FakeDatasets();
  const id = datasets.add({ name: "角色 A", members: 24 });
  await datasets.install(page);
  const triage = new FakeTriage(datasets, id, { ...init, clean: FLAGS });
  await triage.install(page);
  await page.goto(`/#/datasets/${id}/clean`);
  return triage;
}

const removed = (page: Page) => page.getByTestId("stage-rail").locator('[data-stage="clean"] [data-removed]');
const card = (page: Page, index: number) => page.getByTestId("clean-deck").locator(`[data-testid="deck-card"][data-index="${index}"]`);

test("按默认预设运行清洗，标记的图逐批确认：留下两张、剔除两张", async ({ page }) => {
  const triage = await setup(page);

  // 没跑过：默认选「画风」预设（黑白 + 草稿），角色筛选要先选参考图。
  const options = page.getByTestId("clean-options");
  await expect(options.getByTestId("clean-preset")).toHaveText("画风");
  await expect(options.getByTestId("clean-filter_monochrome")).toHaveAttribute("aria-checked", "true");
  await expect(options.getByTestId("clean-filter_sketch")).toHaveAttribute("aria-checked", "true");
  await expect(options.getByTestId("clean-filter_character")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("triage-run").click();

  expect(triage.runs).toEqual([
    {
      stage: "clean",
      body: {
        preset_id: "builtin-style",
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

test("按原因筛选；角色筛选没有参考图时不能运行", async ({ page }) => {
  await setup(page, { ready: ["clean"] });
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(4);

  await page.getByTestId("clean-reason").getByRole("button", { name: "黑白" }).click();
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(2);
  await page.getByTestId("clean-reason").getByRole("button", { name: "不像角色" }).click();
  await expect(page.getByTestId("clean-deck").getByTestId("deck-card")).toHaveCount(1);

  // 重新运行先显示选项；打开角色筛选但没选参考图时运行按钮不可用。
  await page.getByTestId("clean-rerun").click();
  await page.getByTestId("clean-filter_character").click();
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
});
