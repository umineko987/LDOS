import type { Page } from "@playwright/test";

import { FakeCaptions } from "./fixtures/captions";
import { FakeDatasets } from "./fixtures/datasets";
import { expect, test } from "./fixtures/test";

// 校对段 = 标签工作室：查询过滤 → 选中 → 检查器里删标签（dry-run 差异 → 写入）→ toast 撤销；
// 逐张校对：Enter 通过并下一张，T 加标签（单张写回），Z 撤销，Esc 回到网格。

const TOTAL = 12;
const WITH_HAT = 9;

const assetId = (index: number) => `a2-${String(index + 1).padStart(3, "0")}`;

let captions: FakeCaptions;

test.beforeEach(async ({ page }) => {
  const datasets = new FakeDatasets();
  datasets.add({ name: "studio", members: TOTAL, trigger_word: "sks" });
  await datasets.install(page);
  captions = new FakeCaptions(datasets);
  for (let index = 0; index < TOTAL; index += 1) {
    captions.set(assetId(index), index < WITH_HAT ? "sks, 1girl, hat, solo" : "sks, 1girl, long_hair");
  }
  await captions.install(page);
});

function count(page: Page) {
  return page.getByTestId("studio-count");
}

function cell(page: Page, index: number) {
  return page.getByTestId("virtual-grid").locator(`[data-index="${index}"]`);
}

test("查询过滤，全选后删掉 hat，预览差异再写入，toast 撤销", async ({ page }) => {
  await page.goto("/#/datasets/ds1/review");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));

  // 频率表：触发词钉在最前，hat 出现在 9 张里。
  await expect(page.getByTestId("studio-trigger")).toContainText("sks");
  await expect(page.getByTestId("studio-frequency").locator('[data-tag="hat"]')).toHaveAttribute("data-count", String(WITH_HAT));

  const query = page.getByTestId("studio-query");
  await query.fill("1girl -hat");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL - WITH_HAT));
  await expect(page.getByTestId("studio-frequency").locator('[data-tag="hat"]')).toHaveCount(0);

  // 没选图时检查器针对全部结果。
  await query.fill("1girl hat");
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT));
  const title = page.getByTestId("studio-inspector-title");
  await expect(title).toHaveAttribute("data-scope", "results");

  await cell(page, 0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("studio-selection")).toContainText(`已选 ${WITH_HAT} 张`);
  await expect(title).toHaveAttribute("data-scope", "selection");
  await expect(title).toHaveAttribute("data-count", String(WITH_HAT));
  const hatRow = page.getByTestId("studio-tags-all").locator('[data-tag="hat"]');
  await expect(hatRow).toContainText(`${WITH_HAT}/${WITH_HAT}`);

  await hatRow.locator('[data-action="remove"]').click();
  const dialog = page.getByTestId("studio-op-dialog");
  await expect(dialog.getByTestId("studio-op-tags")).toHaveValue("hat");
  await expect(dialog.getByTestId("studio-op-stats")).toHaveAttribute("data-changes", String(WITH_HAT));
  await expect(dialog.getByTestId("studio-op-samples").locator('[data-diff="removed"]').first()).toContainText("hat");
  const preview = captions.requests.find((request) => request.path === "ops");
  expect(preview?.body).toMatchObject({ ops: [{ op: "remove", tags: ["hat"] }], dry_run: true });
  expect((preview?.body as { asset_ids: string[] }).asset_ids).toHaveLength(WITH_HAT);
  expect(Object.keys((preview?.body as { expected_versions: Record<string, string> }).expected_versions)).toHaveLength(WITH_HAT);
  expect(captions.tags(assetId(0))).toContain("hat");

  await dialog.getByTestId("studio-op-apply").click();
  await expect(dialog).toBeHidden();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: `已改写 ${WITH_HAT} 张 caption` });
  await expect(toast).toBeVisible();
  expect(captions.tags(assetId(0))).toEqual(["sks", "1girl", "solo"]);
  // 写完重新拉 caption：已经没有图带 hat 了，选择随之清空。
  await expect(count(page)).toHaveAttribute("data-count", "0");
  await expect(page.getByTestId("studio-selection")).toBeHidden();
  await expect(page.getByTestId("studio-history").locator('[data-kind="ops"]')).toHaveAttribute("data-undone", "false");

  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: `已撤销，恢复了 ${WITH_HAT} 张` })).toBeVisible();
  expect(captions.tags(assetId(0))).toEqual(["sks", "1girl", "hat", "solo"]);
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT));
  await expect(page.getByTestId("studio-history").locator('[data-kind="ops"]')).toHaveAttribute("data-undone", "true");

  // Esc：网格没有选择时清空查询。
  await cell(page, 0).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-selection")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(query).toHaveValue("");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
});

test("点频率表里的标签改查询，黑名单划线", async ({ page }) => {
  await page.goto("/#/datasets/ds1/review");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));

  const frequency = page.getByTestId("studio-frequency");
  await frequency.locator('[data-tag="long_hair"] button').first().click();
  await expect(page.getByTestId("studio-query")).toHaveValue("long_hair");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL - WITH_HAT));
  await expect(frequency.locator('[data-tag="long_hair"]')).toHaveAttribute("data-state", "include");

  await frequency.locator('[data-tag="long_hair"] button').first().click({ modifiers: ["Alt"] });
  await expect(page.getByTestId("studio-query")).toHaveValue("-long_hair");
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT));

  await frequency.locator('[data-tag="solo"]').getByRole("button", { name: "把 solo 加进黑名单" }).click();
  await expect(page.getByTestId("studio-blacklist")).toContainText("solo");
  await expect(frequency.locator('[data-tag="solo"]').getByRole("button", { name: "把 solo 移出黑名单" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("逐张校对：Enter 通过并下一张，T 加标签写回，Z 撤销，Esc 回网格", async ({ page }) => {
  await page.goto("/#/datasets/ds1/review");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));

  await cell(page, 0).click();
  await page.keyboard.press("Enter");
  const triage = page.getByTestId("studio-triage");
  await expect(triage).toHaveAttribute("data-asset", assetId(0));
  await expect(page.getByTestId("studio-triage-position")).toHaveText(`1 / ${TOTAL}`);
  await expect(page.getByTestId("studio-inspector-title")).toHaveAttribute("data-scope", "current");

  // Enter：记为已校对，跳到下一张。
  await page.keyboard.press("Enter");
  await expect(triage).toHaveAttribute("data-asset", assetId(1));
  await expect(page.getByTestId("studio-reviewed")).toHaveAttribute("data-count", "1");
  await expect.poll(() => captions.approved.has(assetId(0))).toBe(true);

  // T：聚焦输入框，加标签后回车写回这一张（带版本号）。
  await page.keyboard.press("t");
  const add = page.getByTestId("studio-triage-add");
  await expect(add).toBeFocused();
  await add.fill("smile");
  await add.press("Enter");
  await expect(page.getByTestId("studio-triage-tags").locator('[data-tag="smile"]')).toBeVisible();
  expect(captions.tags(assetId(1))).toEqual(["sks", "1girl", "hat", "solo", "smile"]);
  const edit = captions.requests.find((request) => request.path === "edit");
  expect(edit?.body).toMatchObject({ asset_id: assetId(1), text: "sks, 1girl, hat, solo, smile", expected_version: "v1" });

  // × 删一个标签。
  await page.getByTestId("studio-triage-tags").getByRole("button", { name: "删掉 solo" }).click();
  await expect(page.getByTestId("studio-triage-tags").locator('[data-tag="solo"]')).toHaveCount(0);
  expect(captions.tags(assetId(1))).toEqual(["sks", "1girl", "hat", "smile"]);

  // Z 一步步撤销：删 solo → 加 smile → 通过第一张（回到第一张）。
  await page.keyboard.press("z");
  await expect(page.getByTestId("studio-triage-tags").locator('[data-tag="solo"]')).toBeVisible();
  await page.keyboard.press("z");
  await expect(page.getByTestId("studio-triage-tags").locator('[data-tag="smile"]')).toHaveCount(0);
  expect(captions.tags(assetId(1))).toEqual(["sks", "1girl", "hat", "solo"]);
  await page.keyboard.press("z");
  await expect(triage).toHaveAttribute("data-asset", assetId(0));
  await expect(page.getByTestId("studio-reviewed")).toHaveAttribute("data-count", "0");
  await expect.poll(() => captions.approved.has(assetId(0))).toBe(false);

  // ←/→ 翻页，Esc 回到网格，焦点落在当前这张。
  await page.keyboard.press("ArrowRight");
  await expect(triage).toHaveAttribute("data-asset", assetId(1));
  await page.keyboard.press("Escape");
  await expect(triage).toBeHidden();
  await expect(cell(page, 1)).toHaveAttribute("data-focused", "true");
});
