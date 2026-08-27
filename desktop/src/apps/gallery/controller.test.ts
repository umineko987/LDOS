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
      })),
      saveAnnotation: vi.fn(async (assetId: string, content: string) => ({
        asset_id: assetId,
        txt_state: "normal",
        content,
        txt_version: 2,
      })),
      renameAsset: vi.fn(async () => ({ ...operationResult, kind: "rename" })),
      trashAssets: vi.fn(async () => ({ ...operationResult })),
      undoTrash: vi.fn(async () => ({ ...operationResult, kind: "restore" })),
      restoreTrash: vi.fn(async () => ({ ...operationResult, kind: "restore" })),
      purgeTrash: vi.fn(async () => ({ ...operationResult, kind: "purge" })),
      purgeAllTrash: vi.fn(async () => ({ ...operationResult, kind: "purge" })),
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
    expect(service.saveAnnotation).toHaveBeenCalledWith("asset-1", "first draft", 1);
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
});
