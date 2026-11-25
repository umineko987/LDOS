import { describe, expect, it, vi } from "vitest";

import { createApi } from "../client.ts";
import { ApiError } from "../errors.ts";
import {
  browseCollect,
  collectMediaUrl,
  createCollectSubmitTracker,
  resolveCollect,
  submitCollect,
  type CollectSubmitRequest,
} from "./collect.ts";

const origin = "http://127.0.0.1:8787";

function mockApi(...responses: Response[]) {
  const fetchImpl = vi.fn<(request: Request) => Promise<Response>>();
  for (const res of responses) fetchImpl.mockResolvedValueOnce(res);
  return { api: createApi(origin, { fetchImpl }), fetchImpl };
}

describe("collect api queries", () => {
  it("resolves, browses, and submits with idempotency header", async () => {
    const resolved = {
      resolved_mode: "keyword",
      sources: [
        {
          id: "danbooru:search:hatsune_miku",
          site: "danbooru",
          kind: "search",
          label: "hatsune_miku",
          query: "hatsune_miku",
          unit_kind: "post",
          default_mode: "top_n",
          default_top_n: 50,
        },
      ],
      site_statuses: [{ site: "danbooru", authorized: true, state: "ready", summary: "ok" }],
      warnings: [],
    };
    const browsed = {
      source: resolved.sources[0],
      items: [],
      next_cursor: "",
      warnings: [],
    };
    const submitted = {
      batch_id: "batch-42",
      queued_sources: 1,
      queued_count: 50,
      reused_count: 0,
      skipped_count: 0,
    };

    const { api, fetchImpl } = mockApi(
      Response.json(resolved),
      Response.json(browsed),
      Response.json(submitted),
    );

    expect(await resolveCollect(api, "ds/1", { input: "hatsune_miku", sites: ["danbooru"] })).toEqual(resolved);
    expect(await browseCollect(api, "ds/1", { source: resolved.sources[0], limit: 48 })).toEqual(browsed);

    const req: CollectSubmitRequest = {
      sources: [{ source: resolved.sources[0], range: { mode: "top_n", top_n: 50 } }],
    };
    expect(await submitCollect(api, "ds/1", req, "collect-key-1")).toEqual(submitted);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const submitCall = fetchImpl.mock.calls[2][0];
    expect(submitCall.url).toBe(`${origin}/api/v1/datasets/ds%2F1/collect/submit`);
    expect(submitCall.headers.get("Idempotency-Key")).toBe("collect-key-1");
  });

  it("propagates ApiError on failure", async () => {
    const { api } = mockApi(
      Response.json(
        { error: { code: "invalid_collect_input", message: "bad input", details: null, request_id: "req-1" } },
        { status: 422 },
      ),
    );
    await expect(resolveCollect(api, "ds-1", { input: "" })).rejects.toBeInstanceOf(ApiError);
  });

  it("restricts collectMediaUrl to local signed proxy paths", () => {
    const { api } = mockApi();
    expect(collectMediaUrl(api, "/api/v1/collect/media/abc.sig")).toBe(`${origin}/api/v1/collect/media/abc.sig`);
    expect(collectMediaUrl(api, "https://evil.example/a.jpg")).toBeNull();
    expect(collectMediaUrl(api, null)).toBeNull();
  });

  it("reuses idempotency key for identical payload retries and mints new keys on change", () => {
    let seq = 0;
    const tracker = createCollectSubmitTracker(() => `k-${++seq}`);
    const reqA: CollectSubmitRequest = {
      sources: [
        {
          source: { id: "s1", site: "pixiv", kind: "timeline", label: "A", unit_kind: "work", default_mode: "top_n" },
          range: { mode: "top_n", top_n: 50 },
        },
      ],
    };
    const reqB: CollectSubmitRequest = {
      sources: [
        {
          source: { id: "s1", site: "pixiv", kind: "timeline", label: "A", unit_kind: "work", default_mode: "top_n" },
          range: { mode: "top_n", top_n: 20 },
        },
      ],
    };

    expect(tracker.keyFor(reqA)).toBe("k-1");
    expect(tracker.keyFor(reqA)).toBe("k-1");
    expect(tracker.keyFor(reqB)).toBe("k-2");
    tracker.reset();
    expect(tracker.keyFor(reqB)).toBe("k-3");
  });
});
