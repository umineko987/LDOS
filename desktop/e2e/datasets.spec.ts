import type { Locator } from "@playwright/test";

import { FakeDatasets } from "./fixtures/datasets";
import { sseBody } from "./fixtures/jobs";
import { expect, test } from "./fixtures/test";

/** 圆点左缘和当前段锚点（标签后面的零宽占位）的横向距离。 */
async function dotOffset(dot: Locator, anchor: Locator): Promise<number> {
  const [dotBox, anchorBox] = await Promise.all([dot.boundingBox(), anchor.boundingBox()]);
  if (!dotBox || !anchorBox) return Number.POSITIVE_INFINITY;
  return Math.abs(dotBox.x - anchorBox.x);
}

test("新建数据集，导入 24 张图的文件夹，排除 2 张后漏斗剩 22", async ({ page }) => {
  const backend = new FakeDatasets();
  await backend.install(page);
  await page.goto("/");
  await expect(page.getByTestId("dataset-empty")).toBeVisible();

  // N 打开新建对话框，焦点在名称上。
  await page.keyboard.press("n");
  const dialog = page.getByTestId("dataset-dialog");
  await expect(dialog.getByLabel("名称")).toBeFocused();
  await page.keyboard.type("角色 A");
  await dialog.getByRole("button", { name: "画风" }).click();
  await expect(dialog.getByRole("button", { name: "画风" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("触发词").fill("chara_a");
  await dialog.getByRole("button", { name: "创建" }).click();

  // 建好后直接进采集段。
  await expect(page).toHaveURL(/#\/datasets\/ds1\/collect$/);
  await expect(page.getByRole("heading", { name: "角色 A" })).toBeVisible();
  await expect(page.getByTestId("dataset-trigger")).toHaveText(/chara_a/);
  const rail = page.getByTestId("stage-rail");
  await expect(rail.locator('[data-stage="collect"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("collect-empty")).toBeVisible();

  // 浏览器模式没有系统目录选择器，退回输入路径。
  await page.getByTestId("collect-add-folder").click();
  const pathDialog = page.getByTestId("collect-path-dialog");
  await pathDialog.getByLabel("文件夹路径").fill("/home/me/pictures/chara_a");
  await pathDialog.getByRole("button", { name: "导入" }).click();
  await expect(pathDialog).toHaveCount(0);

  const roots = page.getByTestId("collect-roots");
  await expect(roots).toContainText("chara_a");
  await expect(roots.getByTestId("root-origin")).toHaveText("导入");
  const grid = page.getByTestId("virtual-grid");
  await expect(grid.getByRole("option")).toHaveCount(24);
  await expect(rail.locator('[data-stage="collect"] [data-count]')).toHaveText("24");
  await expect(page.getByTestId("collect-filter").getByRole("button", { name: "全部 24" })).toBeVisible();

  // 单击选中第 3 张，Ctrl 加选第 5 张，X 排除。
  await grid.locator('[data-index="2"]').click();
  await grid.locator('[data-index="4"]').click({ modifiers: ["Control"] });
  await expect(page.getByTestId("collect-selection")).toHaveText("已选 2 张");
  await page.keyboard.press("x");

  await expect(rail.locator('[data-stage="collect"] [data-count]')).toHaveText("22");
  await expect(rail.locator('[data-stage="collect"] [data-removed]')).toHaveText("−2");
  await expect(grid.locator("[data-stamp]")).toHaveCount(2);
  await expect(grid.locator('[data-index="2"] [data-stamp]')).toHaveText("已排除");
  expect(backend.decisions).toEqual([
    { stage: "collect", decision: "exclude", reason: "", asset_ids: ["a2-003", "a2-005"] },
  ]);

  // 按决定筛选：保留的 22 张（decision=kept），只看排除的两张；Esc 清空选择。
  const kept = page.waitForRequest((request) => new URL(request.url()).searchParams.get("decision") === "kept");
  await page.getByTestId("collect-filter").getByRole("button", { name: "保留 22" }).click();
  await kept;
  await expect(grid.getByRole("option")).toHaveCount(22);
  await page.getByTestId("collect-filter").getByRole("button", { name: "已排除 2" }).click();
  await expect(grid.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("collect-selection")).toHaveCount(0);

  // 首页卡片的可导出张数也跟着变。
  await page.getByTestId("sidebar").getByRole("link", { name: "数据集" }).click();
  const card = page.getByTestId("dataset-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("角色 A");
  await expect(card.getByTestId("dataset-output")).toHaveText("22");
});

test("哈希进度跟着 dataset.updated（reason=hashing）刷新，不轮询", async ({ page }) => {
  const backend = new FakeDatasets();
  await backend.install(page);
  const id = backend.add({ name: "哈希", members: 8 });
  backend.hashPending.set(id, 5);
  let hashingRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/v1/datasets/${id}/hashing`) hashingRequests += 1;
  });
  // SSE 先挂着不回，等页面显示出“正在计算”再推进度事件。
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let connections = 0;
  await page.route(
    (url) => url.pathname === "/api/v1/events",
    async (route) => {
      connections += 1;
      const first = connections === 1;
      if (first) await released;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `: ldos e2e\n\n${first ? sseBody([{ event: "dataset.updated", id: "e1-0", data: { dataset_id: id, reason: "hashing" } }]) : ""}`,
      });
    },
  );

  await page.goto(`/#/datasets/${id}/collect`);
  const status = page.getByTestId("collect-hashing");
  await expect(status).toHaveText("正在计算哈希 3/8");
  // 没有事件就不再请求（以前每 2 秒轮询一次）。
  await page.waitForTimeout(2_500);
  expect(hashingRequests).toBe(1);

  backend.hashPending.set(id, 0);
  release();
  await expect(status).toHaveText("哈希已算完");
});

test("网格方向键移动焦点，Space 打开查看器，←/→ 翻页，Esc 关闭后焦点停在看过的那张", async ({ page }) => {
  const backend = new FakeDatasets();
  const id = backend.add({ name: "画风 B", kind: "style", members: 30 });
  await backend.install(page);
  await page.goto(`/#/datasets/${id}/collect`);

  const grid = page.getByTestId("virtual-grid");
  await expect(grid.getByRole("option")).toHaveCount(30);
  const columns = Number(await grid.getAttribute("data-columns"));
  expect(columns).toBeGreaterThan(1);
  const focused = grid.locator("[data-focused]");

  await page.keyboard.press("ArrowRight");
  await expect(focused).toHaveAttribute("data-index", "0");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("l");
  await expect(focused).toHaveAttribute("data-index", "2");
  await page.keyboard.press("ArrowDown");
  await expect(focused).toHaveAttribute("data-index", String(2 + columns));
  await page.keyboard.press("k");
  await expect(focused).toHaveAttribute("data-index", "2");
  await page.keyboard.press("End");
  await expect(focused).toHaveAttribute("data-index", "29");
  await page.keyboard.press("Home");
  await expect(focused).toHaveAttribute("data-index", "0");

  // Shift+方向键扩展选择。
  await page.keyboard.press("Shift+ArrowRight");
  await expect(grid.locator("[data-selected]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(grid.locator("[data-selected]")).toHaveCount(0);

  await page.keyboard.press("ArrowRight");
  await expect(focused).toHaveAttribute("data-index", "2");
  await page.keyboard.press("Space");
  const viewer = page.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("viewer-position")).toHaveText("3 / 30");
  await expect(viewer.getByRole("img", { name: "画风 B-003.png" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByTestId("viewer-position")).toHaveText("4 / 30");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("l");
  await expect(viewer.getByTestId("viewer-position")).toHaveText("5 / 30");
  // 查看器打开时网格的按键暂停：焦点格不动。
  await expect(focused).toHaveAttribute("data-index", "2");

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(focused).toHaveAttribute("data-index", "4");

  // Enter 没有 onopen 时退回预览，Space 在查看器里关闭它。
  await page.keyboard.press("Enter");
  await expect(viewer.getByTestId("viewer-position")).toHaveText("5 / 30");
  await page.keyboard.press("Space");
  await expect(viewer).toHaveCount(0);
});

test("[ 和 ] 在阶段之间切换，金色圆点跟到当前段", async ({ page }) => {
  const backend = new FakeDatasets();
  const id = backend.add({ name: "概念 C", kind: "concept", trigger_word: "ccc", members: 6 });
  await backend.install(page);
  await page.goto(`/#/datasets/${id}/collect`);
  const rail = page.getByTestId("stage-rail");
  await expect(rail.locator('[data-stage="collect"]')).toHaveAttribute("aria-current", "page");
  await expect(rail.locator('[data-stage="collect"]')).toHaveAttribute("data-status", "done");
  await expect(rail.locator('[data-stage="clean"]')).toHaveAttribute("data-status", "idle");

  await page.keyboard.press("]");
  await expect(page).toHaveURL(new RegExp(`#/datasets/${id}/clean$`));
  await expect(rail.locator('[data-stage="clean"]')).toHaveAttribute("aria-current", "page");
  // 连按两下：越过采集段绕到图谱。
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  await expect(page).toHaveURL(new RegExp(`#/datasets/${id}/atlas$`));
  await expect(rail.locator('[data-stage="atlas"]')).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("[");
  await expect(page).toHaveURL(new RegExp(`#/datasets/${id}/export$`));
  await expect
    .poll(() => dotOffset(rail.getByTestId("nav-dot"), rail.locator('[data-stage="export"] [data-dot-anchor]')))
    .toBeLessThan(1);
});

test("改触发词、删除数据集", async ({ page }) => {
  const backend = new FakeDatasets();
  const id = backend.add({ name: "角色 D", members: 3 });
  await backend.install(page);
  await page.goto(`/#/datasets/${id}/collect`);

  await page.getByTestId("dataset-trigger").click();
  const dialog = page.getByTestId("dataset-dialog");
  await expect(dialog.getByLabel("触发词")).toBeFocused();
  await page.keyboard.type("dee");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("dataset-trigger")).toHaveText(/dee/);
  expect(backend.datasets.get(id)?.trigger_word).toBe("dee");

  await page.getByRole("button", { name: "数据集操作" }).click();
  await page.getByRole("menuitem", { name: "删除数据集…" }).click();
  const confirm = page.getByTestId("dataset-delete-dialog");
  await expect(confirm).toContainText("删除数据集“角色 D”？");
  await confirm.getByRole("button", { name: "删除" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("dataset-empty")).toBeVisible();
  expect(backend.datasets.size).toBe(0);
});
