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
