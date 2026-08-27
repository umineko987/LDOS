import { describe, expect, it } from "vitest";

import * as galleryModel from "../src/apps/gallery/model";

type UnknownModule = Record<string, unknown>;
const g = galleryModel as unknown as UnknownModule;

function requiredFn(module: UnknownModule, name: string): (...args: unknown[]) => unknown {
  const value = module[name];
  expect(typeof value, `${name} 尚未实现`).toBe("function");
  return value as (...args: unknown[]) => unknown;
}

describe("Gallery target contract", () => {
  it("exposes the target sanitizer and ordering API", () => {
    for (const name of [
      "sanitizeGallerySourceSummary",
      "sanitizeGalleryDirectoryEntry",
      "sanitizeGalleryAssetEntry",
      "sanitizeGalleryDirectoryExportOperation",
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
    for (const txt_state of ["approved", "needs_review", "pending", "unknown", 1, null]) {
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
    expect(["10.jpg", "2.jpg", "1.jpg", "20.jpg", "3.jpg"].sort(compare)).toEqual([
      "1.jpg",
      "2.jpg",
      "3.jpg",
      "10.jpg",
      "20.jpg",
    ]);
  });

  it("sanitizes bounded short-lived directory-export operation projections", () => {
    const sanitize = requiredFn(g, "sanitizeGalleryDirectoryExportOperation");
    const operation = sanitize({
      operation_id: "op-1",
      state: "copying",
      current_directory_name: "source",
      directory_count: 1,
      completed_directory_count: 0,
      failed_directory_count: 0,
      discovered_file_count: 3,
      copied_file_count: 1,
      discovered_byte_count: 30,
      copied_byte_count: 10,
      error_code: null,
      successful_directory_names: [],
      results: [],
    });
    expect(operation).toMatchObject({ operation_id: "op-1", state: "copying" });
    expect(() => sanitize({ ...(operation as object), target_path: "/private/output" })).toThrow();
    expect(() => sanitize({ ...(operation as object), state: "paused" })).toThrow();
  });
});
