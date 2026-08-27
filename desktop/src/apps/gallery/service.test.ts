import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { createGalleryService, GALLERY_ENDPOINTS } from "./service";

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
  const post = vi.fn(async (path: string) =>
    path.endsWith("/cancel") ? operation("cancelled") : operation(),
  );
  return {
    client: { get, post } as unknown as ApiClient,
    get,
    post,
  };
}

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
    expect(mock.post).toHaveBeenLastCalledWith(
      `${GALLERY_ENDPOINTS.directoryExports}/gallery-directory-export-1/cancel`,
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
