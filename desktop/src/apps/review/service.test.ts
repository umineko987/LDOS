import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { createReviewService, normalizeModelProxyUrl, REVIEW_ENDPOINTS } from "./service";

function api() {
  const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
  const put = vi.fn<(path: string, body?: unknown, options?: unknown) => Promise<unknown>>();
  const post = vi.fn<(path: string, body?: unknown, options?: unknown) => Promise<unknown>>();
  const resourceUrl = vi.fn<(path: string) => string>((path) => `http://127.0.0.1:8787${path}`);
  return {
    client: { get, put, post, resourceUrl } as unknown as ApiClient,
    get,
    put,
    post,
    resourceUrl,
  };
}

const rawPage = {
  review_id: "review-one",
  response_profile: "desktop-gallery-review-v1",
  version: 1,
  directories: [{ directory_id: "directory-one", source_id: "source-one", source_display_name: "Source", relative_path: "album", name: "album" }],
  status: "ready",
  totalImageCount: 1,
  totalGroupCount: 1,
  duplicateGroupCount: 0,
  unreadableImageCount: 0,
  automaticGroupCount: 0,
  automaticRejectedImageCount: 0,
  selectedImageCount: 1,
  decidedGroupCount: 0,
  keptImageCount: 0,
  rejectedImageCount: 0,
  failedImageCount: 0,
  hasError: false,
  groups: {
    items: [{ id: "group-1", ordinal: 1, kind: "duplicate", decided: false, images: [{ id: "image-1", asset_id: "image-1", source_display_name: "Source", relative_path: "album/1.jpg", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 800, h: 1200 } }] }],
    offset: 0,
    limit: 1,
    total: 1,
  },
};

describe("review service", () => {
  it("uses gallery review identities, desktop profiles and versioned mutations", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    const signal = new AbortController().signal;
    const operation = { ...rawPage, response_profile: "desktop-gallery-review-operation-v1" };
    calls.get.mockResolvedValueOnce({ response_profile: "desktop-gallery-review-list-v1", items: [operation], limit: 50, offset: 50, total: 51 });
    expect(await service.readRecent(signal, 50)).toMatchObject({ total: 51, offset: 50, items: [{ reviewId: "review-one" }] });
    expect(calls.get).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.reviews}?limit=50&offset=50&view=desktop`, { signal });

    calls.get.mockResolvedValueOnce(rawPage);
    const page = await service.readPage("review-one", "duplicate", signal);
    expect(page.reviewId).toBe("review-one");
    expect(calls.get).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.reviews}/review-one?limit=50&offset=0&view=desktop&kind=duplicate`, { signal });

    const payload = { version: 1, groups: [{ group_id: "group-1", selected_image_ids: ["image-1"] }] };
    calls.put.mockResolvedValueOnce({ ...operation, version: 2 });
    expect(await service.writeDecisions("review-one", payload, signal)).toMatchObject({ version: 2 });
    expect(calls.put).toHaveBeenCalledWith(`${REVIEW_ENDPOINTS.reviews}/review-one/decisions`, payload, { signal });
    for (const mutation of ["retry", "apply"] as const) {
      calls.post.mockResolvedValueOnce(operation);
      await service.run(mutation, "review-one", 2, signal);
      expect(calls.post).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.reviews}/review-one/${mutation}`, mutation === "apply" ? { version: 2 } : {}, { signal });
    }
    expect(service.imageUrl("review-one", "image-1")).toBe("http://127.0.0.1:8787/api/v1/gallery/reviews/review-one/images/image-1");
    expect(calls.resourceUrl).toHaveBeenCalledWith("/api/v1/gallery/reviews/review-one/images/image-1");
    expect(JSON.stringify(calls.put.mock.calls)).not.toContain("url");
  });

  it("reads and starts the optional model setup through fixed endpoints", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    const signal = new AbortController().signal;
    const setup = {
      phase: "idle", enabled: false, installed: false, using_proxy: false,
      downloaded_bytes: 0, expected_bytes: 190, message: "",
      models: { sscd: { installed: false }, dino: { installed: false } },
    };
    calls.get.mockResolvedValueOnce(setup);
    await expect(service.readModelSetup(signal)).resolves.toMatchObject({ phase: "idle", installed: false });
    expect(calls.get).toHaveBeenCalledWith(REVIEW_ENDPOINTS.models, { signal });

    calls.post.mockResolvedValueOnce({ ...setup, phase: "installing", using_proxy: true });
    await expect(service.installModels("http://127.0.0.1:7890", signal)).resolves.toMatchObject({ phase: "installing", usingProxy: true });
    expect(calls.post).toHaveBeenCalledWith(
      `${REVIEW_ENDPOINTS.models}/install`,
      { proxy_url: "http://127.0.0.1:7890" },
      { signal },
    );
  });

  it("validates the optional model download proxy before sending it", () => {
    expect(normalizeModelProxyUrl("")).toBe("");
    expect(normalizeModelProxyUrl("  http://127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890");
    expect(normalizeModelProxyUrl("https://user:pass@[::1]:443")).toBe("https://user:pass@[::1]:443");
    for (const invalid of [
      "127.0.0.1:7890",
      "socks5://127.0.0.1:7890",
      "http://127.0.0.1",
      "http://127.0.0.1:7890/path",
      "http://127.0.0.1:99999",
    ]) {
      expect(() => normalizeModelProxyUrl(invalid)).toThrowError("invalid_model_proxy_format");
    }
  });

  it("loads a review workspace through bounded sequential pages", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    const signal = new AbortController().signal;
    const firstGroup = rawPage.groups.items[0];
    const secondGroup = {
      ...firstGroup,
      id: "group-2",
      ordinal: 2,
      images: [{ ...firstGroup.images[0], id: "image-2", asset_id: "image-2", source_display_name: "Source", relative_path: "album/2.jpg", ordinal: 2 }],
    };
    const summary = { totalImageCount: 2, totalGroupCount: 2, duplicateGroupCount: 2, selectedImageCount: 2 };
    calls.get
      .mockResolvedValueOnce({ ...rawPage, ...summary, groups: { items: [firstGroup], offset: 0, limit: 50, total: 2 } })
      .mockResolvedValueOnce({ ...rawPage, ...summary, groups: { items: [secondGroup], offset: 1, limit: 50, total: 2 } });
    const snapshot = await service.readPage("review-one", "", signal);
    expect(snapshot.groupOrder).toEqual(["group-1", "group-2"]);
    expect(calls.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/gallery/reviews/review-one?limit=50&offset=0&view=desktop",
      "/api/v1/gallery/reviews/review-one?limit=50&offset=1&view=desktop",
    ]);
  });
  it("refuses to merge groups from different authoritative versions", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    const groups = { items: rawPage.groups.items, offset: 0, limit: 1, total: 2 };
    calls.get.mockResolvedValueOnce({ ...rawPage, groups });
    calls.get.mockResolvedValueOnce({ ...rawPage, version: 2, groups: { ...groups, offset: 1 } });
    await expect(service.readPage("review-one", "", new AbortController().signal)).rejects.toMatchObject({ code: "review_page_changed", status: 409 });
  });
  it("rejects invalid status operations and rethrows aborts unchanged", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    await expect(service.run("invalid" as "retry", "review-one", 1, new AbortController().signal)).rejects.toThrow(TypeError);
    const abort = new DOMException("aborted", "AbortError");
    calls.get.mockRejectedValueOnce(abort);
    await expect(service.readRecent(new AbortController().signal)).rejects.toBe(abort);
  });
});
