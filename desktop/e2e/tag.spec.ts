import type { Page } from "@playwright/test";

import { mockApi } from "./fixtures/api";
import { FakeCaptions } from "./fixtures/captions";
import { FakeDatasets } from "./fixtures/datasets";
import { FakeTagger, WD_MODEL } from "./fixtures/tagger";
import { expect, test } from "./fixtures/test";

// 打标段：拖阈值 → 频率表和「会改变几张」即时更新 → 预览写入（dry-run）→ 写入 → toast 撤销。

const TOTAL = 12;
// 第 i 张图 hat 的分数：默认阈值 0.35 时 9 张（i ≥ 3）有 hat，调到 0.50 后 6 张（i ≥ 6）。
const HAT = [0.2, 0.25, 0.3, 0.36, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];

const assetId = (index: number) => `a2-${String(index + 1).padStart(3, "0")}`;

let tagger: FakeTagger;
let captions: FakeCaptions;

test.beforeEach(async ({ page }) => {
  const datasets = new FakeDatasets();
  datasets.add({ name: "tags", members: TOTAL, trigger_word: "sks" });
  await datasets.install(page);
  tagger = new FakeTagger();
  captions = new FakeCaptions(datasets);
  for (let index = 0; index < TOTAL; index += 1) {
    tagger.score(assetId(index), { "1girl": 0.97, solo: 0.9, hat: HAT[index]!, long_hair: 0.2 });
    captions.set(assetId(index), "sks, 1girl, solo");
  }
  await tagger.install(page, datasets);
  await captions.install(page, tagger);
});

function changed(page: Page) {
  return page.getByTestId("tag-changed");
}

function frequencyRow(page: Page, tag: string) {
  return page.getByTestId("tag-frequency").locator(`[data-tag="${tag}"]`);
}

test("拖阈值实时更新频率和改动数，预览后写入，toast 撤销", async ({ page }) => {
  await page.goto("/#/datasets/ds1/tag");
  await expect(page.getByTestId("tag-scores")).toContainText(`已生成 ${TOTAL} 张的打标结果`);

  // 默认阈值 0.35：9 张会加上 hat。
  await expect(changed(page)).toHaveAttribute("data-count", "9");
  await expect(frequencyRow(page, "hat")).toHaveAttribute("data-count", "9");
  await expect(frequencyRow(page, "hat")).toHaveAttribute("data-delta", "9");
  await expect(page.getByTestId("tag-trigger")).toContainText("sks");

  // 键盘把 general 从 0.35 调到 0.50。
  const slider = page.getByTestId(`tag-threshold-${WD_MODEL.key}-general`);
  await slider.getByRole("slider").focus();
  for (let step = 0; step < 15; step += 1) await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("data-value", "0.50");
  await expect(changed(page)).toHaveAttribute("data-count", "6");
  await expect(frequencyRow(page, "hat")).toHaveAttribute("data-count", "6");
  await expect(page.getByTestId("tag-samples").locator("li")).toHaveCount(6);

  // 预览写入：后端 dry-run 的统计，阈值只带改过的那个。
  await page.getByTestId("tag-write").click();
  const dialog = page.getByTestId("tag-write-dialog");
  await expect(dialog.getByTestId("tag-write-stats")).toHaveAttribute("data-changes", "6");
  await expect(dialog.getByTestId("tag-write-samples").locator("li")).toHaveCount(6);
  const preview = captions.requests.find((request) => request.path === "from-tagger");
  expect(preview?.body).toMatchObject({
    models: [WD_MODEL.key],
    mode: "merge",
    thresholds: { [WD_MODEL.key]: { general: 0.5 } },
    categories: ["character", "general"],
    dry_run: true,
  });

  await dialog.getByTestId("tag-write-apply").click();
  await expect(dialog).toBeHidden();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "已写入 6 张 caption" });
  await expect(toast).toBeVisible();
  expect(captions.tags(assetId(11))).toEqual(["sks", "1girl", "solo", "hat"]);
  expect(captions.tags(assetId(5))).toEqual(["sks", "1girl", "solo"]);
  // 写完重新拉 caption：按同样的阈值已经没有要改的了。
  await expect(changed(page)).toHaveAttribute("data-count", "0");
  await expect(page.getByTestId("tag-no-changes")).toBeVisible();

  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "已撤销，恢复了 6 张" })).toBeVisible();
  expect(captions.tags(assetId(11))).toEqual(["sks", "1girl", "solo"]);
  await expect(changed(page)).toHaveAttribute("data-count", "6");
});

test("待打标的图先开始打标；写入方式和类别影响预览", async ({ page }) => {
  for (let index = 0; index < 4; index += 1) tagger.unscored.add(assetId(index));
  // 上次运行被应用退出打断（后端启动时标成 failed / interrupted）。
  await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/stage-runs", {
    items: [
      {
        run_id: "r1",
        dataset_id: "ds1",
        stage: "tag",
        status: "failed",
        error_code: "interrupted",
        ref_id: "",
        input_digest: "",
        stats: {},
        created_at: 1_760_000_000,
        updated_at: 1_760_000_100,
        finished_at: 1_760_000_100,
      },
    ],
  });
  await page.goto("/#/datasets/ds1/tag");
  await expect(page.getByTestId("tag-scores")).toContainText(`${TOTAL} 张里有 4 张待打标`);
  await expect(page.getByTestId("tag-interrupted")).toContainText("上次打标时应用退出了");
  // 没分数的 4 张里有 3 张本来会加 hat：现在只算 i ≥ 4 的 8 张。
  await expect(changed(page)).toHaveAttribute("data-count", "8");

  await page.getByRole("button", { name: "开始打标", exact: true }).click();
  await expect.poll(() => tagger.runs).toEqual([{ models: [WD_MODEL.key] }]);

  // 覆盖：触发词保留，打标结果整体替换。只勾 character 时 general 标签都被换掉。
  await page.getByTestId("tag-mode").getByRole("button", { name: "覆盖" }).click();
  await page.getByTestId("tag-categories").locator('[data-category="general"]').click();
  await expect(changed(page)).toHaveAttribute("data-count", "8");
  await expect(frequencyRow(page, "1girl")).toHaveAttribute("data-delta", "-8");
});
