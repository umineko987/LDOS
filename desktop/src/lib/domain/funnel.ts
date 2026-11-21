// 漏斗：阶段轨道和首页卡片共用的派生数据。
//
// 后端给每一段 input（进入这段的图）、excluded（这段排除的）、output = input − excluded，
// 以及最近一次运行的状态和 stale（输入摘要变了）。轨道上每段显示 output，也就是下一段的输入量。

import type { DatasetStage, FunnelStage } from "#lib/api/queries/datasets.ts";

export const DATASET_STAGES = ["collect", "clean", "dedup", "tag", "export"] as const satisfies readonly DatasetStage[];

export type PipelineStage = (typeof DATASET_STAGES)[number];

/**
 * 轨道上的状态：
 * - `idle` 还没跑过（采集段：还没有图）
 * - `running` 正在跑
 * - `done` 最近一次成功且输入没变（采集段：有图）
 * - `stale` 成功过，但输入已经变了，需要重跑
 * - `failed` 最近一次失败或被取消
 */
export type RailStatus = "idle" | "running" | "done" | "stale" | "failed";

export interface RailStage {
  readonly stage: PipelineStage;
  readonly input: number;
  readonly output: number;
  /** 这一段去掉的张数（input − output）。 */
  readonly removed: number;
  readonly status: RailStatus;
  /** output 占采集总量的比例，0–1；画迷你条形图用。 */
  readonly ratio: number;
}

function railStatus(stage: FunnelStage | undefined): RailStatus {
  if (!stage) return "idle";
  if (stage.status === "running") return "running";
  if (stage.stage === "collect") return stage.input > 0 ? "done" : "idle";
  if (stage.status === "failed" || stage.status === "cancelled") return "failed";
  if (stage.status === "succeeded") return stage.stale ? "stale" : "done";
  return "idle";
}

/** 按固定顺序给出五段；后端缺了某一段时补成空的 idle 段。 */
export function railStages(funnel: readonly FunnelStage[] | undefined): RailStage[] {
  const byStage = new Map((funnel ?? []).map((stage) => [stage.stage, stage]));
  const total = Math.max(1, byStage.get("collect")?.input ?? 0);
  return DATASET_STAGES.map((name) => {
    const stage = byStage.get(name);
    const input = stage?.input ?? 0;
    const output = stage?.output ?? 0;
    return {
      stage: name,
      input,
      output,
      removed: Math.max(0, input - output),
      status: railStatus(stage),
      ratio: Math.min(1, output / total),
    };
  });
}

/** 首页卡片点进去的阶段：第一段还没完成（未开始、运行中、需重跑、失败）的；全部完成时到导出。 */
export function nextStage(stages: readonly RailStage[]): PipelineStage {
  return stages.find((stage) => stage.status !== "done")?.stage ?? "export";
}

/** 需要留意的段（运行中、需重跑、失败），首页卡片的提示行用。 */
export function attentionStages(stages: readonly RailStage[]): RailStage[] {
  return stages.filter((stage) => stage.status === "running" || stage.status === "stale" || stage.status === "failed");
}

/** 轨道上的 `[` / `]`：在五段和地图之间循环切换。 */
export function adjacentStage<T extends string>(order: readonly T[], current: T | null, delta: 1 | -1): T {
  if (current === null || !order.includes(current)) return order[delta === 1 ? 0 : order.length - 1]!;
  const index = order.indexOf(current);
  return order[(index + delta + order.length) % order.length]!;
}

export interface OutputBar {
  readonly stage: PipelineStage;
  readonly output: number;
  readonly stale: boolean;
  /** output 占成员总数的比例，0–1。 */
  readonly ratio: number;
}

/**
 * 首页卡片的迷你漏斗：列表接口只给每段 output 和 stale（没有运行状态），
 * 按固定顺序补齐五段，比例相对成员总数。
 */
export function outputBars(
  memberCount: number,
  outputs: readonly { readonly stage: DatasetStage; readonly output: number; readonly stale: boolean }[],
): OutputBar[] {
  const byStage = new Map(outputs.map((item) => [item.stage, item]));
  const total = Math.max(1, memberCount);
  return DATASET_STAGES.map((stage) => {
    const item = byStage.get(stage);
    const output = Math.max(0, item?.output ?? 0);
    return { stage, output, stale: item?.stale ?? false, ratio: Math.min(1, output / total) };
  });
}
