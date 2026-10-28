import { describe, expect, it } from "vitest";

import {
  GALLERY_PREVIEW_DEFAULTS,
  GALLERY_VIEWER_MAX_SCALE,
  galleryApplyClickSelection,
  galleryClearSelection,
  galleryFitViewport,
  galleryNaturalCompare,
  galleryOneToOneViewport,
  galleryPreviewPresentation,
  gallerySelectAll,
  galleryZoomAtPointer,
  parseGalleryTxtTags,
  parseGalleryTxtTagView,
  sanitizeGalleryAnnotation,
  sanitizeGalleryDirectoryExportOperation,
  sanitizeGalleryAssetEntry,
  sanitizeGalleryDirectoryEntry,
  sanitizeGalleryPreviewState,
  sanitizeGallerySourceSummary,
  sanitizeGalleryScanOperation,
  sanitizeGalleryTrashPage,
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
    candidate_count: 128,
    kept_count: 0,
    removed_count: 0,
    crawl_complete: true,
    dedup_required: true,
    dedup_state: "pending_analysis",
    dedup_applied_version: 0,
    reconciliation_state: "none",
    reconciliation_error_code: "",
    reconciliation_attempt_count: 0,
    reconciliation_updated_at: null,
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
      candidate_count: 0,
      kept_count: 0,
      removed_count: 0,
      crawl_complete: false,
      dedup_required: false,
      dedup_state: "not_required",
      reconciliation_state: "none",
      reconciliation_error_code: "",
      reconciliation_attempt_count: 0,
      content_version: 1,
      indexed_version: 0,
      last_scanned_at: null,
    });
  });

  it("rejects source drift: root_path, invented states, bad counters", () => {
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, root_path: "/data" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, error: "OSError" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, dedup_state: "invented_state" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, asset_count: -1 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, asset_count: 1.5 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, candidate_count: 129 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, reconciliation_state: "failed" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, reconciliation_error_code: "review_reconciliation_apply_failed" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, crawl_complete: 1 })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, display_name: "a\u0000b" })).toThrow(TypeError);
    expect(() => sanitizeGallerySourceSummary({ ...backendSource, indexed_version: -1 })).toThrow(TypeError);
  });

  it("sanitizes bounded scan progress and rejects lifecycle drift", () => {
    const operation = sanitizeGalleryScanOperation({
      operation_id: "scan-1",
      source_id: "src-1",
      state: "succeeded",
      started_at: 1770000000,
      finished_at: 1770000001,
      error_code: "",
      stats: {
        asset_count: 12,
        candidate_count: 8,
        kept_count: 4,
        removed_count: 3,
        directory_count: 2,
        content_changed: true,
        annotation_changed: false,
        indexed_version: 7,
        offline: false,
        skipped_temporary: 1,
        skipped_unsupported: 5,
      },
    });
    expect(operation.stats).toMatchObject({ asset_count: 12, candidate_count: 8, kept_count: 4 });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.stats)).toBe(true);
    expect(() => sanitizeGalleryScanOperation({ ...operation, state: "failed" })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({ ...operation, debug_path: "/secret" })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({ ...operation, stats: { ...operation.stats, candidate_count: 13 } })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({ ...operation, state: "running" })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({ ...operation, stats: null })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({ ...operation, finished_at: 1769999999 })).toThrow(TypeError);
    expect(() => sanitizeGalleryScanOperation({
      ...operation,
      state: "failed",
      error_code: "scan_failed",
      stats: null,
    })).not.toThrow();
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

describe("gallery viewer geometry (G2-3 查看器几何)", () => {
  const canvas = { width: 800, height: 600 };
  const image = { width: 4000, height: 2000 };

  it("fits the image inside the canvas and centers it", () => {
    const fit = galleryFitViewport({ canvas, image });
    expect(fit.scale).toBeCloseTo(0.2);
    expect(fit.offsetX).toBeCloseTo(0);
    expect(fit.offsetY).toBeCloseTo(100);
  });

  it("rejects degenerate inputs", () => {
    expect(() => galleryFitViewport({ canvas: { width: 0, height: 600 }, image })).toThrow(TypeError);
    expect(() => galleryFitViewport({ canvas, image: { width: -1, height: 1 } })).toThrow(TypeError);
  });

  it("keeps the pointer-anchored content point fixed while zooming", () => {
    const fit = galleryFitViewport({ canvas, image });
    // 指针在画布 (400, 200)；放大 2 倍后，同一内容点仍应位于指针下。
    const zoomed = galleryZoomAtPointer({
      canvas,
      image,
      viewport: fit,
      pointerX: 400,
      pointerY: 200,
      factor: 2,
    });
    expect(zoomed.scale).toBeCloseTo(fit.scale * 2);
    // 反推内容坐标验证不动点。
    const contentBefore = (400 - fit.offsetX) / fit.scale;
    const contentAfter = (400 - zoomed.offsetX) / zoomed.scale;
    expect(contentAfter).toBeCloseTo(contentBefore);
  });

  it("clamps panning so edges stay within the canvas", () => {
    const fit = galleryFitViewport({ canvas, image });
    const panned = galleryZoomAtPointer({
      canvas,
      image,
      viewport: fit,
      pointerX: 400,
      pointerY: 300,
      factor: 4,
    });
    // 放大到内容超出画布后，向任意方向拖出的偏移都被钳制。
    expect(panned.offsetX).toBeLessThanOrEqual(0);
    expect(panned.offsetX).toBeGreaterThanOrEqual(canvas.width - image.width * panned.scale);
    expect(panned.offsetY).toBeLessThanOrEqual(0);
    expect(panned.offsetY).toBeGreaterThanOrEqual(canvas.height - image.height * panned.scale);
  });

  it("clamps scale to the bounded range", () => {
    const fit = galleryFitViewport({ canvas, image: { width: 10, height: 10 } });
    const zoomed = galleryZoomAtPointer({
      canvas,
      image: { width: 10, height: 10 },
      viewport: fit,
      pointerX: 100,
      pointerY: 100,
      factor: 100,
    });
    expect(zoomed.scale).toBeLessThanOrEqual(GALLERY_VIEWER_MAX_SCALE);
  });

  it("centers 1:1 view and keeps it usable", () => {
    const one = galleryOneToOneViewport({ canvas: { width: 300, height: 200 }, image: { width: 600, height: 100 } });
    expect(one.scale).toBe(1);
    // 内容超出画布：钳制到左/右边缘内。
    expect(one.offsetX).toBeLessThanOrEqual(0);
    expect(one.offsetX).toBeGreaterThanOrEqual(300 - 600);
    // 垂直居中。
    expect(one.offsetY).toBeCloseTo(50);
  });
});

describe("gallery TXT tags (G2-3 标签视图)", () => {
  it("parses comma-separated tags without rewriting the raw text", () => {
    expect(parseGalleryTxtTags("red, blue ,red, green")).toEqual(["red", "blue", "green"]);
    expect(parseGalleryTxtTags("  ")).toEqual([]);
    expect(parseGalleryTxtTags(null)).toEqual([]);
    expect(parseGalleryTxtTags("single")).toEqual(["single"]);
  });

  it("keeps tag ordering and reports non-destructive warnings", () => {
    const parsed = parseGalleryTxtTagView(" red,blue, red, , blue ");
    expect(parsed.tags.map((tag) => tag.value)).toEqual(["red", "blue", "red", "", "blue"]);
    expect(parsed.tags.map((tag) => tag.duplicate)).toEqual([false, false, true, false, true]);
    expect(parsed).toMatchObject({ duplicate_count: 2, empty_count: 1, whitespace_count: 4 });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.tags)).toBe(true);
    expect(parseGalleryTxtTagView(null).tags).toEqual([]);
  });

  it("sanitizes annotation payloads strictly", () => {
    const clean = sanitizeGalleryAnnotation({
      asset_id: "a1",
      txt_state: "normal",
      content: "hello",
      txt_version: 3,
      disk_version: "opaque-disk-version",
    });
    expect(clean.content).toBe("hello");
    expect(Object.isFrozen(clean)).toBe(true);

    expect(() => sanitizeGalleryAnnotation({ asset_id: "a1", txt_state: "approved" })).toThrow(TypeError);
    expect(() =>
      sanitizeGalleryAnnotation({
        asset_id: "a1",
        txt_state: "normal",
        content: null,
        txt_version: 0,
        disk_version: "opaque-disk-version",
        __proto__: null,
      }),
    ).not.toThrow();
  });
});

describe("gallery grid selection (G2-3 多选)", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("replaces selection on plain click and moves the anchor", () => {
    const patch = galleryApplyClickSelection({
      total: 5,
      anchorIndex: null,
      selectedIds: ["a"],
      clickedIndex: 2,
      clickedId: "c",
      additive: false,
      range: false,
      ids,
    });
    expect(patch.selectedIds).toEqual(["c"]);
    expect(patch.anchorIndex).toBe(2);
  });

  it("toggles membership on Ctrl/Cmd+click", () => {
    const patch = galleryApplyClickSelection({
      total: 5,
      anchorIndex: 0,
      selectedIds: ["a", "b"],
      clickedIndex: 1,
      clickedId: "b",
      additive: true,
      range: false,
      ids,
    });
    expect(patch.selectedIds).toEqual(["a"]);
    expect(patch.anchorIndex).toBe(1);
  });

  it("selects a range on Shift+click from the anchor", () => {
    const patch = galleryApplyClickSelection({
      total: 5,
      anchorIndex: 1,
      selectedIds: ["b"],
      clickedIndex: 3,
      clickedId: "d",
      additive: false,
      range: true,
      ids,
    });
    expect(patch.selectedIds).toEqual(["b", "c", "d"]);
  });

  it("rejects invalid indices and flag combinations", () => {
    expect(() =>
      galleryApplyClickSelection({
        total: 5,
        anchorIndex: null,
        selectedIds: [],
        clickedIndex: 5,
        clickedId: "x",
        additive: false,
        range: false,
        ids,
      }),
    ).toThrow(TypeError);
    expect(() =>
      galleryApplyClickSelection({
        total: 5,
        anchorIndex: null,
        selectedIds: [],
        clickedIndex: 0,
        clickedId: "a",
        additive: true,
        range: true,
        ids,
      }),
    ).toThrow(TypeError);
  });

  it("selects all and clears with fixed anchors", () => {
    expect(gallerySelectAll(ids).selectedIds).toEqual(ids);
    expect(gallerySelectAll([]).anchorIndex).toBeNull();
    expect(galleryClearSelection().selectedIds).toEqual([]);
  });
});

describe("gallery directory export projection", () => {
  const operation = {
    operation_id: "gallery-directory-export-1",
    state: "copying",
    current_directory_name: "alpha",
    directory_count: 2,
    completed_directory_count: 1,
    failed_directory_count: 0,
    discovered_file_count: 3,
    copied_file_count: 2,
    discovered_byte_count: 30,
    copied_byte_count: 20,
    error_code: null,
    successful_directory_names: ["beta"],
    results: [
      {
        directory_name: "beta",
        status: "completed",
        copied_file_count: 2,
        copied_byte_count: 20,
        error_code: null,
      },
    ],
  };

  it("accepts and freezes the bounded in-memory operation projection", () => {
    const projected = sanitizeGalleryDirectoryExportOperation(operation);
    expect(projected).toEqual(operation);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.results)).toBe(true);
    expect(Object.isFrozen(projected.results[0])).toBe(true);
  });

  it("rejects unknown fields, impossible counters and invented states", () => {
    expect(() =>
      sanitizeGalleryDirectoryExportOperation({ ...operation, target_path: "/private/output" }),
    ).toThrow(TypeError);
    expect(() =>
      sanitizeGalleryDirectoryExportOperation({
        ...operation,
        completed_directory_count: 2,
        failed_directory_count: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      sanitizeGalleryDirectoryExportOperation({ ...operation, state: "paused" }),
    ).toThrow(TypeError);
  });
});

describe("gallery trash projection", () => {
  const page = {
    operations: [
      {
        operation_id: "trash-1",
        created_at: 1_700_000_000_000,
        item_count: 1,
        has_txt_count: 1,
        item_error_count: 0,
        disk_usage_bytes: 4096,
      },
    ],
    next_cursor: null,
  };

  it("accepts backend epoch timestamps and freezes the public projection", () => {
    const projected = sanitizeGalleryTrashPage(page);
    expect(projected).toEqual(page);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.operations)).toBe(true);
    expect(Object.isFrozen(projected.operations[0])).toBe(true);
  });

  it("rejects leaked internal trash fields and invalid counters", () => {
    expect(() =>
      sanitizeGalleryTrashPage({
        ...page,
        operations: [{ ...page.operations[0], source_ids: ["source-1"] }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      sanitizeGalleryTrashPage({
        ...page,
        operations: [{ ...page.operations[0], item_error_count: -1 }],
      }),
    ).toThrow(TypeError);
  });
});
