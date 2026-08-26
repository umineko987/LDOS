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

function makeService(
  overrides: Partial<Record<"listSources" | "listDirectoryEntries", ReturnType<typeof vi.fn>>> = {},
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
});
