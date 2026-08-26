import { describe, expect, it } from "vitest";

import * as exportModel from "../src/apps/export/model";
import * as galleryModel from "../src/apps/gallery/model";

// G0 red-first 目标合同（docs/图库(含导出).md §3.3/§3.9/§9.1/§9.4）。
// 在 G2/G6 实现落地前，本文件应保持失败；失败原因必须只是“实现尚未存在”。
// 通过命名空间 + 运行时 typeof 守卫表达合同，避免 red 期间破坏 `npm run check`。

type UnknownModule = Record<string, unknown>;
const g = galleryModel as unknown as UnknownModule;
const e = exportModel as unknown as UnknownModule;

function requiredFn(module: UnknownModule, name: string): (...args: unknown[]) => unknown {
  const value = module[name];
  expect(typeof value, `${name} 尚未实现（图库目标合同 G2/G6）`).toBe("function");
  return value as (...args: unknown[]) => unknown;
}

describe("G0 gallery target contract (red until G2)", () => {
  it("exposes the target sanitizer and ordering API", () => {
    for (const name of [
      "sanitizeGallerySourceSummary",
      "sanitizeGalleryDirectoryEntry",
      "sanitizeGalleryAssetEntry",
      "galleryNaturalCompare",
    ]) {
      expect(typeof g[name], `${name} 尚未实现`).toBe("function");
    }
  });

  it("accepts only objective source kinds and availabilities", () => {
    const sanitize = requiredFn(g, "sanitizeGallerySourceSummary");
    const valid = sanitize({
      source_id: "src-1",
      kind: "imported",
      display_name: "导入目录",
      availability: "available",
      asset_count: 3,
    });
    expect(valid).toMatchObject({ source_id: "src-1", kind: "imported" });
    for (const kind of ["batch", "external", 1, null]) {
      expect(() =>
        sanitize({ source_id: "src-1", kind, display_name: "x", availability: "available" }),
      ).toThrow();
    }
    for (const availability of ["missing", "busy", true]) {
      expect(() =>
        sanitize({ source_id: "src-1", kind: "crawl_batch", display_name: "x", availability }),
      ).toThrow();
    }
  });

  it("accepts only objective txt states and never invented quality labels", () => {
    const sanitize = requiredFn(g, "sanitizeGalleryAssetEntry");
    const base = {
      asset_id: "asset-1",
      name: "2.jpg",
      relative_path: "sub/2.jpg",
      txt_state: "normal",
      dedup_visibility: "candidate",
    };
    expect(sanitize(base)).toMatchObject({ asset_id: "asset-1", txt_state: "normal" });
    for (const txt_state of [
      "approved",
      "needs_review",
      "pending",
      "unknown",
      1,
      null,
    ]) {
      expect(() => sanitize({ ...base, txt_state })).toThrow();
    }
  });

  it("rejects absolute paths, raw errors and injected keys in entries", () => {
    const sanitize = requiredFn(g, "sanitizeGalleryAssetEntry");
    const base = {
      asset_id: "asset-1",
      name: "2.jpg",
      relative_path: "sub/2.jpg",
      txt_state: "normal",
      dedup_visibility: "candidate",
    };
    for (const relative_path of ["/abs/2.jpg", "C:\\abs\\2.jpg", "../escape.jpg"]) {
      expect(() => sanitize({ ...base, relative_path })).toThrow();
    }
    expect(() => sanitize({ ...base, error: "OSError: /home/user/..." })).toThrow();
    expect(() => sanitize({ ...base, root_path: "/home/user/gallery" })).toThrow();
    const malicious: Record<string, unknown> = { ...base };
    Object.defineProperty(malicious, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    expect(() => sanitize(malicious)).toThrow();
  });

  it("orders names naturally so 2.jpg precedes 10.jpg", () => {
    const compare = requiredFn(g, "galleryNaturalCompare") as unknown as (
      left: string,
      right: string,
    ) => number;
    const names = ["10.jpg", "2.jpg", "1.jpg", "20.jpg", "3.jpg"];
    expect([...names].sort(compare)).toEqual(["1.jpg", "2.jpg", "3.jpg", "10.jpg", "20.jpg"]);
    expect([...["IMG10.png", "img2.png", "IMG1.PNG"]].sort(compare)).toEqual([
      "IMG1.PNG",
      "img2.png",
      "IMG10.png",
    ]);
  });
});

describe("G0 export target contract (red until G6)", () => {
  it("mirrors the backend export state machine", () => {
    expect(Array.isArray(e["EXPORT_JOB_STATES"]), "EXPORT_JOB_STATES 尚未实现").toBe(true);
    const states = e["EXPORT_JOB_STATES"] as readonly string[];
    for (const state of [
      "draft",
      "preflighting",
      "blocked",
      "ready",
      "staging",
      "paused",
      "failed",
      "staged",
      "committing",
      "completed",
      "discarded",
      "recovery_required",
    ]) {
      expect(states, `缺少导出状态 ${state}`).toContain(state);
    }
    const terminal = e["EXPORT_TERMINAL_STATES"];
    expect(Array.isArray(terminal), "EXPORT_TERMINAL_STATES 尚未实现").toBe(true);
    expect([...(terminal as readonly string[])]).toEqual(
      expect.arrayContaining(["completed", "discarded"]),
    );
  });

  it("sanitizes job summaries to authoritative counters only", () => {
    const sanitize = requiredFn(e, "sanitizeExportJobSummary");
    const valid = sanitize({
      export_id: "exp-1",
      status: "staging",
      sample_count: 10,
      staged_sample_count: 4,
      committed_sample_count: 0,
      image_bytes: 100,
      txt_bytes: 20,
    });
    expect(valid).toMatchObject({ export_id: "exp-1", status: "staging" });
    for (const status of ["running", "done", "cancelled", 1, null]) {
      expect(() =>
        sanitize({ export_id: "exp-1", status, sample_count: 1 }),
      ).toThrow();
    }
    // 模拟进度是被禁止的：前端只消费后端权威计数。
    expect(() =>
      sanitize({ export_id: "exp-1", status: "staging", progress_percent: 42 }),
    ).toThrow();
  });

  it("sanitizes blockers to fixed error classes without raw exceptions", () => {
    const sanitize = requiredFn(e, "sanitizeExportBlocker");
    const valid = sanitize({ code: "txt_missing", count: 3 });
    expect(valid).toMatchObject({ code: "txt_missing", count: 3 });
    expect(() => sanitize({ code: "txt_missing", count: 3, detail: "OSError(28, ...)" })).toThrow();
    expect(() => sanitize({ code: "unknown_code", count: 1 })).toThrow();
    expect(() => sanitize({ code: "txt_missing", count: -1 })).toThrow();
  });
});
