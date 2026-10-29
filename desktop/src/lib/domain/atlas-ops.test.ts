import { describe, expect, it } from "vitest";

import { ApiError } from "#lib/api/errors.ts";
import type { components } from "#lib/api/schema.d.ts";

import { buildAtlasModel, type AtlasResponse } from "./atlas-model.ts";
import { atlasProgress, atlasViewState, keepDiverse, keepTarget } from "./atlas-ops.ts";

type JobResponse = components["schemas"]["JobResponse"];

function atlas(overrides: Partial<AtlasResponse> = {}): AtlasResponse {
  return {
    dataset_id: "d1",
    status: "ready",
    availability: { available: true, reason: "" },
    cached: false,
    stale: false,
    current_digest: "x",
    delta: { added: 0, changed: 0, removed_asset_ids: [] },
    ...overrides,
  };
}

function job(overrides: Partial<JobResponse> = {}): JobResponse {
  return {
    id: "atlas:d1",
    kind: "atlas.build",
    title: "atlas",
    status: "running",
    message: "计算嵌入",
    ref: { dataset_id: "d1" },
    started_at: 1,
    updated_at: 2,
    current: 30,
    total: 120,
    ...overrides,
  };
}

const gate = new ApiError({ status: 409, code: "atlas_model_unavailable", message: "DINOv2 模型不可用" });
const other = new ApiError({ status: 500, code: "boom" });

describe("atlasViewState", () => {
  it("没有数据时：加载中、模型提示或错误", () => {
    expect(atlasViewState(undefined, null, null)).toBe("loading");
    expect(atlasViewState(undefined, gate, null)).toBe("gate");
    expect(atlasViewState(undefined, other, null)).toBe("error");
  });

  it("按运行、可用性、模型、失败、未生成、过时、就绪的顺序判断", () => {
    expect(atlasViewState(atlas({ status: "running" }), null, gate)).toBe("running");
    expect(atlasViewState(atlas({ availability: { available: false, reason: "dedup_disabled" } }), null, null)).toBe(
      "unavailable",
    );
    expect(atlasViewState(atlas({ status: "none" }), null, gate)).toBe("gate");
    expect(
      atlasViewState(atlas({ status: "failed", error: { code: "atlas_model_unavailable", message: "", at: 1 } }), null, null),
    ).toBe("gate");
    expect(atlasViewState(atlas({ status: "failed", error: { code: "atlas_worker_failed", message: "", at: 1 } }), null, other)).toBe(
      "failed",
    );
    expect(atlasViewState(atlas({ status: "none" }), null, null)).toBe("none");
    expect(atlasViewState(atlas({ status: "stale" }), null, null)).toBe("stale");
    expect(atlasViewState(atlas({ stale: true }), null, null)).toBe("stale");
    expect(atlasViewState(atlas(), null, null)).toBe("ready");
  });
});

describe("atlasProgress", () => {
  it("不在运行时为空", () => {
    expect(atlasProgress(undefined, null)).toBeNull();
    expect(atlasProgress(atlas(), job())).toBeNull();
  });

  it("阶段取自地图，计数优先用运行中的任务", () => {
    const running = atlas({ status: "running", progress: { phase: "embed", label: "计算嵌入", done: 10, total: 120 } });
    expect(atlasProgress(running, job())).toEqual({ phase: "embed", label: "计算嵌入", done: 30, total: 120, fraction: 0.25 });
    expect(atlasProgress(running, job({ status: "succeeded" }))?.done).toBe(10);
    expect(atlasProgress(running, null)?.fraction).toBeCloseTo(10 / 120);
    expect(atlasProgress(running, job({ current: 500 }))?.fraction).toBe(1);
  });

  it("未知阶段和没有总数", () => {
    const odd = atlas({ status: "running", progress: { phase: "warmup", label: "", done: null, total: null } });
    expect(atlasProgress(odd, job({ current: null, total: null, message: "热身" }))).toEqual({
      phase: null,
      label: "热身",
      done: null,
      total: null,
      fraction: null,
    });
    expect(atlasProgress(atlas({ status: "running" }), null)).toEqual({
      phase: "queued",
      label: "queued",
      done: null,
      total: null,
      fraction: null,
    });
    expect(atlasProgress(atlas({ status: "running", progress: { phase: "read", label: "读取图片", done: -1, total: 0 } }), null)?.fraction).toBeNull();
  });
});

describe("keepTarget", () => {
  it("让簇的占比回到阈值以下", () => {
    // 100 张里有 30 张在这一簇，阈值 8%：保留 n 张时 n / (70 + n) ≤ 0.08 ⇒ n ≤ 6.08。
    expect(keepTarget(100, 30, 0.08)).toBe(6);
    expect(keepTarget(10, 10, 0.08)).toBe(1);
    expect(keepTarget(100, 0, 0.08)).toBe(0);
    expect(keepTarget(100, 30, 0)).toBe(30);
    expect(keepTarget(100, 30, 1)).toBe(30);
    expect(keepTarget(100, 3, 0.5)).toBe(3);
  });
});

function modelWithVectors(vectors: AtlasResponse["vectors"]) {
  return buildAtlasModel(
    atlas({
      items: [
        { asset_id: "a", x: 0, y: 0, cluster: 0, outlier: 0 },
        { asset_id: "b", x: 0.1, y: 0, cluster: 0, outlier: 0 },
        { asset_id: "c", x: 0.2, y: 0, cluster: 0, outlier: 0 },
        { asset_id: "d", x: 0.3, y: 0, cluster: 0, outlier: 0 },
      ],
      vectors,
    }),
  );
}

describe("keepDiverse", () => {
  // 一维向量 0、1、2、10：均值 3.25，离它最近的是 2；再取离 2 最远的 10。
  const vectors = { dims: 1, dtype: "int8", encoding: "base64", order: "items", scales: [1], data: btoa("\u0000\u0001\u0002\u000a") } as const;

  it("留下最不相似的 n 张", () => {
    const model = modelWithVectors({ ...vectors, scales: [1] });
    expect(keepDiverse(model, [0, 1, 2, 3, 3], 2)).toEqual({ keep: [2, 3], drop: [0, 1] });
    expect(keepDiverse(model, [0, 1], 5)).toEqual({ keep: [0, 1], drop: [] });
  });

  it("没有向量时为空；对不上向量行的点保留", () => {
    expect(keepDiverse(modelWithVectors(null), [0, 1], 1)).toBeNull();
    const model = modelWithVectors({ ...vectors, scales: [1] });
    expect(keepDiverse(model, [0, 1, 9], 2)).toEqual({ keep: [0, 9], drop: [1] });
  });
});
