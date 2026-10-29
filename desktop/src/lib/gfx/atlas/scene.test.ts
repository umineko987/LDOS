import { describe, expect, it } from "vitest";

import { buildAtlasModel, FLAG_HIDDEN, type AtlasResponse } from "#lib/domain/atlas-model.ts";

import {
  CLUSTER_PALETTE,
  CLUSTER_PALETTE_HEX,
  clusterColorIndex,
  colorGroups,
  MAX_PALETTE,
  neededSheets,
  readSceneColors,
  rgbCss,
  sheetRuns,
  spriteOrder,
  spriteSource,
} from "./scene.ts";

const model = buildAtlasModel({
  dataset_id: "d1",
  status: "ready",
  availability: { available: true, reason: "" },
  cached: false,
  stale: false,
  current_digest: "x",
  delta: { added: 0, changed: 0, removed_asset_ids: [] },
  items: [
    { asset_id: "a", x: 0, y: 0, cluster: 0, outlier: 0, sprite: [1, 0] },
    { asset_id: "b", x: 0, y: 0, cluster: 11, outlier: 0, sprite: null },
    { asset_id: "c", x: 0, y: 0, cluster: 2, outlier: 0, sprite: [0, 3] },
    { asset_id: "d", x: 0, y: 0, cluster: 1, outlier: 0, sprite: [1, 2] },
  ],
  sprites: { format: "webp", sheet_size: 128, cell_size: 64, columns: 2, per_sheet: 4, urls: ["/s/0", "/s/1"] },
} satisfies AtlasResponse);

describe("atlas scene", () => {
  it("调色板不含金色，簇编号循环取色", () => {
    expect(CLUSTER_PALETTE).toHaveLength(CLUSTER_PALETTE_HEX.length);
    expect(CLUSTER_PALETTE.length).toBeLessThanOrEqual(MAX_PALETTE);
    expect(CLUSTER_PALETTE_HEX).not.toContain("#e6bd75");
    expect(clusterColorIndex(11, 10)).toBe(1);
    expect(clusterColorIndex(3, 0)).toBe(0);
    expect(rgbCss([1, 2, 3])).toBe("rgb(1 2 3)");
    expect(rgbCss([1, 2, 3], 0.5)).toBe("rgb(1 2 3 / 0.5)");
  });

  it("从令牌读场景颜色，读不到时用默认值", () => {
    const colors = readSceneColors((name) => (name === "--gold" ? " #ffffff " : ""));
    expect(colors.selected).toEqual([255, 255, 255]);
    expect(colors.drop).toEqual([215, 122, 110]);
    expect(Object.keys(colors).sort()).toEqual(["drop", "outlier", "placeholder", "removed", "selected"]);
  });

  it("格子位置", () => {
    expect(spriteSource(3, { columns: 2, cellSize: 64 })).toEqual([64, 64, 64]);
    expect(spriteSource(0, { columns: 32, cellSize: 64 })).toEqual([0, 0, 64]);
  });

  it("缩略图按雪碧图排序并分段，去掉隐藏的点", () => {
    const flags = new Uint8Array(model.count);
    flags[3] = FLAG_HIDDEN;
    const order = spriteOrder(model, flags, [0, 1, 2, 3, 9]);
    expect([...order]).toEqual([2, 0, 1]);
    expect(neededSheets(model, order)).toEqual([0, 1]);
    expect(sheetRuns(model, order)).toEqual([
      { sheet: 0, start: 0, count: 1 },
      { sheet: 1, start: 1, count: 1 },
      { sheet: -1, start: 2, count: 1 },
    ]);
    expect(sheetRuns(model, new Int32Array(0))).toEqual([]);
    expect(sheetRuns(model, spriteOrder(model, new Uint8Array(model.count), [0, 3]))).toEqual([{ sheet: 1, start: 0, count: 2 }]);
  });

  it("点模式按颜色分组", () => {
    expect(colorGroups(model, 10)).toEqual([[0], [1, 3], [2], [], [], [], [], [], [], []]);
    expect(colorGroups(model, 0)).toEqual([[0, 1, 2, 3]]);
  });
});
