import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { APPLICATION_DEFINITIONS } from "../src/core/applications/definitions";
import { createGalleryController } from "../src/apps/gallery/controller";
import * as galleryModel from "../src/apps/gallery/model";
import * as galleryServiceModule from "../src/apps/gallery/service";
import { createGalleryStore } from "../src/apps/gallery/state";
import type { GalleryService } from "../src/apps/gallery/service";

const source = {
  source_id: "source-1",
  root_directory_id: "dir-root",
  kind: "imported",
  batch_id: null,
  display_name: "来源",
  availability: "available",
  asset_count: 3,
  crawl_complete: true,
  dedup_required: false,
  dedup_state: "not_required",
  content_version: 1,
  annotation_version: 1,
  indexed_version: 1,
  last_scanned_at: 1,
  created_at: 1,
  updated_at: 1,
} as const;

const rootDirectory = {
  directory_id: "dir-root",
  source_id: "source-1",
  parent_id: null,
  relative_path: "",
  name: "",
  direct_directory_count: 1,
  direct_asset_count: 3,
  recursive_asset_count: 3,
  cover_asset_ids: ["asset-1"],
  indexed_version: 1,
} as const;

function asset(index: number) {
  return {
    asset_id: `asset-${index}`,
    source_id: "source-1",
    directory_id: "dir-root",
    relative_path: `${index}.jpg`,
    name: `${index}.jpg`,
    extension: ".jpg",
    size_bytes: 100,
    modified_ns: index,
    content_sha256: "",
    content_version: 1,
    format: "JPEG",
    width: 100,
    height: 80,
    read_state: "ok",
    error_code: "",
    txt_relative_path: `${index}.txt`,
    txt_size_bytes: 4,
    txt_modified_ns: index,
    txt_version: 1,
    txt_state: "normal",
    dedup_visibility: "candidate",
    lifecycle_state: "active",
    updated_at: 1,
  } as const;
}

function runtimeFunction(object: unknown, name: string): (...args: never[]) => unknown {
  const value = (object as Record<string, unknown>)[name];
  expect(typeof value, `${name} must be implemented`).toBe("function");
  return value as (...args: never[]) => unknown;
}

describe("R0 single Gallery product contract", () => {
  it("removes the independent Export application and runtime mount", () => {
    expect(APPLICATION_DEFINITIONS.map((definition) => definition.id)).not.toContain("export");

    const appWindowPath = fileURLToPath(new URL("../src/shell/AppWindow.svelte", import.meta.url));
    const sourceText = readFileSync(appWindowPath, "utf8");
    expect(sourceText).not.toContain('apps/export/Export.svelte');
    expect(sourceText).not.toContain('record.appId === "export"');
  });

  it("exposes source lifecycle, whole-directory export and gallery-search methods from one service", () => {
    const api = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      resourceUrl: vi.fn((path: string) => path),
    };
    const service = galleryServiceModule.createGalleryService(api as never);
    for (const method of [
      "startSourceScan",
      "getSourceScan",
      "renameSource",
      "relinkSource",
      "unmountSource",
      "searchAssets",
      "startDirectoryExport",
      "getDirectoryExport",
      "cancelDirectoryExport",
    ]) {
      runtimeFunction(service, method);
    }

    const endpoints = galleryServiceModule.GALLERY_ENDPOINTS as unknown as Record<string, unknown>;
    expect(endpoints.directoryExports).toBe("/api/v1/gallery/directory-exports");
    expect(endpoints.search).toBe("/api/v1/gallery/search");
  });

  it("requests the thumbnail tier chosen for the rendered card", () => {
    const api = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      resourceUrl: vi.fn((path: string) => path),
    };
    const service = galleryServiceModule.createGalleryService(api as never);
    const thumbnailUrl = service.thumbnailUrl as unknown as (
      assetId: string,
      size: 256 | 512,
    ) => string;
    expect(thumbnailUrl("asset-1", 256)).toContain("size=256");
    expect(thumbnailUrl("asset-1", 512)).toContain("size=512");
  });
  it("keeps thumbnail tiers tied to each rendered Gallery surface", () => {
    const galleryPath = fileURLToPath(new URL("../src/apps/gallery/Gallery.svelte", import.meta.url));
    const viewerPath = fileURLToPath(new URL("../src/apps/gallery/Viewer.svelte", import.meta.url));
    const gallerySource = readFileSync(galleryPath, "utf8");
    const viewerSource = readFileSync(viewerPath, "utf8");

    expect(gallerySource).toContain("service.thumbnailUrl(coverId, 256)");
    expect(gallerySource).toContain("service.thumbnailUrl(asset.asset_id, 512)");
    expect(gallerySource).toContain("service.thumbnailUrl(asset.asset_id, 256)");
    expect(gallerySource).not.toMatch(/service\.thumbnailUrl\([^,\n]+\)/);
    expect(viewerSource).toContain("thumbnailUrl(asset.asset_id, 256)");
    expect(viewerSource).not.toMatch(/thumbnailUrl\([^,\n]+\)/);
  });
});

describe("R0 TXT tag presentation contract", () => {
  it("preserves duplicate and empty comma positions while reporting warnings", () => {
    const parse = runtimeFunction(galleryModel, "parseGalleryTxtTagView") as unknown as (
      raw: string | null,
    ) => {
      tags: readonly { value: string; empty: boolean; duplicate: boolean }[];
      empty_count: number;
      duplicate_count: number;
    };
    const result = parse("red, ,red, blue ,");
    expect(result.tags.map((tag) => tag.value)).toEqual(["red", "", "red", "blue", ""]);
    expect(result.tags.map((tag) => tag.empty)).toEqual([false, true, false, false, true]);
    expect(result.tags.map((tag) => tag.duplicate)).toEqual([false, false, true, false, false]);
    expect(result.empty_count).toBe(2);
    expect(result.duplicate_count).toBe(1);
  });
});

describe("R0 viewer state-machine regressions", () => {
  function makeService(pages: readonly (readonly ReturnType<typeof asset>[])[]) {
    let pageIndex = 0;
    return {
      listSources: vi.fn(async () => [source]),
      listDirectoryEntries: vi.fn(async () => {
        const assets = pages[Math.min(pageIndex, pages.length - 1)] ?? [];
        const current = pageIndex;
        pageIndex += 1;
        return {
          directory: rootDirectory,
          directories: [],
          assets,
          directory_cursor: null,
          asset_cursor: current < pages.length - 1 ? `cursor-${current + 1}` : null,
        };
      }),
      getAnnotation: vi.fn(async (assetId: string) => ({
        asset_id: assetId,
        txt_state: "normal",
        content: "saved",
        txt_version: 1,
        disk_version: "opaque-disk-token",
      })),
      saveAnnotation: vi.fn(async (assetId: string, content: string) => ({
        asset_id: assetId,
        txt_state: "normal",
        content,
        txt_version: 2,
        disk_version: "next-opaque-disk-token",
      })),
      trashAssets: vi.fn(async () => ({
        operation_id: "trash-op",
        kind: "trash",
        status: "committed",
        item_count: 2,
        has_txt_count: 2,
      })),
      thumbnailUrl: (assetId: string) => `thumb:${assetId}`,
      contentUrl: (assetId: string) => `content:${assetId}`,
    } as unknown as GalleryService;
  }

  async function readyController(pages: readonly (readonly ReturnType<typeof asset>[])[]) {
    const store = createGalleryStore();
    const controller = createGalleryController({ store, service: makeService(pages) });
    controller.activate();
    await controller.refreshSources();
    await controller.openSource("source-1");
    return { store, controller };
  }

  it("stores one pending close action and cancel keeps the dirty viewer in place", async () => {
    const { store, controller } = await readyController([[asset(1), asset(2)]]);
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));
    controller.setTxtDraft("dirty draft");

    expect(controller.closeViewer()).toBe(false);
    const guarded = store.getState() as unknown as Record<string, unknown>;
    expect(guarded.viewerPendingAction).toEqual({ kind: "close" });
    expect(guarded.viewerIndex).toBe(0);

    const resolve = runtimeFunction(controller, "resolveViewerPendingAction") as unknown as (
      resolution: "save" | "discard" | "cancel",
    ) => Promise<boolean>;
    await expect(resolve("cancel")).resolves.toBe(true);
    const cancelled = store.getState() as unknown as Record<string, unknown>;
    expect(cancelled.viewerPendingAction).toBeNull();
    expect(cancelled.viewerIndex).toBe(0);
  });

  it("supports direct filmstrip jumps instead of reducing every jump to one step", async () => {
    const { store, controller } = await readyController([[asset(1), asset(2), asset(3)]]);
    controller.openViewer("asset-1");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));

    const jump = runtimeFunction(controller, "viewerJump") as unknown as (
      index: number,
    ) => Promise<boolean>;
    await expect(jump(2)).resolves.toBe(true);
    expect(store.getState().viewerIndex).toBe(2);
  });

  it("loads the next bounded page before navigating past the loaded viewer tail", async () => {
    const { store, controller } = await readyController([[asset(1), asset(2)], [asset(3)]]);
    controller.openViewer("asset-2");
    await vi.waitFor(() => expect(store.getState().viewerPhase).toBe("ready"));

    await expect(controller.viewerNext()).resolves.toBe(true);
    expect(store.getState().viewerAssets.map((entry) => entry.asset_id)).toEqual([
      "asset-1",
      "asset-2",
      "asset-3",
    ]);
    expect(store.getState().viewerIndex).toBe(2);
  });

  it("carries the actual trash item count into the undo toast", async () => {
    const { store, controller } = await readyController([[asset(1), asset(2)]]);
    controller.selectAllAssets();
    controller.requestTrashSelection();
    await expect(controller.confirmTrashSelection()).resolves.toBe(true);
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.undoItemCount).toBe(2);
  });
});
