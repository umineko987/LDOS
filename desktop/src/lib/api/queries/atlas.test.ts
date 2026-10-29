import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  addAtlasTags,
  ATLAS_ASSET_BATCH,
  ATLAS_POLL_MS,
  atlasJobId,
  atlasKeys,
  atlasQuery,
  atlasThumbnailPath,
  cancelAtlas,
  chunk,
  invalidateAtlas,
  parseTags,
  removeFromAtlas,
  restoreToAtlas,
  runAtlas,
  undoCaptionBatch,
  type AtlasResponse,
  type AtlasSnapshot,
} from "./atlas.ts";

const ATLAS: AtlasResponse = {
  dataset_id: "d1",
  status: "ready",
  availability: { available: true, reason: "" },
  cached: false,
  stale: false,
  current_digest: "digest",
  delta: { added: 0, changed: 0, removed_asset_ids: [] },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function fakeApi(reply: (request: Request, body: unknown) => Reply) {
  const requests: { request: Request; body: unknown }[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      const text = await request.clone().text();
      const body = text ? JSON.parse(text) : null;
      requests.push({ request, body });
      const result = reply(request, body);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json", ...result.headers },
      });
    },
  });
  return { api, requests };
}

const decision = (updated: number) => ({ updated, funnel: { dataset_id: "d1", member_count: 10, stages: [] } });

describe("atlasQuery", () => {
  it("带上一次的 ETag；304 时沿用同一个缓存对象", async () => {
    let calls = 0;
    const { api, requests } = fakeApi(() => {
      calls += 1;
      return calls === 1 ? { status: 200, body: ATLAS, headers: { ETag: 'W/"v1"' } } : { status: 304 };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = await client.fetchQuery(atlasQuery(api, "d1"));
    expect(first).toEqual({ etag: 'W/"v1"', atlas: ATLAS });
    expect(requests[0]!.request.headers.get("If-None-Match")).toBeNull();
    expect(new URL(requests[0]!.request.url).pathname).toBe("/api/v1/datasets/d1/atlas");

    const second = await client.fetchQuery({ ...atlasQuery(api, "d1"), staleTime: 0 });
    expect(requests[1]!.request.headers.get("If-None-Match")).toBe('W/"v1"');
    expect(second).toBe(first);
  });

  it("没有缓存时 304 和其他错误照常抛出", async () => {
    const { api } = fakeApi(() => ({ status: 304 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(atlasQuery(api, "d1"))).rejects.toMatchObject({ status: 304 });
  });

  it("运行中才轮询", () => {
    const { api } = fakeApi(() => ({ status: 200, body: ATLAS }));
    const interval = atlasQuery(api, "d1").refetchInterval as (query: { state: { data?: AtlasSnapshot } }) => unknown;
    expect(interval({ state: { data: { etag: null, atlas: { ...ATLAS, status: "running" } } } })).toBe(ATLAS_POLL_MS);
    expect(interval({ state: { data: { etag: null, atlas: ATLAS } } })).toBe(false);
    expect(interval({ state: {} })).toBe(false);
    expect(atlasKeys.detail("d1")).toEqual(["atlas", "d1"]);
    expect(atlasJobId("d1")).toBe("atlas:d1");
    expect(atlasThumbnailPath("a/1")).toBe("/api/v1/gallery/assets/a%2F1/thumbnail?size=256");
  });
});

describe("atlas actions", () => {
  it("运行和取消", async () => {
    const { api, requests } = fakeApi(() => ({ status: 202, body: ATLAS }));
    await runAtlas(api, "d1", { force: true });
    await runAtlas(api, "d1");
    await cancelAtlas(api, "d1");
    expect(requests.map(({ request, body }) => [request.method, new URL(request.url).pathname, body])).toEqual([
      ["POST", "/api/v1/datasets/d1/atlas/run", { force: true }],
      ["POST", "/api/v1/datasets/d1/atlas/run", { force: false }],
      ["POST", "/api/v1/datasets/d1/atlas/cancel", null],
    ]);
  });

  it("移除和恢复去重后按批提交，累计 updated", async () => {
    const { api, requests } = fakeApi((_request, body) => ({
      status: 200,
      body: decision((body as { asset_ids: string[] }).asset_ids.length),
    }));
    const ids = Array.from({ length: ATLAS_ASSET_BATCH + 2 }, (_, index) => `a${index}`);
    const result = await removeFromAtlas(api, "d1", [...ids, "a0"]);
    expect(result?.updated).toBe(ATLAS_ASSET_BATCH + 2);
    expect(requests.map(({ body }) => (body as { asset_ids: string[] }).asset_ids.length)).toEqual([ATLAS_ASSET_BATCH, 2]);
    expect(new URL(requests[0]!.request.url).pathname).toBe("/api/v1/datasets/d1/atlas/remove");

    await restoreToAtlas(api, "d1", ["a1"]);
    expect(new URL(requests[2]!.request.url).pathname).toBe("/api/v1/datasets/d1/atlas/restore");
    expect(await removeFromAtlas(api, "d1", [])).toBeNull();
    expect(requests).toHaveLength(3);
  });

  it("加标签走 captions/ops 的 add；撤销走 caption-batches", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: {} }));
    await addAtlasTags(api, "d1", ["a1", "a2"], ["night", "rain"], true);
    await undoCaptionBatch(api, "b1");
    expect(requests[0]!.body).toEqual({
      asset_ids: ["a1", "a2"],
      ops: [{ op: "add", tags: ["night", "rain"], position: "back" }],
      dry_run: true,
      sample_limit: 5,
    });
    expect(new URL(requests[1]!.request.url).pathname).toBe("/api/v1/caption-batches/b1/undo");
  });

  it("解析标签：逗号分隔、合并空白、去重", () => {
    expect(parseTags(" night ,  rainy  day，night\n\n")).toEqual(["night", "rainy day"]);
    expect(parseTags("x".repeat(513))).toEqual([]);
    expect(parseTags(Array.from({ length: 300 }, (_, index) => `t${index}`).join(","))).toHaveLength(200);
  });

  it("分批和失效", async () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunk([], 2)).toEqual([]);
    const client = new QueryClient();
    client.setQueryData(atlasKeys.detail("d1"), { etag: null, atlas: ATLAS });
    await invalidateAtlas(client, "d1");
    expect(client.getQueryState(atlasKeys.detail("d1"))?.isInvalidated).toBe(true);
  });
});
