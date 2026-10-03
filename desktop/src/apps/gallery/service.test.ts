import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { sanitizeFilterConfig, EMPTY_FILTER_OPTIONS, type FilterConfig } from "../filter-presets/model";
import { createGalleryService, GALLERY_ENDPOINTS, searchAssetsPath } from "./service";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    isTauri: vi.fn(() => false),
    convertFileSrc: vi.fn((filePath: string) => `asset://localhost/${encodeURIComponent(filePath)}`),
  };
});

function operation(state: "copying" | "completed" | "failed" | "cancelled" = "copying") {
  return {
    operation_id: "gallery-directory-export-1",
    state,
    current_directory_name: state === "copying" ? "alpha" : null,
    directory_count: 2,
    completed_directory_count: state === "copying" ? 0 : 2,
    failed_directory_count: 0,
    discovered_file_count: 3,
    copied_file_count: state === "copying" ? 1 : 3,
    discovered_byte_count: 30,
    copied_byte_count: state === "copying" ? 10 : 30,
    error_code: null,
    successful_directory_names: state === "copying" ? [] : ["alpha", "beta"],
    results: state === "copying"
      ? []
      : [
          {
            directory_name: "alpha",
            status: "completed",
            copied_file_count: 2,
            copied_byte_count: 20,
            error_code: null,
          },
          {
            directory_name: "beta",
            status: "completed",
            copied_file_count: 1,
            copied_byte_count: 10,
            error_code: null,
          },
        ],
  };
}

function api() {
  const get = vi.fn(async () => operation("completed"));
  const post = vi.fn(async () => operation());
  const remove = vi.fn(async () => operation("cancelled"));
  return {
    client: { get, post, delete: remove } as unknown as ApiClient,
    get,
    post,
    remove,
  };
}

describe("Gallery review creation service", () => {
  it("submits checked directory and asset IDs as one selection", async () => {
    const post = vi.fn(async () => ({
      response_profile: "desktop-gallery-review-operation-v1", review_id: "review-gallery", version: 1, status: "pending",
      directories: [{ directory_id: "dir-alpha", source_id: "source-one", source_display_name: "Source", relative_path: "alpha", name: "alpha" }],
      totalImageCount: 0, totalGroupCount: 0, duplicateGroupCount: 0, unreadableImageCount: 0,
      automaticGroupCount: 0, automaticRejectedImageCount: 0, selectedImageCount: 0,
      decidedGroupCount: 0, keptImageCount: 0, rejectedImageCount: 0, failedImageCount: 0, hasError: false,
    }));
    const service = createGalleryService({ post } as unknown as ApiClient);
    const signal = new AbortController().signal;
    const config = sanitizeFilterConfig({ preset_name: "Custom", options: { ...EMPTY_FILTER_OPTIONS, basic_dedup: true, similarity_groups: true, reference_asset_ids: ["reference-one"] } });
    expect(await service.createReview(["dir-alpha"], ["asset-one", "asset-two"], config, signal)).toBe("review-gallery");
    expect(post).toHaveBeenCalledWith("/api/v1/gallery/reviews", { directory_ids: ["dir-alpha"], asset_ids: ["asset-one", "asset-two"], filter_config: config }, { signal });
    expect(await service.createReview([], ["asset-one"], config, signal)).toBe("review-gallery");
    expect(post).toHaveBeenCalledTimes(2);
    for (const invalid of [[[], []], [["same", "same"], []], [[], ["../unsafe"]]] as const) {
      await expect(service.createReview(invalid[0], invalid[1], config, signal)).rejects.toThrow(TypeError);
    }
    await expect(service.createReview([], ["asset-one"], { preset_name: "Custom", options: { ...config.options, filter_sketch: "yes" } } as unknown as FilterConfig, signal)).rejects.toThrow(TypeError);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
describe("Gallery directory export service", () => {
  it("starts a bounded operation through the Gallery endpoint with one idempotency key", async () => {
    const mock = api();
    const service = createGalleryService(mock.client);

    await expect(
      service.startDirectoryExport(["dir-alpha", "dir-beta"], "/target"),
    ).resolves.toMatchObject({ state: "copying", directory_count: 2 });
    expect(mock.post).toHaveBeenCalledWith(
      GALLERY_ENDPOINTS.directoryExports,
      { directory_ids: ["dir-alpha", "dir-beta"], target_path: "/target" },
      { idempotencyKey: true },
    );
  });

  it("polls and cancels only the operation-scoped endpoints", async () => {
    const mock = api();
    const service = createGalleryService(mock.client);
    const controller = new AbortController();

    await expect(
      service.getDirectoryExport("gallery-directory-export-1", controller.signal),
    ).resolves.toMatchObject({ state: "completed" });
    expect(mock.get).toHaveBeenCalledWith(
      `${GALLERY_ENDPOINTS.directoryExports}/gallery-directory-export-1?view=desktop`,
      { signal: controller.signal },
    );

    await expect(
      service.cancelDirectoryExport("gallery-directory-export-1"),
    ).resolves.toMatchObject({ state: "cancelled" });
    expect(mock.remove).toHaveBeenLastCalledWith(
      `${GALLERY_ENDPOINTS.directoryExports}/gallery-directory-export-1`,
      { idempotencyKey: true },
    );
  });

  it("rejects duplicate selections and malformed target drafts before transport", async () => {
    const mock = api();
    const service = createGalleryService(mock.client);

    await expect(
      service.startDirectoryExport(["same", "same"], "/target"),
    ).rejects.toThrow(TypeError);
    await expect(
      service.startDirectoryExport(["dir-alpha"], "bad\npath"),
    ).rejects.toThrow(TypeError);
    expect(mock.post).not.toHaveBeenCalled();
  });
});

describe("Gallery source lifecycle service", () => {
  it("deletes a batch through the recursive-delete endpoint", async () => {
    const remove = vi.fn(async () => ({ source_id: "batch-source", removed: true }));
    const service = createGalleryService({ delete: remove } as unknown as ApiClient);

    await expect(service.deleteBatchSource("batch-source")).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(
      "/api/v1/gallery/sources/batch-source?delete_files=true",
      { idempotencyKey: true },
    );
  });
});

describe("Gallery file operation service", () => {
  const operationProjection = {
    operation_id: "operation-1",
    kind: "trash",
    status: "committed",
    item_count: 1,
    has_txt_count: 0,
  };

  it("accepts the bounded operation and purge-all response projections", async () => {
    const post = vi.fn(async () => operationProjection);
    const remove = vi.fn(async () => ({ purged_operations: 2, purged_items: 3 }));
    const service = createGalleryService({ post, delete: remove } as unknown as ApiClient);

    await expect(service.trashAssets(["asset-1"])).resolves.toEqual(operationProjection);
    await expect(service.purgeAllTrash()).resolves.toEqual({
      purged_operations: 2,
      purged_items: 3,
    });
    expect(remove).toHaveBeenCalledWith(GALLERY_ENDPOINTS.trash);
  });
  it("posts complete directory selections alongside optional asset selections", async () => {
    const post = vi.fn(async () => operationProjection);
    const service = createGalleryService({ post } as unknown as ApiClient);

    await expect(service.trashAssets([], ["directory-sub"])).resolves.toEqual(
      operationProjection,
    );
    expect(post).toHaveBeenCalledWith(
      `${GALLERY_ENDPOINTS.fileOperations}/trash`,
      { asset_ids: [], directory_ids: ["directory-sub"] },
    );
  });


  it("loads the bounded trash projection with the desktop view", async () => {
    const page = {
      operations: [
        {
          operation_id: "trash-1",
          created_at: 1_700_000_000_000,
          item_count: 1,
          has_txt_count: 0,
          item_error_count: 0,
          disk_usage_bytes: 1024,
        },
      ],
      next_cursor: null,
    };
    const get = vi.fn(async () => page);
    const service = createGalleryService({ get } as unknown as ApiClient);
    const controller = new AbortController();

    await expect(service.listTrash(null, controller.signal)).resolves.toEqual(page);
    expect(get).toHaveBeenCalledWith(`${GALLERY_ENDPOINTS.trash}?view=desktop`, {
      signal: controller.signal,
    });
  });

  it("rejects internal backend fields leaked by a mutation response", async () => {
    const post = vi.fn(async () => ({
      ...operationProjection,
      source_ids: ["source-1"],
    }));
    const service = createGalleryService({ post } as unknown as ApiClient);

    await expect(service.trashAssets(["asset-1"])).rejects.toThrow(TypeError);
  });
});

describe("Gallery search service", () => {
  it("builds bounded scope-aware search paths", () => {
    expect(
      searchAssetsPath({
        query: "  red hat ",
        scope: "directory",
        sourceId: null,
        directoryId: "dir-root",
        includeDescendants: true,
        txtState: "missing",
        assetCursor: "cursor/1",
      }),
    ).toBe(
      "/api/v1/gallery/search?view=desktop&scope=directory&query=red%20hat&directory_id=dir-root&include_descendants=true&txt_state=missing&asset_cursor=cursor%2F1",
    );
    expect(() => searchAssetsPath({
      query: "hat",
      scope: "directory",
      sourceId: null,
      directoryId: null,
      includeDescendants: false,
      txtState: null,
      assetCursor: null,
    })).toThrow("gallery_search_directory_required");
    expect(() => searchAssetsPath({
      query: " ",
      scope: "library",
      sourceId: null,
      directoryId: null,
      includeDescendants: false,
      txtState: null,
      assetCursor: null,
    })).toThrow("invalid_gallery_search_query");
  });

  it("sanitizes the search page before exposing it", async () => {
    const page = {
      scope: "library",
      assets: [{
        asset_id: "asset-1",
        name: "1.jpg",
        relative_path: "1.jpg",
        txt_state: "normal",
      }],
      asset_cursor: null,
      limit: 200,
    };
    const get = vi.fn(async () => page);
    const service = createGalleryService({ get } as unknown as ApiClient);
    const abort = new AbortController();

    await expect(service.searchAssets({
      query: "image",
      scope: "library",
      sourceId: null,
      directoryId: null,
      includeDescendants: false,
      txtState: null,
      assetCursor: null,
    }, abort.signal)).resolves.toMatchObject({ scope: "library", assets: [{ asset_id: "asset-1" }] });
    expect(get).toHaveBeenCalledWith(
      "/api/v1/gallery/search?view=desktop&scope=library&query=image",
      { signal: abort.signal },
    );
  });
});

describe("Gallery source lifecycle service", () => {
  const sourceProjection = {
    source_id: "source-1",
    root_directory_id: "dir-root",
    kind: "imported",
    batch_id: null,
    display_name: "素材",
    availability: "available",
    asset_count: 0,
    candidate_count: 0,
    kept_count: 0,
    removed_count: 0,
    crawl_complete: true,
    dedup_required: false,
    dedup_state: "not_required",
    dedup_applied_version: 0,
    reconciliation_state: "none",
    reconciliation_error_code: "",
    reconciliation_attempt_count: 0,
    reconciliation_updated_at: null,
    content_version: 1,
    annotation_version: 1,
    indexed_version: 1,
    last_scanned_at: null,
    created_at: 1,
    updated_at: 1,
  };
  const scanProjection = {
    operation_id: "scan-1",
    source_id: "source-1",
    state: "running",
    started_at: 2,
    finished_at: null,
    error_code: "",
    stats: null,
  };

  it("renames, relinks and unmounts through source-scoped endpoints", async () => {
    const request = vi.fn(async () => sourceProjection);
    const post = vi.fn(async () => sourceProjection);
    const remove = vi.fn(async () => ({ source_id: "source-1", removed: true }));
    const service = createGalleryService({ request, post, delete: remove } as unknown as ApiClient);

    await expect(service.renameSource("source-1", " 新名称 ")).resolves.toMatchObject({ display_name: "素材" });
    expect(request).toHaveBeenCalledWith("/api/v1/gallery/sources/source-1", "PATCH", {
      body: { display_name: "新名称" },
    });
    await service.relinkSource("source-1", "/new/root");
    expect(post).toHaveBeenCalledWith(
      "/api/v1/gallery/sources/source-1/relink",
      { root_path: "/new/root" },
      { idempotencyKey: true },
    );
    await service.unmountSource("source-1");
    expect(remove).toHaveBeenCalledWith("/api/v1/gallery/sources/source-1");
  });

  it("starts and polls bounded scans and retries reconciliation", async () => {
    const post = vi.fn(async (path: string) =>
      path.endsWith("/scan") ? scanProjection : sourceProjection,
    );
    const get = vi.fn(async () => scanProjection);
    const service = createGalleryService({ post, get } as unknown as ApiClient);
    const abort = new AbortController();

    await expect(service.startSourceScan("source-1")).resolves.toMatchObject({ state: "running" });
    expect(post).toHaveBeenCalledWith("/api/v1/gallery/sources/source-1/scan");
    await expect(service.getSourceScan("source-1", abort.signal)).resolves.toMatchObject({ operation_id: "scan-1" });
    expect(get).toHaveBeenCalledWith("/api/v1/gallery/sources/source-1/scan?view=desktop", { signal: abort.signal });
    await service.retrySourceReconciliation("source-1");
    expect(post).toHaveBeenLastCalledWith(
      "/api/v1/gallery/sources/source-1/reconciliation/retry",
      undefined,
      { idempotencyKey: true },
    );
  });

  it("rejects malformed lifecycle drafts before transport", async () => {
    const request = vi.fn();
    const post = vi.fn();
    const service = createGalleryService({ request, post } as unknown as ApiClient);
    await expect(service.renameSource("source-1", "\n")).rejects.toThrow(TypeError);
    await expect(service.relinkSource("source-1", "bad\npath")).rejects.toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("gallery asset content url", () => {
  const asset = {
    asset_id: "asset-1",
    source_id: "source-1",
    relative_path: "sub/1.jpg",
  };

  function pageService() {
    const page = {
      directory: {
        directory_id: "dir-1",
        source_id: "source-1",
        parent_id: null,
        relative_path: "",
        name: "root",
        direct_directory_count: 0,
        direct_asset_count: 1,
        recursive_asset_count: 1,
        cover_asset_ids: ["asset-1"],
        indexed_version: 1,
      },
      directories: [],
      assets: [],
      directory_cursor: null,
      asset_cursor: null,
      include_descendants: false,
      limit: 200,
      source_roots: { "source-1": "/tmp/ldos-source" },
    };
    const get = vi.fn(async () => page);
    return createGalleryService({ get, resourceUrl: (path: string) => `http://backend${path}` } as unknown as ApiClient);
  }

  it("falls back to the HTTP content route outside Tauri", async () => {
    const service = pageService();
    await service.listDirectoryEntries({
      directoryId: "dir-1",
      includeDescendants: false,
      txtState: null,
      query: "",
      directoryCursor: null,
      assetCursor: null,
    }, new AbortController().signal);
    expect(service.assetContentUrl(asset)).toBe(
      "http://backend/api/v1/gallery/assets/asset-1/content",
    );
  });

  it("uses the asset protocol once the source root is known in Tauri", async () => {
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.isTauri).mockReturnValue(true);
    try {
      const service = pageService();
      await service.listDirectoryEntries({
        directoryId: "dir-1",
        includeDescendants: false,
        txtState: null,
        query: "",
        directoryCursor: null,
        assetCursor: null,
      }, new AbortController().signal);
      expect(service.assetContentUrl(asset)).toBe(
        `asset://localhost/${encodeURIComponent("/tmp/ldos-source/sub/1.jpg")}`,
      );
      expect(core.convertFileSrc).toHaveBeenCalledWith("/tmp/ldos-source/sub/1.jpg");
    } finally {
      vi.mocked(core.isTauri).mockReturnValue(false);
      vi.mocked(core.convertFileSrc).mockClear();
    }
  });

  it("falls back when the asset has no source root cached", () => {
    const service = createGalleryService({
      resourceUrl: (path: string) => `http://backend${path}`,
    } as unknown as ApiClient);
    expect(service.assetContentUrl({ ...asset, source_id: null })).toBe(
      "http://backend/api/v1/gallery/assets/asset-1/content",
    );
  });
});
