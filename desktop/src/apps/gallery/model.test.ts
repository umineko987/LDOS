import { describe, expect, it } from "vitest";

import {
  GALLERY_PREVIEW_DEFAULTS,
  galleryNaturalCompare,
  galleryPreviewPresentation,
  sanitizeGalleryAssetEntry,
  sanitizeGalleryDirectoryEntry,
  sanitizeGalleryPreviewState,
  sanitizeGallerySourceSummary,
  updateGalleryPreviewState,
} from "./model";

describe("gallery preview model", () => {
  it("projects only the explicit unavailable preview state", () => {
    const state = sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS });
    expect(state).toEqual(GALLERY_PREVIEW_DEFAULTS);
    expect(Object.isFrozen(state)).toBe(true);
    expect(updateGalleryPreviewState(state, { collection: "favorites", query: "portrait", sort: "site", mode: "list", inspectorOpen: false })).toEqual({
      phase: "unavailable",
      collection: "favorites",
      query: "portrait",
      sort: "site",
      mode: "list",
      inspectorOpen: false,
    });
    expect(galleryPreviewPresentation()).toEqual(expect.objectContaining({ kind: "disabled", label: "后端能力尚未接入" }));
  });

  it("rejects fabricated content states, extra keys, controls and accessors", () => {
    expect(() => sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS, phase: "content" })).toThrow(TypeError);
    expect(() => sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS, items: ["fake"] })).toThrow(TypeError);
    expect(() => updateGalleryPreviewState(GALLERY_PREVIEW_DEFAULTS, { query: "line\nfeed" })).toThrow(TypeError);
    let reads = 0;
    const raw = Object.defineProperty({ ...GALLERY_PREVIEW_DEFAULTS }, "query", { enumerable: true, get: () => { reads += 1; return "unsafe"; } });
    expect(() => sanitizeGalleryPreviewState(raw)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});

describe("gallery target model (G2 安全投影消费)", () => {
  const backendSource = {
    source_id: "src-1",
    root_directory_id: "dir-root-1",
    kind: "crawl_batch",
    batch_id: "batch-9",
    display_name: "Danbooru 批次",
    availability: "available",
    asset_count: 128,
    crawl_complete: true,
    dedup_required: true,
    dedup_state: "pending_analysis",
    content_version: 3,
    annotation_version: 5,
    indexed_version: 2,
    last_scanned_at: 1770000000.5,
    created_at: 1770000001.5,
    updated_at: 1770000002.5,
  };

  it("round-trips a full backend source projection and freezes it", () => {
    const source = sanitizeGallerySourceSummary(backendSource);
    expect(source).toEqual(backendSource);
    expect(Object.isFrozen(source)).toBe(true);
  });

  it("applies objective defaults for minimal source summaries", () => {
    const source = sanitizeGallerySourceSummary({
      source_id: "src-2",
      kind: "imported",
      display_name: "导入",
      availability: "offline",
    });
    expect(source).toMatchObject({
      batch_id: null,
      asset_count: 0,
      crawl_complete: false,
      dedup_required: false,
      dedup_state: "not_required",
      content_version: 1,
      indexed_version: 1,
      last_scanned_at: null,
    });
  });

  it("rejects source drift: root_path, invented states, bad counters", () => {
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, root_path: "/data" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, error: "OSError" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, dedup_state: "applied" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, asset_count: -1 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, asset_count: 1.5 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, crawl_complete: 1 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, display_name: "a\u0000b" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, indexed_version: 0 })).toThrow(TypeError);
  });

  it("sanitizes directory entries including the empty root path", () => {
    const directory = sanitizeGalleryDirectoryEntry({
      directory_id: "dir-1",
      source_id: "src-1",
      parent_id: null,
      relative_path: "",
      name: "",
      direct_directory_count: 2,
      direct_asset_count: 3,
      recursive_asset_count: 40,
      cover_asset_ids: ["a-1", "a-2"],
      indexed_version: 4,
    });
    expect(directory.relative_path).toBe("");
    expect(directory.cover_asset_ids).toEqual(["a-1", "a-2"]);
    expect(Object.isFrozen(directory)).toBe(true);

    const minimal = sanitizeGalleryDirectoryEntry({
      directory_id: "dir-2",
      source_id: "src-1",
      name: "sub",
      relative_path: "sub",
    });
    expect(minimal).toMatchObject({ parent_id: null, direct_directory_count: 0, cover_asset_ids: [] });

    expect(() => sanitizeGalleryDirectoryEntry({ ...minimal, relative_path: "sub/.." })).toThrow(TypeError);
    expect(() => sanitizeGalleryDirectoryEntry({ ...minimal, cover_asset_ids: Array.from({ length: 10 }, (_, i) => `a-${i}`) })).toThrow(TypeError);
    expect(() => sanitizeGalleryDirectoryEntry({ ...minimal, cover_asset_ids: [42] })).toThrow(TypeError);
    expect(() => sanitizeGalleryDirectoryEntry({ ...minimal, direct_asset_count: -2 })).toThrow(TypeError);
  });

  it("sanitizes asset entries with objective defaults and strict paths", () => {
    const backendAsset = {
      asset_id: "a-1",
      source_id: "src-1",
      directory_id: "dir-1",
      relative_path: "sub/2.jpg",
      name: "2.jpg",
      extension: ".jpg",
      size_bytes: 1024,
      modified_ns: 1770000000000000000,
      content_sha256: "ab12",
      content_version: 2,
      format: "JPEG",
      width: 640,
      height: 480,
      read_state: "ok",
      error_code: "",
      txt_relative_path: "sub/2.txt",
      txt_size_bytes: 12,
      txt_modified_ns: 1770000000000000001,
      txt_version: 1,
      txt_state: "normal",
      dedup_visibility: "kept",
      lifecycle_state: "active",
      updated_at: 1770000003.5,
    };
    expect(sanitizeGalleryAssetEntry(backendAsset)).toEqual(backendAsset);

    const minimal = sanitizeGalleryAssetEntry({
      asset_id: "a-2",
      name: "3.png",
      relative_path: "3.png",
      txt_state: "missing",
    });
    expect(minimal).toMatchObject({
      source_id: null,
      directory_id: null,
      extension: "",
      read_state: "pending",
      error_code: "",
      txt_relative_path: null,
      txt_state: "missing",
      dedup_visibility: "candidate",
      lifecycle_state: "active",
    });
    expect(Object.isFrozen(minimal)).toBe(true);

    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, error_code: "OSError: boom" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, read_state: "broken" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, relative_path: "sub//2.jpg" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, relative_path: "sub/2.jpg/" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, name: "a/b.jpg" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, width: -1 })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, txt_state: "approved" })).toThrow(TypeError);
    expect(() => sanitizeGalleryAssetEntry({ ...backendAsset, txt_relative_path: 12 })).toThrow(TypeError);

    const malicious: Record<string, unknown> = { ...backendAsset };
    Object.defineProperty(malicious, "__proto__", { enumerable: true, value: { polluted: true } });
    expect(() => sanitizeGalleryAssetEntry(malicious)).toThrow(TypeError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("compares names naturally, case-insensitively and deterministically", () => {
    expect(galleryNaturalCompare("2.jpg", "10.jpg")).toBeLessThan(0);
    expect(galleryNaturalCompare("img2.png", "IMG10.png")).toBeLessThan(0);
    expect(galleryNaturalCompare("a2b10", "a2b9")).toBeGreaterThan(0);
    // 折叠并列时以原始串代码单元序做确定性 tie-break（大写在前，与后端 sort_key 并列时行为一致）
    expect(galleryNaturalCompare("IMG1.png", "img1.png")).toBeLessThan(0);
    expect(galleryNaturalCompare("same.jpg", "same.jpg")).toBe(0);
    expect(() => galleryNaturalCompare("a", 2 as unknown as string)).toThrow(TypeError);
  });
});
