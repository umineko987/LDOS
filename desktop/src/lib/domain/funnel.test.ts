import { describe, expect, it } from "vitest";

import type { FunnelStage } from "#lib/api/queries/datasets.ts";

import { adjacentStage, attentionStages, DATASET_STAGES, nextStage, outputBars, railStages } from "./funnel.ts";

function stage(partial: Partial<FunnelStage> & Pick<FunnelStage, "stage">): FunnelStage {
  return {
    input: 0,
    output: 0,
    excluded: 0,
    approved: 0,
    input_digest: "",
    status: "idle",
    stale: false,
    last_run: null,
    ...partial,
  };
}

const FUNNEL: FunnelStage[] = [
  stage({ stage: "collect", input: 24, output: 22, excluded: 2 }),
  stage({ stage: "clean", input: 22, output: 20, excluded: 2, status: "succeeded" }),
  stage({ stage: "dedup", input: 20, output: 20, status: "succeeded", stale: true }),
  stage({ stage: "tag", input: 20, output: 20, status: "running" }),
  stage({ stage: "review", input: 20, output: 20, status: "failed" }),
  stage({ stage: "export", input: 20, output: 20, status: "cancelled" }),
];

describe("railStages", () => {
  it("按固定顺序给出计数、去掉的张数和状态", () => {
    const stages = railStages(FUNNEL);
    expect(stages.map((item) => item.stage)).toEqual([...DATASET_STAGES]);
    expect(stages.map((item) => [item.output, item.removed, item.status])).toEqual([
      [22, 2, "done"],
      [20, 2, "done"],
      [20, 0, "stale"],
      [20, 0, "running"],
      [20, 0, "failed"],
      [20, 0, "failed"],
    ]);
    expect(stages[0]!.ratio).toBeCloseTo(22 / 24);
  });

  it("后端缺段或没有数据时补空的 idle 段", () => {
    const stages = railStages([stage({ stage: "dedup", input: 3, output: 3 })]);
    expect(stages).toHaveLength(6);
    expect(stages[0]).toEqual({ stage: "collect", input: 0, output: 0, removed: 0, status: "idle", ratio: 0 });
    expect(stages[2]).toMatchObject({ output: 3, status: "idle", ratio: 1 });
    expect(railStages(undefined).every((item) => item.status === "idle" && item.ratio === 0)).toBe(true);
  });

  it("采集段在运行（扫描）时显示运行中", () => {
    expect(railStages([stage({ stage: "collect", input: 5, output: 5, status: "running" })])[0]!.status).toBe("running");
  });
});

describe("nextStage / attentionStages", () => {
  it("点进第一段没完成的", () => {
    expect(nextStage(railStages(FUNNEL))).toBe("dedup");
    expect(nextStage(railStages([]))).toBe("collect");
    const done = railStages(DATASET_STAGES.map((name) => stage({ stage: name, input: 1, output: 1, status: "succeeded" })));
    expect(nextStage(done)).toBe("export");
  });

  it("列出运行中、需重跑和失败的段", () => {
    expect(attentionStages(railStages(FUNNEL)).map((item) => item.stage)).toEqual(["dedup", "tag", "review", "export"]);
  });
});

describe("adjacentStage", () => {
  const order = ["a", "b", "c"] as const;
  it("前后循环", () => {
    expect(adjacentStage(order, "a", 1)).toBe("b");
    expect(adjacentStage(order, "c", 1)).toBe("a");
    expect(adjacentStage(order, "a", -1)).toBe("c");
  });
  it("不在列表里时从头或从尾开始", () => {
    expect(adjacentStage(order, null, 1)).toBe("a");
    expect(adjacentStage(order, null, -1)).toBe("c");
  });
});

describe("outputBars", () => {
  it("按固定顺序补齐六段，比例相对成员总数", () => {
    const bars = outputBars(24, [
      { stage: "dedup", output: 18, stale: true },
      { stage: "collect", output: 22, stale: false },
    ]);
    expect(bars.map((bar) => bar.stage)).toEqual([...DATASET_STAGES]);
    expect(bars[0]).toEqual({ stage: "collect", output: 22, stale: false, ratio: 22 / 24 });
    expect(bars[2]).toEqual({ stage: "dedup", output: 18, stale: true, ratio: 18 / 24 });
    expect(bars[5]).toEqual({ stage: "export", output: 0, stale: false, ratio: 0 });
  });

  it("空数据集和异常计数不越界", () => {
    expect(outputBars(0, []).every((bar) => bar.ratio === 0)).toBe(true);
    expect(outputBars(2, [{ stage: "collect", output: 5, stale: false }])[0]!.ratio).toBe(1);
    expect(outputBars(2, [{ stage: "collect", output: -1, stale: false }])[0]!.output).toBe(0);
  });
});
