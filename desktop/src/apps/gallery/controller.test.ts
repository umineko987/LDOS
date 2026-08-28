import { describe, expect, it, vi } from "vitest";

import { createGalleryController } from "./controller";
import type { GalleryDirectoryRequest, GalleryService } from "./service";
import { createGalleryStore } from "./state";
import type { GalleryAssetEntry, GalleryDirectoryEntry, GallerySourceSummary } from "./model";

const source: GallerySourceSummary = {
  source_id: "source-1",
  root_directory_id: "dir-root",
  kind: "imported",
  batch_id: null,
  display_name: "导入目录 A",
  availability: "available",
  asset_count: 1,
  crawl_complete: true,
  dedup_required: false,
  dedup_state: "not_required",
  content_version: 1,
  annotation_version: 1,
  indexed_version: 3,
  last_scanned_at: 1234,
  created_at: 1000,
} as GallerySourceSummary;

const rootDirectory: GalleryDirectoryEntry = {
  directory_id: "dir-root",
  source_id: "source-1",
  parent_id: null,
  relative_path: "",
  name: "",
  direct_directory_count: 1,
  direct_asset_count: 0,
  recursive_asset_count: 1,
  cover_asset_ids: ["asset-1"],
  indexed_version: 3,
} as GalleryDirectoryEntry;

const runningScan = {
  operation_id: "scan-1",
  source_id: "source-1",
  state: "running",
  started_at: 2000,
  finished_at: null,
  error_code: "",
  stats: null,
} as const;

const successfulScan = {
  ...runningScan,
  state: "succeeded",
  finished_at: 2001,
  stats: {
    asset_count: 1,
    candidate_count: 0,
    kept_count: 1,
    removed_count: 0,
    directory_count: 1,
    content_changed: false,
    annotation_changed: false,
    indexed_version: 3,
    offline: false,
    skipped_temporary: 0,
    skipped_unsupported: 0,
  },
} as const;

function makeService(
  overrides: Partial<Record<
    | "listSources"
    | "listDirectoryEntries"
    | "startSourceScan"
    | "searchAssets"
    | "getSourceScan"
    | "retrySourceReconciliation"
    | "renameSource"
    | "relinkSource"
    | "importSource"
    | "unmountSource"
    | "deleteBatchSource",
    ReturnType<typeof vi.fn>
  >> = {},
) {
  return {
    listSources: overrides.listSources ?? vi.fn(async () => [source]),
    listDirectoryEntries:
      overrides.listDirectoryEntries ??
      vi.fn(async () => ({
        directory: rootDirectory,
        directories: [],
        assets: [],
        directory_cursor: null,
        asset_cursor: null,
      })),
    searchAssets:
      overrides.searchAssets ??
      vi.fn(async () => ({
        scope: "library",
        assets: [],
        asset_cursor: null,
        limit: 120,
      })),
    startSourceScan:
      overrides.startSourceScan ?? vi.fn(() => new Promise(() => undefined)),
    getSourceScan:
      overrides.getSourceScan ?? vi.fn(() => new Promise(() => undefined)),
    retrySourceReconciliation:
      overrides.retrySourceReconciliation ?? vi.fn(async () => source),
    renameSource: overrides.renameSource ?? vi.fn(async () => source),
    relinkSource: overrides.relinkSource ?? vi.fn(async () => source),
    importSource: overrides.importSource ?? vi.fn(async () => source),
    unmountSource: overrides.unmountSource ?? vi.fn(async () => undefined),
    deleteBatchSource: overrides.deleteBatchSource ?? vi.fn(async () => undefined),
    thumbnailUrl: (assetId: string) => `thumb:${assetId}`,
    contentUrl: (assetId: string) => `content:${assetId}`,
  } as unknown as GalleryService;
}

describe("gallery browse controller", () => {
  it("stays inert until activated and stops after destroy", async () => {
    const store = createGalleryStore();
    const service = makeService();
    const controller = createGalleryController({ store, service });

    await expect(controller.refreshSources()).resolves.toBe(false);
    expect(service.listSources).not.toHaveBeenCalled();

    controller.activate();
    await expect(controller.refreshSources()).resolves.toBe(true);
    expect(service.listSources).toHaveBeenCalledTimes(2);
    expect(store.getState().sources).toEqual([source]);

    controller.destroy();
    await expect(controller.refreshSources()).resolves.toBe(false);
    expect(controller.setViewMode("list")).toBe(false);
  });

  it("imports referenced directories and preserves stable backend errors", async () => {
    const store = createGalleryStore();
    const importSource = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("overlap"), { code: "source_path_conflict" }))
      .mockResolvedValueOnce(source);
    const getSourceScan = vi.fn(async () => successfulScan);
    const service = makeService({ importSource, getSourceScan });
    const controller = createGalleryController({ store, service });
    controller.activate();
    await vi.waitFor(() => expect(store.getState().sourcesPhase).toBe("ready"));

    await expect(controller.importDirectory("/data/import")).resolves.toBe(false);
    expect(importSource).toHaveBeenLastCalledWith("/data/import");
    expect(store.getState().sourcesErrorCode).toBe("source_path_conflict");

    await expect(controller.importDirectory("/data/import")).resolves.toBe(true);
    expect(store.getState().sourcesErrorCode).toBeNull();
    controller.destroy();
  });

  it("selects a newly imported source and follows its backend-started scan", async () => {
    const pendingSource = {
      ...source,
      source_id: "source-2",
      root_directory_id: null,
      display_name: "新导入目录",
      asset_count: 0,
      indexed_version: 0,
      last_scanned_at: null,
    } as GallerySourceSummary;
    const readySource = {
      ...pendingSource,
      root_directory_id: "dir-imported",
      asset_count: 1,
      indexed_version: 1,
      last_scanned_at: 3000,
    } as GallerySourceSummary;
    const importedRoot = {
      ...rootDirectory,
      directory_id: "dir-imported",
      source_id: "source-2",
      indexed_version: 1,
    };
    const listSources = vi
      .fn()
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([source, pendingSource])
      .mockResolvedValue([source, readySource]);
    const startSourceScan = vi.fn().mockRejectedValue(
      Object.assign(new Error("already running"), { code: "source_scan_in_progress" }),
    );
    const getSourceScan = vi.fn(async () => ({
      ...successfulScan,
      operation_id: "scan-import",
      source_id: "source-2",
      indexed_version: 1,
    }));
    const listDirectoryEntries = vi.fn(async () => ({
      directory: importedRoot,
      directories: [],
      assets: [],
      directory_cursor: null,
      asset_cursor: null,
    }));
    const service = makeService({
      listSources,
      importSource: vi.fn(async () => pendingSource),
      startSourceScan,
      getSourceScan,
      listDirectoryEntries,
    });
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await vi.waitFor(() => expect(store.getState().sourcesPhase).toBe("ready"));

    await expect(controller.importDirectory("/data/new")).resolves.toBe(true);

    expect(startSourceScan).not.toHaveBeenCalled();
    expect(getSourceScan).toHaveBeenCalledWith("source-2", expect.any(AbortSignal));
    expect(store.getState().activeSourceId).toBe("source-2");
    expect(store.getState().rootDirectoryId).toBe("dir-imported");
    expect(listDirectoryEntries).toHaveBeenCalled();
    controller.destroy();
  });

  it("opens a source root and applies fetched pages with bounded requests", async () => {
    const store = createGalleryStore();
    const page = {
      directory: rootDirectory,
      directories: [],
      assets: [] as GalleryAssetEntry[],
      directory_cursor: null,
      asset_cursor: null,
    };
    const listDirectoryEntries = vi.fn(async (_request: GalleryDirectoryRequest) => page);
    const service = makeService({ listDirectoryEntries });
    const controller = createGalleryController({ store, service });

    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    expect(store.getState().activeSourceId).toBe("source-1");
    expect(listDirectoryEntries).toHaveBeenCalledOnce();

    const request = listDirectoryEntries.mock.calls[0][0] as GalleryDirectoryRequest;
    expect(request.directoryId).toBe("dir-root");
    expect(request.includeDescendants).toBe(false);
    expect(request.query).toBe("");

    expect(store.getState().currentDirectory?.directory_id).toBe("dir-root");
    expect(store.getState().pagePhase).toBe("ready");
  });

  it("polls a source scan and refreshes source and page projections after success", async () => {
    vi.useFakeTimers();
    try {
      const store = createGalleryStore();
      const startSourceScan = vi.fn(async () => runningScan);
      const getSourceScan = vi.fn(async () => successfulScan);
      const service = makeService({ startSourceScan, getSourceScan });
      const controller = createGalleryController({ store, service });
      store.setSources([source]);
      store.openSource(source.source_id, source.root_directory_id!);
      controller.activate();

      await expect(controller.rescanActiveSource()).resolves.toBe(true);
      expect(store.getState().scanOperation?.state).toBe("running");
      await vi.advanceTimersByTimeAsync(400);
      expect(store.getState().scanOperation?.state).toBe("succeeded");
      expect(getSourceScan).toHaveBeenCalledOnce();
      expect(service.listSources).toHaveBeenCalledOnce();
      expect(service.listDirectoryEntries).toHaveBeenCalledOnce();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries failed reconciliation and exposes source lifecycle writes through the controller", async () => {
    const failedSource = {
      ...source,
      reconciliation_state: "failed",
      reconciliation_error_code: "review_reconciliation_apply_failed",
      reconciliation_attempt_count: 1,
    } as GallerySourceSummary;
    const store = createGalleryStore();
    const retrySourceReconciliation = vi.fn(async () => ({
      ...failedSource,
      reconciliation_state: "pending",
      reconciliation_error_code: "",
    }));
    const renameSource = vi.fn(async () => ({ ...failedSource, display_name: "新名称" }));
    const relinkSource = vi.fn(async () => failedSource);
    const unmountSource = vi.fn(async () => undefined);
    const startSourceScan = vi.fn(async () => runningScan);
    const getSourceScan = vi.fn(async () => runningScan);
    const listSources = vi
      .fn()
      .mockResolvedValueOnce([failedSource])
      .mockResolvedValueOnce([{ ...failedSource, display_name: "新名称" }])
      .mockResolvedValueOnce([failedSource])
      .mockResolvedValueOnce([]);
    const service = makeService({
      retrySourceReconciliation,
      renameSource,
      relinkSource,
      unmountSource,
      startSourceScan,
      getSourceScan,
      listSources,
    });
    const controller = createGalleryController({ store, service });
    store.setSources([failedSource]);
    store.openSource(failedSource.source_id, failedSource.root_directory_id!);
    controller.activate();

    await expect(controller.retryActiveReconciliation()).resolves.toBe(true);
    expect(retrySourceReconciliation).toHaveBeenCalledWith("source-1");
    expect(store.getState().reconciliationRetrySourceId).toBeNull();
    await expect(controller.renameActiveSource("新名称")).resolves.toBe(true);
    expect(renameSource).toHaveBeenCalledWith("source-1", "新名称");
    await expect(controller.relinkActiveSource("/moved")).resolves.toBe(true);
    expect(relinkSource).toHaveBeenCalledWith("source-1", "/moved");
    expect(startSourceScan).not.toHaveBeenCalled();
    expect(getSourceScan).toHaveBeenCalledTimes(2);
    await expect(controller.unmountActiveSource()).resolves.toBe(true);
    expect(unmountSource).toHaveBeenCalledWith("source-1");
    expect(store.getState().activeSourceId).toBeNull();
    controller.destroy();
  });
  it("deletes a batch source and refreshes the source list", async () => {
    const batchSource = {
      ...source,
      source_id: "batch-source",
      kind: "crawl_batch",
      batch_id: "batch-1",
      display_name: "下载批次",
    } as GallerySourceSummary;
    const deleteBatchSource = vi.fn(async () => undefined);
    const listSources = vi.fn().mockResolvedValueOnce([batchSource]).mockResolvedValueOnce([]);
    const store = createGalleryStore();
    const service = makeService({ deleteBatchSource, listSources });
    const controller = createGalleryController({ store, service });
    controller.activate();
    await vi.waitFor(() => expect(store.getState().sourcesPhase).toBe("ready"));

    await expect(controller.deleteBatchSource("batch-source")).resolves.toBe(true);
    expect(deleteBatchSource).toHaveBeenCalledWith("batch-source");
    expect(store.getState().sources).toEqual([]);
    expect(store.getState().activeSourceId).toBeNull();
    controller.destroy();
  });



  it("records stable error codes and recovers on retry", async () => {
    const store = createGalleryStore();
    const listSources = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "network_error" }))
      .mockResolvedValueOnce([source]);
    const service = makeService({ listSources });
    const controller = createGalleryController({ store, service });

    controller.activate();
    await vi.waitFor(() => expect(store.getState().sourcesPhase).toBe("error"));
    expect(store.getState().sourcesErrorCode).toBe("network_error");

    await expect(controller.refreshSources()).resolves.toBe(true);
    expect(store.getState().sourcesPhase).toBe("ready");
    expect(store.getState().sourcesErrorCode).toBeNull();
  });

  it("normalizes queries before dispatch and keeps invalid input local", async () => {
    const store = createGalleryStore();
    const service = makeService();
    const controller = createGalleryController({ store, service });

    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    expect(controller.setViewMode("list")).toBe(true);
    expect(store.getState().viewMode).toBe("list");

    await expect(controller.submitQuery("  portrait  ")).resolves.toBe(true);
    expect(store.getState().query).toBe("portrait");

    await expect(controller.setTxtStateFilter("normal")).resolves.toBe(true);
    expect(store.getState().txtStateFilter).toBe("normal");
    await expect(controller.setIncludeDescendants(true)).resolves.toBe(true);
    expect(store.getState().includeDescendants).toBe(true);
    await expect(controller.setSearchScope("source")).resolves.toBe(true);
    expect(store.getState().searchScope).toBe("source");

    // 非法查询词被本地拒绝，不触发网络请求。
    const before = (service.listDirectoryEntries as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(controller.submitQuery("x".repeat(257))).resolves.toBe(false);
    expect((service.listDirectoryEntries as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});

describe("gallery viewer controller (G2-3 只读查看器)", () => {
  const assetA = {
    asset_id: "asset-1",
    source_id: "source-1",
    directory_id: "dir-root",
    relative_path: "a.jpg",
    name: "a.jpg",
    extension: ".jpg",
    size_bytes: 100,
    modified_ns: 1,
    content_sha256: "x",
    content_version: 1,
    format: "jpeg",
    width: 100,
    height: 50,
    read_state: "ok",
    error_code: "",
    txt_relative_path: "a.txt",
    txt_size_bytes: 10,
    txt_modified_ns: 1,
    txt_version: 1,
    txt_state: "normal",
    dedup_visibility: "candidate",
    lifecycle_state: "active",
    updated_at: 1,
  } as GalleryAssetEntry;

  const assetB = { ...assetA, asset_id: "asset-2", relative_path: "b.jpg", name: "b.jpg" } as GalleryAssetEntry;

  function makeViewerService() {
    const listDirectoryEntries = vi.fn(async () => ({
      directory: rootDirectory,
      directories: [],
      assets: [assetA, assetB],
      directory_cursor: null,
      asset_cursor: null,
    }));
    const getAnnotation = vi.fn(async (assetId: string) => ({
      asset_id: assetId,
      txt_state: "normal",
      content: `content of ${assetId}`,
      txt_version: 1,
      disk_version: "disk-version-1",
    }));
    return {
      service: {
        listSources: vi.fn(async () => [source]),
        listDirectoryEntries,
        getAnnotation,
        thumbnailUrl: (assetId: string) => `thumb:${assetId}`,
        contentUrl: (assetId: string) => `content:${assetId}`,
      } as unknown as GalleryService,
      getAnnotation,
    };
  }

  async function openReadyViewer() {
    const { service, getAnnotation } = makeViewerService();
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    return { store, controller, getAnnotation };
  }

  it("opens the viewer on a known asset and loads its annotation", async () => {
    const { store, controller, getAnnotation } = await openReadyViewer();

    expect(controller.openViewer("asset-1")).toBe(true);
    expect(store.getState().viewerIndex).toBe(0);
    expect(store.getState().viewerAssets).toHaveLength(2);
    await vi.waitFor(() => {
      expect(store.getState().viewerAnnotation?.content).toBe("content of asset-1");
    });
    expect(getAnnotation).toHaveBeenCalledWith("asset-1", expect.any(AbortSignal));
  });

  it("rejects opening unknown assets without side effects", async () => {
    const { store, controller } = await openReadyViewer();
    expect(controller.openViewer("missing")).toBe(false);
    expect(store.getState().viewerIndex).toBe(-1);
  });

  it("moves next/previous within bounds and reloads annotations", async () => {
    const { store, controller } = await openReadyViewer();
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerAnnotation).not.toBeNull());

    await expect(controller.viewerNext()).resolves.toBe(true);
    expect(store.getState().viewerIndex).toBe(1);
    await vi.waitFor(() => {
      expect(store.getState().viewerAnnotation?.content).toBe("content of asset-2");
    });

    // 越界前进/后退为 no-op。
    await expect(controller.viewerNext()).resolves.toBe(false);
    await expect(controller.viewerPrevious()).resolves.toBe(true);
    expect(store.getState().viewerIndex).toBe(0);
    await expect(controller.viewerPrevious()).resolves.toBe(false);
  });

  it("closes the viewer and resets its state", async () => {
    const { store, controller } = await openReadyViewer();
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerAnnotation).not.toBeNull());

    expect(controller.closeViewer()).toBe(true);
    expect(store.getState().viewerIndex).toBe(-1);
    expect(store.getState().viewerAssets).toHaveLength(0);
    expect(store.getState().viewerAnnotation).toBeNull();
    expect(store.getState().viewerPhase).toBe("idle");
  });

  it("records annotation errors with stable codes", async () => {
    const service = makeViewerService().service;
    (service as unknown as { getAnnotation: ReturnType<typeof vi.fn> }).getAnnotation = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { code: "txt_read_failed" });
    });
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");

    controller.openViewer("asset-1");
    await vi.waitFor(() => {
      expect(store.getState().viewerPhase).toBe("error");
      expect(store.getState().viewerErrorCode).toBe("txt_read_failed");
    });
  });
});

describe("gallery selection controller (G2-3 多选)", () => {
  const assets = [1, 2, 3].map((n) => ({
    asset_id: `asset-${n}`,
    source_id: "source-1",
    directory_id: "dir-root",
    relative_path: `${n}.jpg`,
    name: `${n}.jpg`,
    extension: ".jpg",
    size_bytes: 100,
    modified_ns: 1,
    content_sha256: "x",
    content_version: 1,
    format: "jpeg",
    width: 100,
    height: 50,
    read_state: "ok",
    error_code: "",
    txt_relative_path: null,
    txt_size_bytes: 0,
    txt_modified_ns: 0,
    txt_version: 0,
    txt_state: "missing",
    dedup_visibility: "candidate",
    lifecycle_state: "active",
    updated_at: 1,
  })) as GalleryAssetEntry[];

  function makeSelectionService() {
    return {
      listSources: vi.fn(async () => [source]),
      listDirectoryEntries: vi.fn(async () => ({
        directory: rootDirectory,
        directories: [],
        assets,
        directory_cursor: null,
        asset_cursor: null,
      })),
      getAnnotation: vi.fn(async (assetId: string) => ({
        asset_id: assetId,
        txt_state: "missing",
        content: null,
        txt_version: 0,
        disk_version: "missing-disk-version",
      })),
      thumbnailUrl: (assetId: string) => `thumb:${assetId}`,
      contentUrl: (assetId: string) => `content:${assetId}`,
    } as unknown as GalleryService;
  }

  it("applies click selection, additive toggles, ranges, select-all and clear", async () => {
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service: makeSelectionService() });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");

    expect(controller.clickAsset("asset-2", { additive: false, range: false })).toBe(true);
    expect(store.getState().selectedAssetIds).toEqual(["asset-2"]);

    expect(controller.clickAsset("asset-1", { additive: true, range: false })).toBe(true);
    expect(store.getState().selectedAssetIds).toEqual(["asset-2", "asset-1"]);

    expect(controller.clickAsset("asset-3", { additive: false, range: true })).toBe(true);
    // additive 点击 asset-1 后锚点移到 0；range 点击 asset-3 重建 [0,2] 全选区间。
    expect(store.getState().selectedAssetIds).toEqual(["asset-1", "asset-2", "asset-3"]);

    expect(controller.selectAllAssets()).toBe(true);
    expect(store.getState().selectedAssetIds).toHaveLength(3);

    expect(controller.clearAssetSelection()).toBe(true);
    expect(store.getState().selectedAssetIds).toEqual([]);

    expect(controller.clickAsset("missing", { additive: false, range: false })).toBe(false);
  });

  it("keeps the browsed directory while source-scoped search and viewer paging run", async () => {
    const nestedDirectory = {
      ...rootDirectory,
      directory_id: "dir-nested",
      parent_id: "dir-root",
      relative_path: "nested",
      name: "nested",
    } as GalleryDirectoryEntry;
    const first = {
      ...assets[0],
      asset_id: "asset-source-search-1",
      directory_id: "dir-nested",
      relative_path: "nested/cat-1.jpg",
      name: "cat-1.jpg",
    } as GalleryAssetEntry;
    const second = {
      ...first,
      asset_id: "asset-source-search-2",
      relative_path: "other/cat-2.jpg",
      name: "cat-2.jpg",
    } as GalleryAssetEntry;
    const searchAssets = vi
      .fn()
      .mockResolvedValueOnce({ scope: "source", assets: [first], asset_cursor: "source-next", limit: 120 })
      .mockResolvedValueOnce({ scope: "source", assets: [second], asset_cursor: null, limit: 120 });
    const service = { ...makeSelectionService(), searchAssets } as GalleryService;
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    store.applyDirectoryPage({
      directory: nestedDirectory,
      directories: [],
      assets: [assets[0]],
      directory_cursor: null,
      asset_cursor: null,
    });

    await expect(controller.setSearchScope("source")).resolves.toBe(true);
    expect(searchAssets).not.toHaveBeenCalled();
    expect(store.getState().currentDirectory?.directory_id).toBe("dir-nested");

    await expect(controller.submitQuery("cat")).resolves.toBe(true);
    expect(searchAssets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scope: "source",
        sourceId: "source-1",
        directoryId: null,
        includeDescendants: true,
        assetCursor: null,
      }),
      expect.any(AbortSignal),
    );
    expect(store.getState().currentDirectory?.directory_id).toBe("dir-nested");

    expect(controller.openViewer("asset-source-search-1")).toBe(true);
    await expect(controller.viewerNext()).resolves.toBe(true);
    expect(searchAssets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ scope: "source", sourceId: "source-1", assetCursor: "source-next" }),
      expect.any(AbortSignal),
    );
    expect(store.getState().viewerAssets[store.getState().viewerIndex]?.asset_id).toBe(
      "asset-source-search-2",
    );
    controller.destroy();
  });

  it("searches the whole library and continues viewer navigation through search cursors", async () => {
    const first = {
      asset_id: "asset-search-1",
      source_id: "source-1",
      directory_id: "dir-root",
      relative_path: "nested/cat-1.jpg",
      name: "cat-1.jpg",
    } as GalleryAssetEntry;
    const second = {
      ...first,
      asset_id: "asset-search-2",
      source_id: "source-2",
      directory_id: "dir-other",
      relative_path: "other/cat-2.jpg",
      name: "cat-2.jpg",
    } as GalleryAssetEntry;
    const searchAssets = vi
      .fn()
      .mockResolvedValueOnce({ scope: "library", assets: [first], asset_cursor: "search-next", limit: 120 })
      .mockResolvedValueOnce({ scope: "library", assets: [second], asset_cursor: null, limit: 120 });
    const service = makeService({ searchAssets });
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await vi.waitFor(() => expect(store.getState().sourcesPhase).toBe("ready"));
    await controller.openSource("source-1");
    await controller.setSearchScope("library");
    await controller.submitQuery("cat");

    expect(searchAssets).toHaveBeenNthCalledWith(
      1,
      {
        query: "cat",
        scope: "library",
        sourceId: null,
        directoryId: null,
        includeDescendants: true,
        txtState: null,
        assetCursor: null,
      },
      expect.any(AbortSignal),
    );
    expect(store.getState().assets.map((asset) => asset.asset_id)).toEqual(["asset-search-1"]);

    expect(controller.openViewer("asset-search-1")).toBe(true);
    await expect(controller.viewerNext()).resolves.toBe(true);
    expect(searchAssets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ scope: "library", assetCursor: "search-next" }),
      expect.any(AbortSignal),
    );
    expect(store.getState().viewerAssets.map((asset) => asset.asset_id)).toEqual([
      "asset-search-1",
      "asset-search-2",
    ]);
    expect(store.getState().viewerIndex).toBe(1);
    controller.destroy();
  });
});

describe("gallery file operations controller (G3-3 TXT 编辑/重命名/回收)", () => {
  const assetA = {
    asset_id: "asset-1",
    source_id: "source-1",
    directory_id: "dir-root",
    relative_path: "a.jpg",
    name: "a.jpg",
    extension: ".jpg",
    size_bytes: 100,
    modified_ns: 1,
    content_sha256: "x",
    content_version: 1,
    format: "jpeg",
    width: 100,
    height: 50,
    read_state: "ok",
    error_code: "",
    txt_relative_path: "a.txt",
    txt_size_bytes: 10,
    txt_modified_ns: 1,
    txt_version: 1,
    txt_state: "normal",
    dedup_visibility: "candidate",
    lifecycle_state: "active",
    updated_at: 1,
  } as GalleryAssetEntry;

  const assetB = { ...assetA, asset_id: "asset-2", relative_path: "b.jpg", name: "b.jpg" } as GalleryAssetEntry;

  const operationResult = {
    operation_id: "op-1",
    kind: "trash",
    status: "committed",
    item_count: 2,
    has_txt_count: 1,
  };

  function makeOpsService() {
    return {
      listSources: vi.fn(async () => [source]),
      listDirectoryEntries: vi.fn(async () => ({
        directory: rootDirectory,
        directories: [],
        assets: [assetA, assetB],
        directory_cursor: null,
        asset_cursor: null,
      })),
      getAnnotation: vi.fn(async (assetId: string) => ({
        asset_id: assetId,
        txt_state: "normal",
        content: `content of ${assetId}`,
        txt_version: 1,
        disk_version: "disk-version-1",
      })),
      saveAnnotation: vi.fn(async (assetId: string, content: string) => ({
        asset_id: assetId,
        txt_state: "normal",
        content,
        txt_version: 2,
        disk_version: "disk-version-2",
      })),
      renameAsset: vi.fn(async () => ({ ...operationResult, kind: "rename" })),
      trashAssets: vi.fn(async () => ({ ...operationResult })),
      undoTrash: vi.fn(async () => ({ ...operationResult, kind: "restore" })),
      restoreTrash: vi.fn(async () => ({ ...operationResult, kind: "restore" })),
      purgeTrash: vi.fn(async () => ({ ...operationResult, kind: "purge" })),
      purgeAllTrash: vi.fn(async () => ({ purged_operations: 1, purged_items: 1 })),
      listTrash: vi.fn(async () => ({
        operations: [
          {
            operation_id: "op-1",
            created_at: 1700000000000,
            item_count: 2,
            has_txt_count: 1,
            item_error_count: 0,
            disk_usage_bytes: 2048,
          },
        ],
        next_cursor: null,
      })),
      thumbnailUrl: (assetId: string) => `thumb:${assetId}`,
      contentUrl: (assetId: string) => `content:${assetId}`,
    } as unknown as GalleryService;
  }

  async function openReady(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    const service = makeOpsService();
    for (const [key, value] of Object.entries(overrides)) {
      (service as unknown as Record<string, unknown>)[key] = value;
    }
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    return { store, controller, service: service as unknown as Record<string, ReturnType<typeof vi.fn>> };
  }

  it("edits and saves TXT with the version contract, then advances on demand", async () => {
    const { store, controller, service } = await openReady();
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));

    expect(controller.setTxtDraft("first draft")).toBe(true);
    expect(store.getState().txtDraft).toBe("first draft");

    const saved = await controller.saveTxtAnnotation({ advance: false });
    expect(saved).toBe(true);
    expect(service.saveAnnotation).toHaveBeenCalledWith(
      "asset-1",
      "first draft",
      1,
      "disk-version-1",
    );
    expect(store.getState().txtSavePhase).toBe("saved");
    // 保存成功后编辑器关闭，重新进入编辑态用新的已保存内容。
    expect(store.getState().txtDraft).toBe(null);
    expect(store.getState().viewerAnnotation?.txt_version).toBe(2);

    controller.setTxtDraft("next");
    const advanced = await controller.saveTxtAnnotation({ advance: true });
    expect(advanced).toBe(true);
    expect(store.getState().viewerIndex).toBe(1);
  });

  it("keeps the draft and surfaces the code when saving hits a version conflict", async () => {
    const conflictError = Object.assign(new Error("conflict"), { code: "txt_version_conflict" });
    const { store, controller } = await openReady({
      saveAnnotation: vi.fn(async () => {
        throw conflictError;
      }),
    });
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));
    controller.setTxtDraft("draft");

    const ok = await controller.saveTxtAnnotation({ advance: false });
    expect(ok).toBe(false);
    expect(store.getState().txtSavePhase).toBe("conflict");
    expect(store.getState().txtSaveErrorCode).toBe("txt_version_conflict");
    // 冲突时草稿保留，供用户处理后重试。
    expect(store.getState().txtDraft).toBe("draft");
  });

  it("renames a single selected pair through the dialog contract", async () => {
    const { store, controller, service } = await openReady();
    controller.clickAsset("asset-1", { additive: false, range: false });

    expect(controller.openRenameDialog("asset-1")).toBe(true);
    expect(store.getState().renameDialogPhase).toBe("open");
    expect(store.getState().renameAssetId).toBe("asset-1");

    const ok = await controller.submitRename("renamed");
    expect(ok).toBe(true);
    expect(service.renameAsset).toHaveBeenCalledWith("asset-1", "renamed");
    expect(store.getState().renameDialogPhase).toBe("closed");
  });

  it("rejects empty rename stems locally before any request", async () => {
    const { store, controller, service } = await openReady();
    controller.clickAsset("asset-1", { additive: false, range: false });
    controller.openRenameDialog("asset-1");

    const ok = await controller.submitRename("   ");
    expect(ok).toBe(false);
    expect(service.renameAsset).not.toHaveBeenCalled();
    expect(store.getState().renameDialogPhase).not.toBe("closed");
    expect(store.getState().renameDialogError).toBeTruthy();
  });

  it("trashes the selection after confirmation, shows undo, and undo restores", async () => {
    const { store, controller, service } = await openReady();
    controller.selectAllAssets();
    expect(controller.requestTrashSelection()).toBe(true);
    expect(store.getState().trashConfirmPhase).toBe("open");
    expect(store.getState().trashConfirmAssetIds).toEqual(["asset-1", "asset-2"]);

    const ok = await controller.confirmTrashSelection();
    expect(ok).toBe(true);
    expect(service.trashAssets).toHaveBeenCalledWith(["asset-1", "asset-2"]);
    expect(store.getState().trashConfirmPhase).toBe("closed");
    expect(store.getState().undoToastVisible).toBe(true);
    expect(store.getState().undoableOperationId).toBe("op-1");

    const undone = await controller.undoLastTrash();
    expect(undone).toBe(true);
    expect(service.undoTrash).toHaveBeenCalledWith("op-1");
    expect(store.getState().undoToastVisible).toBe(false);
  });

  it("confirms a directory-only selection through the complete physical-directory contract", async () => {
    const { store, controller, service } = await openReady();
    expect(controller.requestTrashSelection([], ["dir-sub"])).toBe(true);
    expect(store.getState().trashConfirmDirectoryIds).toEqual(["dir-sub"]);
    expect(await controller.confirmTrashSelection()).toBe(true);
    expect(service.trashAssets).toHaveBeenCalledWith([], ["dir-sub"]);
    expect(store.getState().trashConfirmPhase).toBe("closed");
  });

  it("keeps confirm data but records the code when trashing fails", async () => {
    const failure = Object.assign(new Error("target conflict"), { code: "target_conflict" });
    const { store, controller } = await openReady({
      trashAssets: vi.fn(async () => {
        throw failure;
      }),
    });
    controller.clickAsset("asset-1", { additive: false, range: false });
    controller.requestTrashSelection();

    const ok = await controller.confirmTrashSelection();
    expect(ok).toBe(false);
    expect(store.getState().trashConfirmPhase).toBe("open");
    expect(store.getState().trashConfirmError).toBe("target_conflict");
    controller.cancelTrashConfirm();
    expect(store.getState().trashConfirmPhase).toBe("closed");
  });

  it("loads the trash panel, restores, purges, and reloads on demand", async () => {
    const { store, controller, service } = await openReady();
    const ok = await controller.openTrashPanel();
    expect(ok).toBe(true);
    expect(store.getState().trashPanelPhase).toBe("ready");
    expect(store.getState().trashOperations).toHaveLength(1);

    expect(await controller.restoreTrashOperation("op-1")).toBe(true);
    expect(service.restoreTrash).toHaveBeenCalledWith("op-1");

    expect(await controller.purgeTrashOperation("op-1")).toBe(true);
    expect(service.purgeTrash).toHaveBeenCalledWith("op-1");
    expect(service.listTrash).toHaveBeenCalled();

    controller.closeTrashPanel();
    expect(store.getState().trashPanelPhase).toBe("closed");
  });

  it("guards dirty viewer exits, executes Save or Discard, and ignores no-op navigation", async () => {
    const { store, controller, service } = await openReady();
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));
    controller.setTxtDraft("saved before leaving");

    await expect(controller.viewerPrevious()).resolves.toBe(false);
    await expect(controller.viewerJump(0)).resolves.toBe(false);
    expect(store.getState().viewerPendingAction).toBeNull();

    await expect(controller.viewerNext()).resolves.toBe(false);
    expect(store.getState().viewerPendingAction).toEqual({ kind: "next" });
    await expect(controller.resolveViewerPendingAction("cancel")).resolves.toBe(true);
    expect(store.getState().viewerIndex).toBe(0);
    expect(store.getState().txtDraft).toBe("saved before leaving");

    await controller.viewerNext();
    await expect(controller.resolveViewerPendingAction("save")).resolves.toBe(true);
    expect(service.saveAnnotation).toHaveBeenCalledWith(
      "asset-1",
      "saved before leaving",
      1,
      "disk-version-1",
    );
    expect(store.getState().viewerIndex).toBe(1);
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));
    controller.setTxtDraft("discard before close");

    await expect(controller.viewerNext()).resolves.toBe(false);
    await expect(controller.viewerJump(Number.NaN)).resolves.toBe(false);
    expect(store.getState().viewerPendingAction).toBeNull();

    expect(controller.closeViewer()).toBe(false);
    expect(store.getState().viewerPendingAction).toEqual({ kind: "close" });
    await expect(controller.resolveViewerPendingAction("discard")).resolves.toBe(true);
    expect(store.getState().viewerIndex).toBe(-1);
    expect(store.getState().txtDraft).toBeNull();
  });

  it("guards viewer trash, then advances and exposes the paired-item undo count", async () => {
    let trashed = false;
    const listDirectoryEntries = vi.fn(async () => ({
      directory: rootDirectory,
      directories: [],
      assets: trashed ? [assetB] : [assetA, assetB],
      directory_cursor: null,
      asset_cursor: null,
    }));
    const trashAssets = vi.fn(async () => {
      trashed = true;
      return operationResult;
    });
    const { store, controller } = await openReady({ listDirectoryEntries, trashAssets });
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));
    controller.setTxtDraft("discard me");

    await expect(controller.trashViewerAsset()).resolves.toBe(false);
    expect(store.getState().viewerPendingAction).toEqual({ kind: "trash", assetId: "asset-1" });
    await expect(controller.resolveViewerPendingAction("discard")).resolves.toBe(true);

    expect(trashAssets).toHaveBeenCalledWith(["asset-1"]);
    expect(store.getState().viewerAssets[store.getState().viewerIndex]?.asset_id).toBe("asset-2");
    expect(store.getState().undoToastVisible).toBe(true);
    expect(store.getState().undoItemCount).toBe(2);
  });

  it("loads the next cursor page before a viewer-boundary delete advances", async () => {
    let trashed = false;
    const listDirectoryEntries = vi.fn(async (request: { assetCursor: string | null }) => {
      if (request.assetCursor === "next-page") {
        return {
          directory: rootDirectory,
          directories: [],
          assets: [assetB],
          directory_cursor: null,
          asset_cursor: null,
        };
      }
      return {
        directory: rootDirectory,
        directories: [],
        assets: trashed ? [assetB] : [assetA],
        directory_cursor: null,
        asset_cursor: trashed ? null : "next-page",
      };
    });
    const trashAssets = vi.fn(async () => {
      trashed = true;
      return operationResult;
    });
    const { store, controller } = await openReady({ listDirectoryEntries, trashAssets });
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));

    await expect(controller.trashViewerAsset()).resolves.toBe(true);

    expect(listDirectoryEntries).toHaveBeenCalledWith(
      expect.objectContaining({ assetCursor: "next-page" }),
      expect.any(AbortSignal),
    );
    expect(store.getState().viewerAssets.map((asset) => asset.asset_id)).toEqual(["asset-2"]);
    expect(store.getState().viewerAssets[store.getState().viewerIndex]?.asset_id).toBe("asset-2");
  });
});
