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
  batch_id: "batch-review",
  status: "ready",
  total_image_count: 1,
  total_group_count: 1,
  duplicate_group_count: 0,
  unreadable_image_count: 0,
  automatic_group_count: 0,
  automatic_rejected_image_count: 0,
  selected_image_count: 1,
  decided_group_count: 0,
  kept_image_count: 0,
  rejected_image_count: 0,
  failed_image_count: 0,
  error: "",
  groups: {
    items: [{ id: "group-1", ordinal: 1, kind: "duplicate", decided: false, images: [{ id: "image-1", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 800, h: 1200 } }] }],
    offset: 0,
    limit: 1,
    total: 1,
  },
};

describe("review service", () => {
  it("uses only the established crawls routes, bodies, and abort signal", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    const signal = new AbortController().signal;
    calls.get.mockResolvedValueOnce({ items: [{ id: "batch-review", status: "succeeded" }] });
    expect(await service.readRecent(signal)).toEqual([{ id: "batch-review", status: "succeeded", statusLabel: "成功", createdAt: null, terminal: true }]);
    expect(calls.get).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.crawls}?limit=30&view=desktop`, { signal });

    calls.get.mockResolvedValueOnce(rawPage);
    const page = await service.readPage("batch-review", "duplicate", signal);
    expect(page.batchId).toBe("batch-review");
    expect(calls.get).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.crawls}/batch-review/review?limit=50&offset=0&view=desktop&kind=duplicate`, { signal });

    const payload = Object.freeze({ groups: Object.freeze([{ group_id: "group-1", selected_image_ids: Object.freeze(["image-1"]) }]) });
    calls.put.mockResolvedValueOnce(rawPage);
    await service.writeDecisions("batch-review", payload, signal);
    expect(calls.put).toHaveBeenCalledWith(`${REVIEW_ENDPOINTS.crawls}/batch-review/review/decisions?view=desktop`, payload, { signal });

    for (const operation of ["start", "retry", "apply"] as const) {
      calls.post.mockResolvedValueOnce(rawPage);
      await service.run(operation, "batch-review", signal);
      expect(calls.post).toHaveBeenLastCalledWith(`${REVIEW_ENDPOINTS.crawls}/batch-review/review/${operation}?view=desktop`, {}, { signal });
    }
    expect(service.imageUrl("batch-review", "image-1")).toBe("http://127.0.0.1:8787/api/v1/crawls/batch-review/review/images/image-1");
    expect(calls.resourceUrl).toHaveBeenCalledWith("/api/v1/crawls/batch-review/review/images/image-1");
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
      images: [{ ...firstGroup.images[0], id: "image-2", ordinal: 2 }],
    };
    const summary = { total_image_count: 2, total_group_count: 2, duplicate_group_count: 2, selected_image_count: 2 };
    calls.get
      .mockResolvedValueOnce({ ...rawPage, ...summary, groups: { items: [firstGroup], offset: 0, limit: 50, total: 2 } })
      .mockResolvedValueOnce({ ...rawPage, ...summary, groups: { items: [secondGroup], offset: 1, limit: 50, total: 2 } });
    const snapshot = await service.readPage("batch-review", "", signal);
    expect(snapshot.groupOrder).toEqual(["group-1", "group-2"]);
    expect(calls.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/crawls/batch-review/review?limit=50&offset=0&view=desktop",
      "/api/v1/crawls/batch-review/review?limit=50&offset=1&view=desktop",
    ]);
  });
  it("rejects invalid status operations and rethrows aborts unchanged", async () => {
    const calls = api();
    const service = createReviewService(calls.client);
    await expect(service.run("invalid" as "start", "batch-review", new AbortController().signal)).rejects.toThrow(TypeError);
    const abort = new DOMException("aborted", "AbortError");
    calls.get.mockRejectedValueOnce(abort);
    await expect(service.readRecent(new AbortController().signal)).rejects.toBe(abort);
  });
});
