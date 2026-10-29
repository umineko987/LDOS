import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  applyCaptionEdit,
  APPROVAL_PAGE_SIZE,
  captionBatchesQuery,
  captionKeys,
  captionOps,
  captionsFromTagger,
  captionsQuery,
  decideReview,
  DECISION_BATCH,
  editCaption,
  invalidateCaptions,
  reviewApprovalsQuery,
  setApproved,
  undoCaptionBatch,
  type CaptionList,
  type CaptionsSnapshot,
} from "./captions.ts";
import { datasetKeys } from "./datasets.ts";

const LIST: CaptionList = {
  dataset_id: "d1",
  trigger_word: "sks",
  etag: '"body"',
  items: [
    { asset_id: "a", name: "a.png", state: "normal", text: "sks, 1girl", tags: ["sks", "1girl"], version: "v1" },
    { asset_id: "b", name: "b.png", state: "missing", text: "", tags: [], version: "" },
  ],
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

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const pathname = (request: Request) => new URL(request.url).pathname;

const BATCH = {
  dataset_id: "d1",
  dry_run: false,
  batch_id: "b1",
  stats: { total: 1, changed: 1, new: 0, unchanged: 0, skipped: 0, conflicts: 0, written: 1, failed: 0 },
  samples: [],
  skipped: [],
  conflicts: [],
  failed: [],
};

describe("captionsQuery", () => {
  it("带上一次的 ETag；304 时沿用同一个缓存对象", async () => {
    let calls = 0;
    const { api, requests } = fakeApi(() => {
      calls += 1;
      return calls === 1 ? { status: 200, body: LIST, headers: { ETag: '"v1"' } } : { status: 304 };
    });
    const client = newClient();
    const first = await client.fetchQuery(captionsQuery(api, "d1"));
    expect(first).toEqual({ etag: '"v1"', list: LIST });
    expect(pathname(requests[0]!.request)).toBe("/api/v1/datasets/d1/captions");
    expect(requests[0]!.request.headers.get("If-None-Match")).toBeNull();

    const second = await client.fetchQuery({ ...captionsQuery(api, "d1"), staleTime: 0 });
    expect(requests[1]!.request.headers.get("If-None-Match")).toBe('"v1"');
    expect(second).toBe(first);
  });

  it("响应头没有 ETag 时用响应体里的", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: LIST }));
    expect((await newClient().fetchQuery(captionsQuery(api, "d1"))).etag).toBe('"body"');
    const { api: bare } = fakeApi(() => ({ status: 200, body: { ...LIST, etag: "" } }));
    expect((await newClient().fetchQuery(captionsQuery(bare, "d1"))).etag).toBeNull();
  });

  it("没有缓存时 304 照常抛出", async () => {
    const { api } = fakeApi(() => ({ status: 304 }));
    await expect(newClient().fetchQuery(captionsQuery(api, "d1"))).rejects.toMatchObject({ status: 304 });
  });
});

describe("captionBatchesQuery / reviewApprovalsQuery", () => {
  it("批次历史带 limit", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: { items: [] } }));
    await expect(newClient().fetchQuery(captionBatchesQuery(api, "d1", 5))).resolves.toEqual([]);
    const url = new URL(requests[0]!.request.url);
    expect(url.pathname).toBe("/api/v1/datasets/d1/caption-batches");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("已校对集合翻完所有页", async () => {
    const member = (asset_id: string) => ({ asset_id });
    const { api, requests } = fakeApi((request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      return cursor
        ? { status: 200, body: { items: [member("c")], next_cursor: null, total: 3, limit: APPROVAL_PAGE_SIZE } }
        : { status: 200, body: { items: [member("a"), member("b")], next_cursor: "2", total: 3, limit: APPROVAL_PAGE_SIZE } };
    });
    const ids = await newClient().fetchQuery(reviewApprovalsQuery(api, "d1"));
    expect([...ids]).toEqual(["a", "b", "c"]);
    const first = new URL(requests[0]!.request.url).searchParams;
    expect(first.get("stage")).toBe("review");
    expect(first.get("decision")).toBe("approved");
    expect(first.get("limit")).toBe(String(APPROVAL_PAGE_SIZE));
    expect(new URL(requests[1]!.request.url).searchParams.get("cursor")).toBe("2");
    // 放在成员列表前缀下，决定变了时一起失效。
    expect(captionKeys.approvals("d1").slice(0, 4)).toEqual([...datasetKeys.membersAll("d1")]);
  });
});

describe("写操作", () => {
  it("editCaption / captionOps / captionsFromTagger / undoCaptionBatch", async () => {
    const { api, requests } = fakeApi((request) => {
      const path = pathname(request);
      if (path.endsWith("/undo")) return { status: 200, body: { batch_id: "b1", dataset_id: "d1", stats: {}, conflicts: [], failed: [] } };
      if (request.method === "PUT") return { status: 200, body: { batch_id: "e1", caption: LIST.items[0] } };
      return { status: 200, body: BATCH };
    });
    await editCaption(api, "d1", "a/b", { text: "x", expected_version: "v1" });
    expect(pathname(requests[0]!.request)).toBe("/api/v1/datasets/d1/captions/a%2Fb");
    expect(requests[0]!.body).toEqual({ text: "x", expected_version: "v1" });

    await captionOps(api, "d1", { asset_ids: ["a"], ops: [{ op: "remove", tags: ["hat"] }], dry_run: true });
    expect(pathname(requests[1]!.request)).toBe("/api/v1/datasets/d1/captions/ops");
    expect(requests[1]!.body).toMatchObject({ dry_run: true });

    await captionsFromTagger(api, "d1", { models: ["wd"], mode: "merge" });
    expect(pathname(requests[2]!.request)).toBe("/api/v1/datasets/d1/captions/from-tagger");

    await undoCaptionBatch(api, "b1");
    expect(pathname(requests[3]!.request)).toBe("/api/v1/caption-batches/b1/undo");
  });

  it("decideReview 去重、分批，累计 updated", async () => {
    const funnel = { dataset_id: "d1", member_count: 1, stages: [] };
    const { api, requests } = fakeApi((_request, body) => ({
      status: 200,
      body: { updated: (body as { asset_ids: string[] }).asset_ids.length, funnel },
    }));
    const ids = Array.from({ length: DECISION_BATCH + 2 }, (_, index) => `a${index}`);
    const result = await decideReview(api, "d1", [...ids, "a0"], "approve");
    expect(result).toEqual({ updated: DECISION_BATCH + 2, funnel });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toMatchObject({ stage: "review", decision: "approve" });
    expect(await decideReview(api, "d1", [], "clear")).toBeNull();
  });
});

describe("缓存", () => {
  it("setApproved 乐观地改集合", () => {
    const client = newClient();
    setApproved(client, "d1", ["a", "b"], true);
    expect([...client.getQueryData<ReadonlySet<string>>(captionKeys.approvals("d1"))!]).toEqual(["a", "b"]);
    setApproved(client, "d1", ["a"], false);
    expect([...client.getQueryData<ReadonlySet<string>>(captionKeys.approvals("d1"))!]).toEqual(["b"]);
  });

  it("applyCaptionEdit 把新 caption 写进列表，丢掉旧 ETag", () => {
    const client = newClient();
    applyCaptionEdit(client, "d1", { batch_id: null, caption: { asset_id: "a", state: "normal", text: "x", tags: ["x"], version: "v2" } });
    expect(client.getQueryData(captionKeys.list("d1"))).toBeUndefined();
    client.setQueryData<CaptionsSnapshot>(captionKeys.list("d1"), { etag: '"v1"', list: LIST });
    applyCaptionEdit(client, "d1", { batch_id: "e1", caption: { asset_id: "b", state: "normal", text: "solo", tags: ["solo"], version: "v2" } });
    const snapshot = client.getQueryData<CaptionsSnapshot>(captionKeys.list("d1"))!;
    expect(snapshot.etag).toBeNull();
    expect(snapshot.list.items[0]).toBe(LIST.items[0]);
    expect(snapshot.list.items[1]).toMatchObject({ asset_id: "b", name: "b.png", state: "normal", text: "solo", tags: ["solo"], version: "v2" });
  });

  it("invalidateCaptions 让列表和批次都失效", async () => {
    const client = newClient();
    client.setQueryData(captionKeys.list("d1"), { etag: null, list: LIST });
    client.setQueryData(captionKeys.batches("d1"), []);
    await invalidateCaptions(client, "d1");
    expect(client.getQueryState(captionKeys.list("d1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(captionKeys.batches("d1"))?.isInvalidated).toBe(true);
  });
});
