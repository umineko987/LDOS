// 黄金路径：真实后端上 建数据集 → 导入 → 清洗 → 去重 → 打标 → 校对 → 导出，最后检查磁盘上的导出结果。
// 后端、素材和替身见 setup.ts 与 fakes/；这里只模拟 Tauri 宿主（runtime_metadata 指向真实后端，选目录按队列返回）。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test";
import { goldenEnv } from "./setup";

declare global {
  interface Window {
    /** 下一次「选目录」返回的路径，按顺序取。 */
    __goldenPicks?: string[];
  }
}

// 不用默认的健康后端模拟：所有请求都发给真实后端。
test.use({ healthyBackend: false });

/** 和桌面宿主一样：后端已就绪，运行时 origin 是真实后端的回环地址。 */
async function desktopHost(page: Page, apiOrigin: string): Promise<void> {
  await page.addInitScript((origin) => {
    window.__goldenPicks = [];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "backend_status") return { state: "ready" };
          if (command === "runtime_metadata") return { apiOrigin: origin, backendVersion: null };
          if (command === "select_directory") return window.__goldenPicks?.shift() ?? null;
          if (command === "reveal_in_file_manager") return null;
          throw new Error(`unexpected command ${command}`);
        },
      },
    });
  }, apiOrigin);
}

async function pickNext(page: Page, path: string): Promise<void> {
  await page.evaluate((next) => window.__goldenPicks?.push(next), path);
}

const rail = (page: Page) => page.getByTestId("stage-rail");
const removed = (page: Page, stage: string) => rail(page).locator(`[data-stage="${stage}"] [data-removed]`);
const output = (page: Page, stage: string) => rail(page).locator(`[data-stage="${stage}"] [data-count]`);

/** 区域里解码成功的图片数。跨源的后端图片少了 crossorigin 会被 local_origin_guard 403，这里会是 0。 */
const loadedImages = (scope: ReturnType<Page["locator"]>) =>
  scope.locator("img").evaluateAll((images) =>
    images.filter((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0).length);

test("建数据集、导入、清洗、去重、打标、校对、导出，导出目录里是留下的图和改好的 caption", async ({ page }) => {
  const { apiOrigin, source, exportTarget } = goldenEnv();
  await desktopHost(page, apiOrigin);
  await page.goto("/");
  await expect(page.getByTestId("dataset-empty")).toBeVisible();

  // 新建数据集，直接进采集段。
  await page.keyboard.press("n");
  const dialog = page.getByTestId("dataset-dialog");
  await expect(dialog.getByLabel("名称")).toBeFocused();
  await page.keyboard.type("黄金路径");
  await dialog.getByLabel("触发词").fill("golden_hero");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(page).toHaveURL(/#\/datasets\/[^/]+\/collect$/);
  await expect(page.getByTestId("collect-empty")).toBeVisible();

  // 导入素材文件夹：后端建来源、扫描、哈希，8 张都进网格。
  await pickNext(page, source);
  await page.getByTestId("collect-add-folder").click();
  await expect(page.getByTestId("collect-roots")).toContainText("golden_set");
  await expect(page.getByTestId("virtual-grid").getByRole("option")).toHaveCount(8);
  await expect(output(page, "collect")).toHaveText("8");
  await expect.poll(() => loadedImages(page.getByTestId("virtual-grid"))).toBe(8);

  // 清洗：默认选项下假完成度模型标出黑白和草稿各一张；标记默认保留，整批剔除后 Enter 提交。
  await rail(page).locator('[data-stage="clean"]').click();
  await page.getByTestId("triage-run").click();
  const cleanDeck = page.getByTestId("clean-deck");
  await expect(page.getByTestId("clean-progress")).toContainText("标记 2 张");
  await expect(cleanDeck.getByTestId("deck-card")).toHaveCount(2);
  await expect(cleanDeck).toContainText("黑白");
  await expect(cleanDeck).toContainText("草稿");
  await page.getByRole("button", { name: "全部剔除" }).click();
  await expect(cleanDeck.locator('[data-testid="deck-card"][aria-pressed="false"]')).toHaveCount(2);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("clean-done")).toBeVisible();
  await expect(removed(page, "clean")).toHaveText("−2");
  await expect(output(page, "clean")).toHaveText("6");

  // 去重：a / a_copy 像素相同，自动留文件大的 a；b / b_small 是一组相似图，Enter 采用推荐（留大图 b）。
  await rail(page).locator('[data-stage="dedup"]').click();
  await page.getByTestId("triage-run").click();
  await expect(page.getByTestId("dedup-counter")).toHaveText("第 1 / 1 组");
  await expect(removed(page, "dedup")).toHaveText("−1");
  const deck = page.getByTestId("compare-deck");
  await expect(deck.getByTestId("deck-card")).toHaveCount(2);
  await expect.poll(() => loadedImages(deck)).toBe(2);
  const kept = deck.locator('[data-testid="deck-card"][data-kept="true"]');
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("b.png");
  await expect(kept).toContainText("推荐");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("dedup-done")).toBeVisible();
  await expect(removed(page, "dedup")).toHaveText("−2");
  await expect(output(page, "dedup")).toHaveText("4");

  // 打标：还没有分数，先跑一遍（假模型按底色给 *_theme），再把结果写成 caption。
  await rail(page).locator('[data-stage="tag"]').click();
  await expect(page.getByTestId("tag-scores")).toContainText("4 张里有 4 张还没有打标分数");
  await page.getByTestId("tag-run").click();
  await expect(page.getByTestId("tag-scores")).toContainText("4 张都有打标分数");
  await expect(page.getByTestId("tag-changed")).toHaveAttribute("data-count", "4");
  await page.getByTestId("tag-write").click();
  const write = page.getByTestId("tag-write-dialog");
  await expect(write.getByTestId("tag-write-stats")).toHaveAttribute("data-changes", "4");
  await write.getByTestId("tag-write-apply").click();
  await expect(write).toBeHidden();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "已写入 4 张 caption" })).toBeVisible();

  // 校对：全选后从所有 caption 里删掉 simple background。
  await rail(page).locator('[data-stage="review"]').click();
  await expect(page.getByTestId("studio-count")).toHaveAttribute("data-count", "4");
  await page.getByTestId("virtual-grid").locator('[data-index="0"]').click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("studio-selection")).toContainText("已选 4 张");
  const row = page.getByTestId("studio-tags-all").locator('[data-tag="simple background"]');
  await expect(row).toContainText("4/4");
  await row.locator('[data-action="remove"]').click();
  const op = page.getByTestId("studio-op-dialog");
  await expect(op.getByTestId("studio-op-stats")).toHaveAttribute("data-changes", "4");
  await op.getByTestId("studio-op-apply").click();
  await expect(op).toBeHidden();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "已改写 4 张 caption" })).toBeVisible();

  // 导出：kohya 布局、默认 10 次，选目录 → 预览 → 开始，等到完成。
  await rail(page).locator('[data-stage="export"]').click();
  await expect(page.getByTestId("export-trigger")).toHaveValue("golden_hero");
  await pickNext(page, exportTarget);
  await page.getByTestId("export-pick").click();
  await expect(page.getByTestId("export-target")).toHaveValue(exportTarget);
  await page.getByTestId("export-preview").click();
  const plan = page.getByTestId("export-plan");
  await expect(plan.getByTestId("export-plan-output")).toHaveText(join(exportTarget, "10_golden_hero"));
  await expect(plan.getByTestId("export-plan-stats")).toContainText("4 张图 · 4 个标注");
  await page.getByTestId("export-start").click();
  const current = page.getByTestId("export-current");
  await expect(current).toHaveAttribute("data-status", "succeeded");
  await expect(current.getByTestId("export-status")).toHaveText("完成");

  // 磁盘：留下的 4 张原样复制，caption 触发词在前、打标结果按底色、删掉的标签不在。
  const folder = join(exportTarget, "10_golden_hero");
  expect(readdirSync(folder).sort()).toEqual(["a.png", "a.txt", "b.png", "b.txt", "e.png", "e.txt", "f.png", "f.txt"]);
  for (const name of ["a", "b", "e", "f"]) {
    expect(readFileSync(join(folder, `${name}.png`)).equals(readFileSync(join(source, `${name}.png`)))).toBe(true);
  }
  const caption = (name: string) => readFileSync(join(folder, `${name}.txt`), "utf8").trim();
  expect(caption("a")).toBe("golden_hero, 1girl, solo, red theme");
  expect(caption("b")).toBe("golden_hero, 1girl, solo, blue theme");
  expect(caption("e")).toBe("golden_hero, 1girl, solo, green theme");
  expect(caption("f")).toBe("golden_hero, 1girl, solo, red theme");
});
