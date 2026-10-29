import type { Page, Request } from "@playwright/test";

import { errorEnvelope, mockApi } from "./fixtures/api";
import {
  ATLAS_DATASET,
  clusterIds,
  forceRenderer,
  itemPosition,
  mockAtlasImages,
  mockAtlasRun,
  noAtlas,
  readyAtlas,
  runningAtlas,
  SPRITE_RGB,
} from "./fixtures/atlas";
import { FakeDatasets } from "./fixtures/datasets";
import { expect, test } from "./fixtures/test";

// 语义地图页。除了最后一条，都强制 Canvas2D：像素断言用 getImageData，不受 GPU 和 SwiftShader 影响。

const ATLAS_PATH = "/api/v1/datasets/{dataset_id}/atlas";
const TOTAL = 23;

function stage(page: Page) {
  return page.getByTestId("atlas-stage");
}

// 地图页渲染在数据集布局里，布局要先拿到数据集详情和漏斗。
test.beforeEach(async ({ page }) => {
  const datasets = new FakeDatasets();
  datasets.add({ name: "atlas", members: TOTAL });
  await datasets.install(page);
});

async function openAtlas(page: Page) {
  await page.goto(`/#/datasets/${ATLAS_DATASET}/atlas`);
}

/** 初始视图（k = 1，居中）下世界坐标对应的页面坐标；和 atlas-view.ts 的 worldToScreen 一致。 */
async function toScreen(page: Page, [wx, wy]: readonly [number, number]): Promise<[number, number]> {
  const box = (await stage(page).boundingBox())!;
  const scale = Math.min(box.width, box.height) / 2.5;
  return [box.x + box.width / 2 + wx * scale, box.y + box.height / 2 + wy * scale];
}

/** 画布上满足条件的像素数。只在有变化时重画，所以随时读都是最新一帧。 */
async function countPixels(page: Page, target: "painted" | readonly [number, number, number]): Promise<number> {
  return stage(page)
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement, target) => {
      let pixels: Uint8Array | Uint8ClampedArray;
      if (canvas.dataset.renderer === "webgl2") {
        const gl = canvas.getContext("webgl2")!;
        pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      } else {
        pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      }
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (target === "painted") {
          if (pixels[i + 3]) count += 1;
        } else if (
          pixels[i + 3] === 255 &&
          Math.abs(pixels[i]! - target[0]) < 8 &&
          Math.abs(pixels[i + 1]! - target[1]) < 8 &&
          Math.abs(pixels[i + 2]! - target[2]) < 8
        ) {
          count += 1;
        }
      }
      return count;
    }, target);
}

/** 页面坐标处画布像素的不透明度（Canvas2D）。 */
async function alphaAt(page: Page, [x, y]: readonly [number, number]): Promise<number> {
  const box = (await stage(page).boundingBox())!;
  return stage(page)
    .locator("canvas")
    .evaluate(
      (canvas: HTMLCanvasElement, [px, py]) => {
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        return canvas.getContext("2d")!.getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1).data[3]!;
      },
      [x - box.x, y - box.y] as const,
    );
}

/** 有状态的后端：移除 / 恢复改的是同一份“已移除”列表，下一次 GET 就能看到。 */
async function mockReadyBackend(page: Page) {
  const removed = new Set<string>();
  const requests: { path: string; ids: string[] }[] = [];
  await mockApi(page, "get", ATLAS_PATH, () => ({ body: readyAtlas({ removed: [...removed] }) }));
  const decide = (kind: "remove" | "restore") => (request: Request) => {
    const ids = (request.postDataJSON() as { asset_ids: string[] }).asset_ids;
    requests.push({ path: kind, ids });
    for (const assetId of ids) {
      if (kind === "remove") removed.add(assetId);
      else removed.delete(assetId);
    }
    return { body: { updated: ids.length, funnel: { dataset_id: ATLAS_DATASET, member_count: TOTAL, stages: [] } } };
  };
  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/atlas/remove", decide("remove"));
  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/atlas/restore", decide("restore"));
  await mockAtlasImages(page);
  return { removed, requests };
}

test.describe("Canvas2D", () => {
  test.beforeEach(async ({ page }) => {
    await forceRenderer(page, "canvas2d");
  });

  test("就绪的地图：画出点，提示过多的簇和离群图，放大后换成缩略图", async ({ page }) => {
    await mockReadyBackend(page);
    await openAtlas(page);

    await expect(page.getByTestId("atlas-page")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("atlas-renderer")).toHaveAttribute("data-kind", "canvas2d");
    await expect(page.getByTestId("atlas-renderer")).toHaveAttribute("data-reason", "forced");
    await expect(stage(page)).toHaveAttribute("data-visible", String(TOTAL));
    await expect(stage(page)).toHaveAttribute("data-mode", "points");
    await expect.poll(() => countPixels(page, "painted")).toBeGreaterThan(100);

    // 簇 1 占 12/23 ≈ 52%，超过 8% 的阈值；o1 的离群分 0.97 超过 0.9。
    await expect(page.getByTestId("atlas-hint-cluster")).toHaveCount(1);
    await expect(page.getByTestId("atlas-hint-cluster")).toHaveAttribute("data-cluster", "0");
    await expect(page.getByTestId("atlas-hint-cluster")).toContainText("簇 1 占 52%");
    await expect(page.getByTestId("atlas-outliers")).toHaveAttribute("data-count", "1");
    await expect(page.getByTestId("atlas-cluster")).toHaveCount(3);

    // 指着 a0 滚轮放大：缩放以指针为中心，a0 一直在指针下面。
    const a0 = await toScreen(page, itemPosition("a0"));
    await page.mouse.move(...a0);
    await expect(page.getByTestId("atlas-tooltip")).toHaveAttribute("data-asset", "a0");
    await expect(page.getByTestId("atlas-tooltip").locator("img")).toHaveAttribute(
      "src",
      /\/api\/v1\/gallery\/assets\/a0\/thumbnail\?size=256$/,
    );
    await page.mouse.wheel(0, -400);
    await page.mouse.wheel(0, -400);
    await expect(stage(page)).toHaveAttribute("data-mode", "sprites");
    await expect(page.getByTestId("atlas-zoom")).toContainText("缩略图");
    await expect.poll(() => countPixels(page, SPRITE_RGB)).toBeGreaterThan(1000);

    // 点一下选中指着的图，Esc 清掉选择；0 回到初始视图。
    await page.mouse.click(...a0);
    await expect(page.getByTestId("atlas-selection")).toHaveAttribute("data-count", "1");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atlas-selection")).toHaveCount(0);
    await page.keyboard.press("0");
    await expect(stage(page)).toHaveAttribute("data-zoom", "1.00");
    await expect(stage(page)).toHaveAttribute("data-mode", "points");
  });

  test("套索圈住一个簇后移除，这些点从地图上消失，撤销后回来", async ({ page }) => {
    const backend = await mockReadyBackend(page);
    await openAtlas(page);
    await expect(stage(page)).toHaveAttribute("data-visible", String(TOTAL));

    const b0 = await toScreen(page, itemPosition("b0"));
    await expect.poll(() => alphaAt(page, b0)).toBeGreaterThan(0);

    await page.keyboard.press("l");
    await expect(stage(page)).toHaveAttribute("data-tool", "lasso");
    // 簇 2 的中心在 (0.5, -0.3)，点都在 0.06 以内；o1 虽然也属簇 2，但离得很远。
    const corners = await Promise.all(
      [
        [0.36, -0.44],
        [0.64, -0.44],
        [0.64, -0.16],
        [0.36, -0.16],
      ].map((corner) => toScreen(page, corner as [number, number])),
    );
    await page.mouse.move(...corners[0]!);
    await page.mouse.down();
    for (const corner of [...corners.slice(1), corners[0]!]) await page.mouse.move(...corner, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("atlas-selection")).toHaveAttribute("data-count", "6");

    await page.getByTestId("atlas-remove").click();
    await expect(stage(page)).toHaveAttribute("data-visible", String(TOTAL - 6));
    expect(backend.requests).toEqual([{ path: "remove", ids: expect.arrayContaining(clusterIds(1)) }]);
    expect(backend.requests[0]!.ids).toHaveLength(6);
    await expect(page.getByTestId("atlas-summary")).toContainText(`${TOTAL - 6} 张`);
    await expect.poll(() => alphaAt(page, b0)).toBe(0);

    // 撤销：同一批图恢复，点回到地图上。
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(stage(page)).toHaveAttribute("data-visible", String(TOTAL));
    expect(backend.requests.at(-1)?.path).toBe("restore");
    expect(backend.removed.size).toBe(0);
    await expect.poll(() => alphaAt(page, b0)).toBeGreaterThan(0);
  });

  test("点过多簇的提示选中整簇，预览最多样的 N 张后移除其余的", async ({ page }) => {
    const backend = await mockReadyBackend(page);
    await openAtlas(page);

    await page.getByTestId("atlas-hint-cluster").getByRole("button").click();
    await expect(page.getByTestId("atlas-selection")).toHaveAttribute("data-count", "12");
    const keep = Number(await page.getByTestId("atlas-keep-n").inputValue());
    expect(keep).toBeGreaterThanOrEqual(1);
    expect(keep).toBeLessThan(12);

    await page.getByTestId("atlas-keep-preview").click();
    await expect(page.getByTestId("atlas-keep-hint")).toContainText(`保留 ${keep} 张，移除 ${12 - keep} 张`);
    await page.getByTestId("atlas-keep-apply").click();

    await expect(stage(page)).toHaveAttribute("data-visible", String(TOTAL - (12 - keep)));
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]!.ids).toHaveLength(12 - keep);
    for (const assetId of backend.requests[0]!.ids) expect(clusterIds(0)).toContain(assetId);
  });

  test("没有地图时生成，运行中显示阶段和进度，可以取消", async ({ page }) => {
    let state: "none" | "running" = "none";
    const runs: unknown[] = [];
    await mockApi(page, "get", ATLAS_PATH, () => ({ body: state === "running" ? runningAtlas() : noAtlas() }));
    await mockAtlasRun(page, (request) => {
      runs.push(request.postDataJSON());
      state = "running";
      return runningAtlas();
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/atlas/cancel", () => {
      state = "none";
      return { body: noAtlas() };
    });
    await openAtlas(page);

    await expect(page.getByTestId("atlas-status")).toHaveAttribute("data-state", "none");
    await page.getByTestId("atlas-run").click();
    expect(runs).toEqual([{ force: false }]);

    await expect(page.getByTestId("atlas-status")).toHaveAttribute("data-state", "running");
    const progress = page.getByTestId("atlas-progress");
    await expect(progress).toHaveAttribute("data-phase", "embed");
    await expect(progress).toHaveAttribute("data-done", "40");
    await expect(progress).toHaveAttribute("data-total", "160");
    await expect(progress).toContainText("计算嵌入");
    await expect(progress).toContainText("40 / 160");
    await expect(page.getByRole("progressbar")).toBeVisible();

    await page.getByTestId("atlas-cancel").click();
    await expect(page.getByTestId("atlas-status")).toHaveAttribute("data-state", "none");
    await expect(page.getByTestId("atlas-run")).toBeVisible();
  });

  test("DINOv2 模型不可用时提示去模型设置", async ({ page }) => {
    await mockApi(page, "get", ATLAS_PATH, noAtlas());
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/atlas/run", () => ({
      status: 422,
      body: errorEnvelope("atlas_model_unavailable", "DINOv2 模型未安装"),
    }));
    await openAtlas(page);

    await page.getByTestId("atlas-run").click();
    await expect(page.getByTestId("atlas-page")).toHaveAttribute("data-state", "gate");
    await expect(page.getByTestId("atlas-gate")).toContainText("需要 DINOv2 模型");
    await expect(page.getByTestId("atlas-gate-settings")).toHaveAttribute("href", /\/settings\/models$/);
  });

  test("上次运行因为模型失败时直接显示模型提示", async ({ page }) => {
    await mockApi(
      page,
      "get",
      ATLAS_PATH,
      noAtlas({ status: "failed", error: { at: 1_760_000_000, code: "atlas_model_unavailable", message: "DINOv2 模型未安装" } }),
    );
    await openAtlas(page);
    await expect(page.getByTestId("atlas-page")).toHaveAttribute("data-state", "gate");
    await expect(page.getByTestId("atlas-gate-settings")).toBeVisible();
  });
});

test("强制 WebGL2 时用实例化绘制画出同一张图", async ({ page }) => {
  await forceRenderer(page, "webgl2");
  await mockReadyBackend(page);
  await openAtlas(page);

  await expect(page.getByTestId("atlas-renderer")).toHaveAttribute("data-kind", "webgl2");
  await expect(page.getByTestId("atlas-renderer")).toHaveAttribute("data-reason", "forced");
  await expect.poll(() => countPixels(page, "painted")).toBeGreaterThan(100);

  const a0 = await toScreen(page, itemPosition("a0"));
  await page.mouse.move(...a0);
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, -400);
  await expect(stage(page)).toHaveAttribute("data-mode", "sprites");
  await expect.poll(() => countPixels(page, SPRITE_RGB)).toBeGreaterThan(1000);
});
