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
