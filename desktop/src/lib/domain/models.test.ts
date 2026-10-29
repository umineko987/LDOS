import { describe, expect, it } from "vitest";

import type { Job } from "#lib/events/bus.ts";

import {
  anyInstalling,
  canInstall,
  formatBytes,
  installSet,
  isTerminalJob,
  licenseItems,
  mergeJob,
  missingKeys,
  progressRatio,
  statusTone,
  type ModelItem,
} from "./models.ts";

function model(key: string, overrides: Partial<ModelItem> = {}): ModelItem {
  return {
    key,
    family: "dedup",
    display_name: key,
    status: "missing",
    size_bytes: 1024,
    installed_bytes: 0,
    license: "MIT",
    gated: false,
    source_url: `https://huggingface.co/${key}`,
    used_by: ["dedup"],
    installs_with: [],
    message: "",
    progress: null,
    job_id: null,
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "models:dedup",
    kind: "models",
    title: "安装模型",
    status: "running",
    current: 10,
    total: 40,
    message: "10/40",
    ref: {},
    started_at: 1,
    updated_at: 2,
    finished_at: null,
    ...overrides,
  };
}

const ITEMS = [
  model("sscd", { installs_with: ["dino"] }),
  model("dino", { installs_with: ["sscd"], status: "installed" }),
  model("cl", { family: "tagger", gated: true, status: "needs_license", license: "custom" }),
  model("wd", { family: "tagger", status: "installed", gated: true }),
];

describe("model helpers", () => {
  it("only offers install for missing, failed or license-gated models", () => {
    expect(["missing", "failed", "needs_license"].map((status) => canInstall(model("a", { status: status as never })))).toEqual([
      true,
      true,
      true,
    ]);
    expect(["installed", "installing", "disabled"].some((status) => canInstall(model("a", { status: status as never })))).toBe(false);
  });

  it("lists missing keys, keeping unknown ones for the backend to reject", () => {
    expect(missingKeys(ITEMS, ["dino", "sscd", "sscd", "ghost"])).toEqual(["sscd", "ghost"]);
  });

  it("expands keys with the models installed in the same bundle", () => {
    expect(installSet(ITEMS, ["sscd", "cl"])).toEqual(["sscd", "dino", "cl"]);
    expect(installSet(ITEMS, ["ghost"])).toEqual(["ghost"]);
  });

  it("asks for a license only for gated models that are not installed", () => {
    expect(licenseItems(ITEMS, ["sscd", "cl", "wd", "cl"]).map((item) => item.key)).toEqual(["cl"]);
  });

  it("merges running job progress into the matching item", () => {
    const items = [model("sscd", { status: "installing", job_id: "models:dedup", progress: { current: 0, total: 0 } }), model("cl")];
    const merged = mergeJob(items, job());
    expect(merged.matched).toBe(true);
    expect(merged.finished).toBe(false);
    expect(merged.items[0]).toMatchObject({ status: "installing", progress: { current: 10, total: 40 }, message: "10/40" });
    expect(merged.items[1]).toBe(items[1]);
  });

  it("keeps the previous progress when the job does not report counts", () => {
    const items = [model("sscd", { job_id: "models:dedup", progress: { current: 5, total: 9 }, message: "下载中" })];
    const merged = mergeJob(items, job({ current: null, total: null, message: "" }));
    expect(merged.items[0]).toMatchObject({ progress: { current: 5, total: 9 }, message: "下载中" });
    expect(mergeJob([model("x", { job_id: "models:dedup" })], job({ current: null, total: null })).items[0]!.progress).toEqual({
      current: 0,
      total: 0,
    });
  });

  it("reports a finished job without inventing a final status", () => {
    const items = [model("sscd", { status: "installing", job_id: "models:dedup" })];
    const merged = mergeJob(items, job({ status: "succeeded" }));
    expect(merged).toMatchObject({ matched: true, finished: true });
    expect(merged.items[0]!.status).toBe("installing");
  });

  it("ignores jobs that no model is waiting for", () => {
    const merged = mergeJob(ITEMS, job({ id: "tagger:other", status: "failed" }));
    expect(merged).toMatchObject({ matched: false, finished: false });
    expect(merged.items).toEqual(ITEMS);
  });

  it("knows which job states are terminal", () => {
    expect(["succeeded", "failed", "cancelled"].every((status) => isTerminalJob({ status: status as Job["status"] }))).toBe(true);
    expect(isTerminalJob({ status: "queued" })).toBe(false);
  });

  it("computes a bounded progress ratio", () => {
    expect(progressRatio(null)).toBeNull();
    expect(progressRatio({ current: 3, total: 0 })).toBeNull();
    expect(progressRatio({ current: 1, total: 4 })).toBe(0.25);
    expect(progressRatio({ current: 9, total: 4 })).toBe(1);
  });

  it("detects any running install", () => {
    expect(anyInstalling(ITEMS)).toBe(false);
    expect(anyInstalling([...ITEMS, model("x", { status: "installing" })])).toBe(true);
  });

  it("maps statuses to status-dot tones", () => {
    expect(
      (["installed", "failed", "installing", "needs_license", "missing", "disabled"] as const).map(statusTone),
    ).toEqual(["ok", "error", "warning", "warning", "disabled", "disabled"]);
  });

  it("formats sizes in binary units", () => {
    expect(formatBytes(null, "zh-CN")).toBeNull();
    expect(formatBytes(-1, "zh-CN")).toBeNull();
    expect(formatBytes(512, "zh-CN")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(350 * 1024 * 1024, "en")).toBe("350 MB");
    expect(formatBytes(2.25 * 1024 ** 3, "en")).toBe("2.3 GB");
  });
});
