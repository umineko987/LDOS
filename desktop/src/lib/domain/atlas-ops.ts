// 语义地图页面的状态推导：显示哪种状态、运行进度、“保留 N 张”的默认值和挑选。

import { isApiError } from "#lib/api/errors.ts";
import type { components } from "#lib/api/schema.d.ts";

import type { AtlasModel, AtlasResponse } from "./atlas-model.ts";
import { farthestPointSample } from "./farthest.ts";

type JobResponse = components["schemas"]["JobResponse"];

/** worker 报告 DINOv2 模型加载不了时，失败信息里的错误码。 */
export const ATLAS_MODEL_UNAVAILABLE = "atlas_model_unavailable";

export const ATLAS_PHASES = [
  "queued",
  "preparing",
  "hashing",
  "read",
  "embed",
  "pca",
  "neighbors",
  "layout",
  "cluster",
  "write",
] as const;

export type AtlasPhase = (typeof ATLAS_PHASES)[number];

/** 地图上拖动的作用：平移视图，或画套索。按住 Shift 拖动总是套索。 */
export type AtlasTool = "pan" | "lasso";

export type AtlasViewState =
  | "loading"
  | "error"
  | "unavailable"
  | "gate"
  | "none"
  | "running"
  | "failed"
  | "stale"
  | "ready";

function isGateError(error: unknown): boolean {
  return isApiError(error) && error.code === ATLAS_MODEL_UNAVAILABLE;
}

/**
 * 页面显示哪种状态。`runError` 是上一次点“生成”时的错误：模型不可用时后端可能直接拒绝，
 * 也可能先开跑、由 worker 报失败，两种都显示模型提示。
 */
export function atlasViewState(atlas: AtlasResponse | undefined, error: unknown, runError: unknown): AtlasViewState {
  if (!atlas) return error ? (isGateError(error) ? "gate" : "error") : "loading";
  if (atlas.status === "running") return "running";
  if (!atlas.availability.available) return "unavailable";
  if (isGateError(runError) || (atlas.status === "failed" && atlas.error?.code === ATLAS_MODEL_UNAVAILABLE)) return "gate";
  if (atlas.status === "failed") return "failed";
  if (atlas.status === "none") return "none";
  if (atlas.status === "stale" || atlas.stale) return "stale";
  return "ready";
}

export interface AtlasProgressView {
  /** 已知阶段（可以翻译）；未知时为 null，界面用 `label`。 */
  readonly phase: AtlasPhase | null;
  readonly label: string;
  readonly done: number | null;
  readonly total: number | null;
  /** 0..1；没有总数时为 null（不确定进度）。 */
  readonly fraction: number | null;
}

const count = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * 运行进度：阶段来自 GET atlas（轮询），计数优先用任务事件（`atlas:{id}`，推送得更勤）。
 * 不在运行时为 null。
 */
export function atlasProgress(atlas: AtlasResponse | undefined, job: JobResponse | null): AtlasProgressView | null {
  if (atlas?.status !== "running") return null;
  const progress = atlas.progress ?? null;
  const phaseName = progress?.phase ?? "queued";
  const phase = (ATLAS_PHASES as readonly string[]).includes(phaseName) ? (phaseName as AtlasPhase) : null;
  const live = job?.status === "running" ? job : null;
  const done = count(live?.current) ?? count(progress?.done);
  const total = count(live?.total) ?? count(progress?.total);
  const fraction = done !== null && total ? Math.min(1, done / total) : null;
  return { phase, label: progress?.label || live?.message || phaseName, done, total, fraction };
}

/**
 * 某一簇最多保留多少张，才能让它的占比回到阈值以下：
 * n / (total − size + n) ≤ t  ⇒  n ≤ t·(total − size) / (1 − t)。至少保留 1 张。
 */
export function keepTarget(liveTotal: number, clusterLive: number, threshold: number): number {
  if (clusterLive <= 0) return 0;
  if (!(threshold > 0 && threshold < 1)) return clusterLive;
  const n = Math.floor((threshold * Math.max(0, liveTotal - clusterLive)) / (1 - threshold));
  return Math.min(clusterLive, Math.max(1, n));
}

export interface KeepPlan {
  readonly keep: number[];
  readonly drop: number[];
}

/**
 * 在 `indices` 里用最远点采样留下 `n` 张最不相似的，其余进 drop。
 * 没有向量时返回 null；对不上向量行的点不参与挑选，也不会被去掉。
 */
export function keepDiverse(model: AtlasModel, indices: readonly number[], n: number): KeepPlan | null {
  const vectors = model.vectors;
  if (!vectors) return null;
  const byRow = new Map<number, number>();
  const unmatched: number[] = [];
  for (const index of new Set(indices)) {
    const row = model.vectorRow[index];
    if (row === undefined || row < 0 || row >= vectors.count) unmatched.push(index);
    else byRow.set(row, index);
  }
  const chosen = new Set(farthestPointSample(vectors, [...byRow.keys()], Math.max(0, n - unmatched.length)));
  const keep = [...unmatched];
  const drop: number[] = [];
  for (const [row, index] of byRow) (chosen.has(row) ? keep : drop).push(index);
  keep.sort((a, b) => a - b);
  drop.sort((a, b) => a - b);
  return { keep, drop };
}
