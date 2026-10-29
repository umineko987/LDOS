import { describe, expect, it } from "vitest";

import {
  applySelection,
  buildAtlasModel,
  buildFlags,
  clusterMembers,
  FLAG_DROP,
  FLAG_HIDDEN,
  FLAG_OUTLIER,
  FLAG_REMOVED,
  FLAG_SELECTED,
  isRemoved,
  liveCount,
  partitionSelection,
  type AtlasResponse,
  type FlagState,
} from "./atlas-model.ts";

function response(overrides: Partial<AtlasResponse> = {}): AtlasResponse {
  return {
    dataset_id: "d1",
    status: "ready",
    availability: { available: true, reason: "" },
    cached: false,
    stale: false,
    current_digest: "digest",
    delta: { added: 0, changed: 0, removed_asset_ids: ["a2"] },
    run: { run_id: "1760000000000-0123abcd", options: {}, params: {}, counts: {} },
    items: [
      { asset_id: "a0", x: -0.5, y: 0.5, cluster: 0, outlier: 0.1, sha256: null, sprite: [0, 0] },
      { asset_id: "a1", x: 0.5, y: 0.5, cluster: 1, outlier: 0.95, sha256: null, sprite: [0, 1] },
      { asset_id: "a2", x: 0, y: 0, cluster: 0, outlier: 0.99, sha256: null, sprite: [1, 3] },
      { asset_id: "bad", x: Number.NaN, y: 0, cluster: 0, outlier: 0, sha256: null, sprite: null },
      { asset_id: "a1", x: 0.1, y: 0.1, cluster: 0, outlier: 0, sha256: null, sprite: null },
      { asset_id: "a3", x: 0.2, y: -0.2, cluster: 70_000, outlier: Number.NaN, sha256: null, sprite: [0, 9] },
    ],
    clusters: [
      { id: 0, size: 3, share: 0.6, medoid_asset_id: "a0", x: -0.2, y: 0.2, live_size: 2, live_share: 0.67 },
      { id: 1, size: 1, share: 0.2, medoid_asset_id: "missing", x: 0.5, y: 0.5, live_size: 1, live_share: 0.33 },
    ],
    hints: {
      share_threshold: 0.08,
      outlier_threshold: 0.9,
      over_represented: [{ cluster: 0, share: 0.67, size: 2 }],
      outliers: ["a2", "a1", "ghost"],
    },
    sprites: { format: "webp", sheet_size: 128, cell_size: 64, columns: 2, per_sheet: 4, urls: ["/s/0", "/s/1"] },
    vectors: { dims: 2, dtype: "int8", encoding: "base64", order: "items", scales: [1, 1], data: btoa("\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c") },
    ...overrides,
  };
}

const none = new Set<number>();
const state = (overrides: Partial<FlagState> = {}): FlagState => ({
  selected: none,
  drop: none,
  pendingRemoved: none,
  pendingRestored: none,
  showRemoved: false,
  ...overrides,
});

describe("buildAtlasModel", () => {
  it("丢掉坐标无效和重复的点，记下向量行号", () => {
    const model = buildAtlasModel(response());
    expect(model.ids).toEqual(["a0", "a1", "a2", "a3"]);
    expect(model.count).toBe(4);
    expect([...model.vectorRow]).toEqual([0, 1, 2, 5]);
    expect(model.indexOf.get("a2")).toBe(2);
    expect([...model.positions]).toEqual([-0.5, 0.5, 0.5, 0.5, 0, 0, 0.20000000298023224, -0.20000000298023224]);
    expect(model.runId).toBe("1760000000000-0123abcd");
    expect(model.vectors?.count).toBe(6);
  });

  it("簇编号和离群分被夹住；雪碧图格子越界时当作没有", () => {
    const model = buildAtlasModel(response());
    expect([...model.clusters]).toEqual([0, 1, 0, 0xffff]);
    expect(model.outlier[3]).toBe(0);
    // a2 的格子 [1, 3]：第二张图第 3 格（行 1 列 1）合法；a3 的格子 9 超出 per_sheet。
    expect([...model.sprites]).toEqual([0, 0, 0, 1, 1, 3, -1, -1]);
    expect(model.sheets).toEqual({ urls: ["/s/0", "/s/1"], sheetSize: 128, cellSize: 64, columns: 2, perSheet: 4 });
  });

  it("已移除的点、簇信息和提示", () => {
    const model = buildAtlasModel(response());
    expect([...model.removed]).toEqual([0, 0, 1, 0]);
    expect(model.removedCount).toBe(1);
    expect(model.clusterList.map((cluster) => [cluster.id, cluster.medoid, cluster.overRepresented])).toEqual([
      [0, 0, true],
      [1, -1, false],
    ]);
    // 离群提示去掉了已移除的 a2 和不存在的 ghost。
    expect(model.outliers).toEqual([1]);
    expect(model.outlierThreshold).toBe(0.9);
    expect(model.shareThreshold).toBe(0.08);
  });

  it("没有结果时是空模型；雪碧图和向量无效时为 null", () => {
    const empty = buildAtlasModel(
      response({ items: undefined, clusters: undefined, hints: null, sprites: null, vectors: null, run: null }),
    );
    expect(empty.count).toBe(0);
    expect(empty.runId).toBeNull();
    expect(empty.sheets).toBeNull();
    expect(empty.vectors).toBeNull();
    expect(empty.outlierThreshold).toBe(1);
    expect(empty.clusterList).toEqual([]);

    const sprites = { format: "webp" as const, sheet_size: 128, cell_size: 64, columns: 2, per_sheet: 4, urls: ["/s/0"] };
    for (const broken of [
      { ...sprites, urls: [] },
      { ...sprites, columns: 3 },
      { ...sprites, cell_size: 0 },
      { ...sprites, urls: ["//evil/s"] },
      { ...sprites, urls: ["https://evil/s"] },
    ]) {
      expect(buildAtlasModel(response({ sprites: broken })).sheets).toBeNull();
    }
    const model = buildAtlasModel(response({ sprites: { ...sprites, per_sheet: 8 } }));
    // per_sheet 比格子容量还大时，超出行数的格子也不要。
    expect(buildAtlasModel(response({ items: [{ ...response().items![0]!, sprite: [0, 7] }], sprites: { ...sprites, per_sheet: 8 } })).sprites[0]).toBe(-1);
    expect(model.sprites[0]).toBe(0);
    expect(buildAtlasModel(response({ items: [{ ...response().items![0]!, sprite: [0.5, 1] as never }] })).sprites[0]).toBe(-1);
    expect(buildAtlasModel(response({ items: [{ ...response().items![0]!, sprite: [0] as never }] })).sprites[0]).toBe(-1);
  });
});

describe("flags and selection", () => {
  const model = buildAtlasModel(response());

  it("隐藏已移除的点；显示时画成已移除，可以选中", () => {
    expect([...buildFlags(model, state())]).toEqual([0, FLAG_OUTLIER, FLAG_REMOVED | FLAG_HIDDEN, 0]);
    const flags = buildFlags(model, state({ showRemoved: true, selected: new Set([2, 0]), drop: new Set([0]) }));
    expect([...flags]).toEqual([FLAG_SELECTED | FLAG_DROP, FLAG_OUTLIER, FLAG_REMOVED | FLAG_SELECTED, 0]);
    // 隐藏的点即使在选择里也不画选中态。
    expect(buildFlags(model, state({ selected: new Set([2]) }))[2]).toBe(FLAG_REMOVED | FLAG_HIDDEN);
  });

  it("乐观移除和恢复覆盖响应里的状态", () => {
    const pending = { pendingRemoved: new Set([0]), pendingRestored: new Set([2]) };
    expect(isRemoved(model, pending, 0)).toBe(true);
    expect(isRemoved(model, pending, 2)).toBe(false);
    expect(liveCount(model, pending)).toBe(3);
    expect(liveCount(model, state())).toBe(3);
    expect(buildFlags(model, state(pending))[0]).toBe(FLAG_REMOVED | FLAG_HIDDEN);
  });

  it("按簇取成员；选择按是否已移除分组", () => {
    expect(clusterMembers(model, 0, (index) => !isRemoved(model, state(), index))).toEqual([0]);
    expect(clusterMembers(model, 0, () => true)).toEqual([0, 2]);
    expect(partitionSelection(model, state(), [3, 2, 0, 99, -1])).toEqual({ live: [0, 3], removed: [2] });
  });

  it("替换、追加、切换", () => {
    const current = new Set([1, 2]);
    expect([...applySelection(current, [3], "replace")]).toEqual([3]);
    expect([...applySelection(current, [2, 3], "add")].sort()).toEqual([1, 2, 3]);
    expect([...applySelection(current, [2, 3], "toggle")].sort()).toEqual([1, 3]);
    expect([...current]).toEqual([1, 2]);
  });
});
