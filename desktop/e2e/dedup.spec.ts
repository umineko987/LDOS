import type { Page } from "@playwright/test";

import { FakeDatasets } from "./fixtures/datasets";
import { expect, test } from "./fixtures/test";
import { FakeTriage, type FakeTriageInit } from "./fixtures/triage";

// 24 张图：两组近似重复要手动比对，另有一组完全相同的已被自动回收一张。
const GROUPS: FakeTriageInit["dedup"] = [
  { id: "g1", members: ["a2-001", "a2-002", "a2-003"], keep: ["a2-001"] },
  { id: "g2", members: ["a2-004", "a2-005"], keep: ["a2-004"] },
  { id: "auto1", kind: "auto_exact", members: ["a2-007"], winner: "a2-006" },
];

async function setup(page: Page, init: Omit<FakeTriageInit, "dedup"> = {}) {
  const datasets = new FakeDatasets();
  const id = datasets.add({ name: "角色 A", members: 24 });
  await datasets.install(page);
  const triage = new FakeTriage(datasets, id, { ...init, dedup: GROUPS });
  await triage.install(page);
  await page.goto(`/#/datasets/${id}/dedup`);
  return triage;
}

const removed = (page: Page) => page.getByTestId("stage-rail").locator('[data-stage="dedup"] [data-removed]');
const card = (page: Page, index: number) => page.getByTestId("compare-deck").locator(`[data-testid="deck-card"][data-index="${index}"]`);

test("运行去重，键盘比对一组并采用，漏斗减少，撤销后恢复", async ({ page }) => {
  const triage = await setup(page);

  const status = page.getByTestId("triage-status");
  await expect(status).toHaveAttribute("data-phase", "idle");
  await expect(status.getByRole("heading")).toHaveText("去重：同一张图只留一张");
  // 相似模型装好了：会找相似的图。
  await expect(status).toContainText("会找完全相同、压缩差异和相似的图。");
  await page.getByTestId("triage-run").click();

  // 卡组：第一组三张，推荐保留的那张预先选上。
  await expect(page.getByTestId("dedup-counter")).toHaveText("第 1 / 2 组");
  expect(triage.runs).toEqual([{ stage: "dedup", body: { options: { basic_dedup: true, similarity_groups: true } } }]);
  await expect(page.getByTestId("dedup-progress")).toHaveText("已决定 0 / 2 组");
  await expect(card(page, 0)).toHaveAttribute("data-kept", "true");
  await expect(card(page, 0)).toContainText("推荐");
  await expect(card(page, 1)).not.toHaveAttribute("data-kept", "true");
  await expect(card(page, 2)).not.toHaveAttribute("data-kept", "true");
  // 自动回收的一张已经算在漏斗里。
  await expect(removed(page)).toHaveText("−1");

  // 2 把第二张也留下，Enter 采用并进下一组。
  await page.keyboard.press("2");
  await expect(card(page, 1)).toHaveAttribute("data-kept", "true");
  await expect(card(page, 1).getByTestId("deck-card-verdict")).toHaveText("保留");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("dedup-counter")).toHaveText("第 2 / 2 组");
  await expect(page.getByText("保留 2 张 · 剔除 1 张")).toBeVisible();
  expect(triage.applies).toEqual([
    { stage: "dedup", body: { run_id: expect.any(String), groups: [{ group_id: "g1", keep: ["a2-001", "a2-002"] }] } },
  ]);
  await expect(removed(page)).toHaveText("−2");
  await expect(page.getByTestId("dedup-progress")).toHaveText("已决定 1 / 2 组");

  // Z 撤销刚才那批：后端恢复，漏斗回到 −1。
  await page.keyboard.press("z");
  await expect(page.getByText("已撤销 1 组")).toBeVisible();
  expect(triage.undos).toEqual([{ stage: "dedup", body: { batch_id: expect.any(String) } }]);
  await expect(removed(page)).toHaveText("−1");
  await expect(page.getByTestId("dedup-progress")).toHaveText("已决定 0 / 2 组");
});

test("每组至少留一张；空格在查看器里看原图", async ({ page }) => {
  await setup(page, { ready: ["dedup"] });
  await expect(page.getByTestId("dedup-counter")).toHaveText("第 1 / 2 组");

  // 1 会取消唯一保留的那张：不允许。
  await page.keyboard.press("1");
  await expect(page.getByText("每组至少保留一张。")).toBeVisible();
  await expect(card(page, 0)).toHaveAttribute("data-kept", "true");

  // 焦点移到第三张，空格打开查看器看它的原图，再按空格关上。
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, 2)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press(" ");
  const viewer = page.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute("data-index", "2");
  await expect(viewer).toContainText("角色 A-003.png");
  await page.keyboard.press(" ");
  await expect(viewer).toBeHidden();
});

test("自动处理的组可以恢复被回收的图", async ({ page }) => {
  const triage = await setup(page, { ready: ["dedup"] });
  await expect(removed(page)).toHaveText("−1");

  await page.getByTestId("dedup-view").getByRole("button", { name: "自动处理 1" }).click();
  const group = page.getByTestId("dedup-auto-group");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("完全相同");
  await group.getByTestId("dedup-auto-restore").click();

  await expect(group).toContainText("已恢复");
  expect(triage.applies.at(-1)?.body.groups).toEqual([{ group_id: "auto1", keep: ["a2-007"] }]);
  await expect(removed(page)).toHaveCount(0);
});
