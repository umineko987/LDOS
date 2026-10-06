import { describe, expect, it } from "vitest";
import {
  downloadProgress,
  isRunning,
  lastSummary,
  stageProgress,
  toggleModel,
  validateStart,
} from "./controller";
import type { TaggerStatus } from "./model";

function statusOf(patch: Partial<TaggerStatus>): TaggerStatus {
  return {
    phase: "idle",
    stage: "",
    done: 0,
    total: 0,
    message: "",
    download: {},
    lastResult: null,
    enabled: true,
    ...patch,
  };
}

describe("stageProgress", () => {
  it("is zero without totals", () => {
    expect(stageProgress(null)).toBe(0);
    expect(stageProgress(statusOf({}))).toBe(0);
  });

  it("advances through hashing/inferring/selecting", () => {
    const hashing = stageProgress(statusOf({ phase: "tagging", stage: "hashing", done: 5, total: 10 }));
    const inferring = stageProgress(statusOf({ phase: "tagging", stage: "inferring", done: 5, total: 10 }));
    const selecting = stageProgress(statusOf({ phase: "tagging", stage: "selecting", done: 10, total: 10 }));
    expect(hashing).toBeGreaterThan(0);
    expect(inferring).toBeGreaterThan(hashing);
    expect(selecting).toBeGreaterThan(inferring);
    expect(selecting).toBeLessThanOrEqual(1);
  });
});

describe("downloadProgress", () => {
  it("returns the first active download entry", () => {
    const entry = downloadProgress(statusOf({ download: { m: { file: "f.onnx", done: 3, total: 9 } } }));
    expect(entry).toEqual({ model: "m", file: "f.onnx", done: 3, total: 9 });
  });

  it("is null without downloads", () => {
    expect(downloadProgress(null)).toBeNull();
    expect(downloadProgress(statusOf({}))).toBeNull();
  });
});

describe("isRunning / lastSummary", () => {
  it("tracks preparing and tagging only", () => {
    expect(isRunning(statusOf({ phase: "preparing" }))).toBe(true);
    expect(isRunning(statusOf({ phase: "tagging" }))).toBe(true);
    expect(isRunning(statusOf({ phase: "idle" }))).toBe(false);
    expect(isRunning(statusOf({ phase: "failed" }))).toBe(false);
    expect(isRunning(null)).toBe(false);
  });

  it("exposes the last run summary", () => {
    const summary = { total: 1, perModel: {}, decodeErrors: [], captionsWritten: 1, captionsSkipped: 0 };
    expect(lastSummary(statusOf({ lastResult: summary }))).toEqual(summary);
    expect(lastSummary(null)).toBeNull();
  });
});

describe("toggleModel", () => {
  it("appends and removes while preserving order", () => {
    let selected: readonly string[] = [];
    selected = toggleModel(selected, "a");
    selected = toggleModel(selected, "b");
    expect(selected).toEqual(["a", "b"]);
    selected = toggleModel(selected, "a");
    expect(selected).toEqual(["b"]);
  });
});

describe("validateStart", () => {
  it("requires inputs and a model selection", () => {
    expect(validateStart([], "")).toContain("路径");
    expect(validateStart([], "/x")).toContain("模型");
    expect(validateStart(["m"], "/x")).toBe("");
    expect(validateStart(["m"], "  \n ")).toContain("路径");
  });
});
