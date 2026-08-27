import { describe, expect, it, vi } from "vitest";

import type { GalleryAssetEntry, GalleryDirectoryEntry, GallerySourceSummary } from "./model";
import { createGalleryStore } from "./state";

const source: GallerySourceSummary = {
  source_id: "source-1",
  root_directory_id: "dir-root",
  kind: "imported",
  batch_id: null,
  display_name: "导入目录 A",
  availability: "available",
  asset_count: 2,
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
  recursive_asset_count: 2,
  recursive_directory_count: 1,
  cover_asset_ids: Object.freeze(["asset-1", "asset-2"]),
  indexed_version: 3,
} as GalleryDirectoryEntry;

const childDirectory: GalleryDirectoryEntry = {
  ...rootDirectory,
  directory_id: "dir-1",
  parent_id: "dir-root",
  relative_path: "sub",
  name: "sub",
  direct_directory_count: 0,
  cover_asset_ids: Object.freeze([]),
};

function asset(id: string, name: string, override: Partial<GalleryAssetEntry> = {}): GalleryAssetEntry {
  return {
    asset_id: id,
    source_id: "source-1",
    directory_id: "dir-root",
    relative_path: name,
    name,
    extension: ".jpg",
    format: "JPEG",
    size_bytes: 1024,
    modified_ns: 1_700_000_000_000_000_000,
    width: 640,
    height: 480,
    txt_state: "normal",
    txt_relative_path: `${name}.txt`,
    dedup_state: "not_required",
    dedup_visibility: "visible",
    ...override,
  } as GalleryAssetEntry;
}

function page(override: Record<string, unknown> = {}) {
  return {
    directory: rootDirectory,
    directories: [childDirectory],
    assets: [asset("asset-1", "1.jpg"), asset("asset-2", "2.jpg")],
    directory_cursor: null,
    asset_cursor: null,
    ...override,
  };
}

describe("gallery browse store", () => {
  it("publishes initial idle state and notifies subscribers", () => {
    const store = createGalleryStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();

    const state = store.getState();
    expect(state.sourcesPhase).toBe("idle");
    expect(state.sources).toEqual([]);
    expect(state.activeSourceId).toBeNull();
    expect(state.pagePhase).toBe("idle");
    expect(state.viewMode).toBe("grid");
    unsubscribe();
    store.destroy();
  });

  it("ignores mutations after destroy and rejects listeners that misbehave", () => {
    const store = createGalleryStore();
    store.destroy();
    expect(store.setSources([])).toBe(false);

    const live = createGalleryStore();
    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    live.subscribe(bad);
    expect(live.setSources([source])).toBe(true);
    live.destroy();
  });

  it("applies a directory page with natural ordering and preserves the tree", () => {
    const store = createGalleryStore();
    store.setSources([source]);
    store.openSource("source-1", "dir-root");

    expect(store.applyDirectoryPage(page())).toBe(true);
    const applied = store.getState();
    expect(applied.currentDirectory?.directory_id).toBe("dir-root");
    expect(applied.directories.map((entry) => entry.directory_id)).toEqual(["dir-1"]);
    expect(applied.assets.map((entry) => entry.name)).toEqual(["1.jpg", "2.jpg"]);
    expect(applied.pagePhase).toBe("ready");
    expect(applied.path.map((segment) => segment.name)).toEqual([]);
    store.destroy();
  });
  it("re-applying the same directory (search refresh) keeps a duplicate-free path", () => {
    const store = createGalleryStore();
    store.setSources([source]);
    store.openSource("source-1", "dir-root");
    store.applyDirectoryPage(page());

    // 进入子目录：父级（根）不在路径中（根路径为空），路径退化为 [sub]；
    // 再次应用同一子目录页（搜索刷新）不得重复压栈，否则 Svelte each 键重复崩溃。
    expect(
      store.applyDirectoryPage({
        ...page(),
        directory: childDirectory,
        directories: [],
        assets: [asset("asset-3", "3.jpg", { directory_id: "dir-1", relative_path: "sub/3.jpg" })],
      }),
    ).toBe(true);
    const entered = store.getState();
    expect(entered.path.map((segment) => segment.directory_id)).toEqual(["dir-1"]);

    expect(store.applyDirectoryPage({ ...page(), directory: childDirectory, directories: [] })).toBe(true);
    const refreshed = store.getState();
    expect(refreshed.path.map((segment) => segment.directory_id)).toEqual(["dir-1"]);
    expect(new Set(refreshed.path.map((segment) => segment.directory_id)).size).toBe(refreshed.path.length);
    store.destroy();
  });


  it("appends further pages without losing earlier rows", () => {
    const store = createGalleryStore();
    store.setSources([source]);
    store.openSource("source-1", "dir-root");
    store.applyDirectoryPage(page({ asset_cursor: "cursor-1" }));

    expect(
      store.appendDirectoryPage({
        directory_id: "dir-root",
        directories: [],
        assets: [asset("asset-10", "10.jpg")],
        directory_cursor: null,
        asset_cursor: null,
      }),
    ).toBe(true);

    const appended = store.getState();
    expect(appended.assets.map((entry) => entry.name)).toEqual(["1.jpg", "2.jpg", "10.jpg"]);
    expect(appended.assetCursor).toBeNull();
    store.destroy();
  });

  it("keeps active source when reloading sources and resets when it disappears", () => {
    const store = createGalleryStore();
    store.setSources([source]);
    store.openSource("source-1", "dir-root");
    store.applyDirectoryPage(page());

    store.setSources([source, { ...source, source_id: "source-2", display_name: "目录 B" }]);
    expect(store.getState().activeSourceId).toBe("source-1");
    expect(store.getState().currentDirectory?.directory_id).toBe("dir-root");

    store.setSources([{ ...source, source_id: "source-2", display_name: "目录 B" }]);
    expect(store.getState().activeSourceId).toBeNull();
    expect(store.getState().assets).toEqual([]);
    store.destroy();
  });

  it("drives view mode and filters through guarded patches", () => {
    const store = createGalleryStore();
    expect(store.patch({ viewMode: "list" })).toBe(true);
    expect(store.getState().viewMode).toBe("list");
    expect(store.patch({ query: "portrait" })).toBe(true);
    expect(store.getState().query).toBe("portrait");
    expect(store.setPageLoading()).toBe(true);
    expect(store.getState().pagePhase).toBe("loading");
    expect(store.setPageError("network_error")).toBe(true);
    expect(store.getState().pageErrorCode).toBe("network_error");
    store.destroy();
  });
});
