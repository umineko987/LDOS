import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  addDatasetRoot,
  applyFunnel,
  createDataset,
  datasetCrawlsQuery,
  datasetDetailQuery,
  datasetFunnelQuery,
  datasetHashingQuery,
  datasetInvalidation,
  datasetKeys,
  datasetListQuery,
  datasetMembersQuery,
  datasetRootsQuery,
  datasetStageRunsQuery,
  decideMembers,
  deleteDataset,
  invalidateForDatasetEvent,
  removeDatasetRoot,
  startDatasetCrawl,
  startHashing,
  updateDataset,
  type DatasetDetail,
  type DatasetFunnel,
} from "./datasets.ts";

function fakeApi(reply: (request: Request) => { status?: number; body?: unknown }) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request.clone());
      const { status = 200, body = {} } = reply(request);
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const url = (request: Request) => new URL(request.url);

const FUNNEL: DatasetFunnel = {
  dataset_id: "ds1",
  member_count: 24,
  stages: [
    { stage: "collect", input: 24, excluded: 2, approved: 0, output: 22, status: "idle", stale: false, last_run: null },
    { stage: "dedup", input: 22, excluded: 0, approved: 0, output: 22, status: "idle", stale: false, last_run: null },
    { stage: "export", input: 22, excluded: 0, approved: 0, output: 20, status: "idle", stale: true, last_run: null },
  ],
} as unknown as DatasetFunnel;

const DETAIL = {
  id: "ds1",
  name: "角色 A",
  kind: "character",
  member_count: 24,
  output_count: 24,
  funnel: [],
  stage_outputs: [],
} as unknown as DatasetDetail;

describe("datasetKeys", () => {
  it("一个数据集的子资源都在 item 前缀下", () => {
    expect(datasetKeys.list()).toEqual(["datasets", "list"]);
    expect(datasetKeys.detail("a")).toEqual(["datasets", "item", "a", "detail"]);
    expect(datasetKeys.members("a")).toEqual([
      "datasets",
      "item",
      "a",
      "members",
      { stage: null, decision: null, query: "" },
    ]);
    // 没有阶段时决定过滤无效；查询词去掉首尾空白。
    expect(datasetKeys.members("a", { decision: "excluded", query: "  cat " })).toEqual(
      datasetKeys.members("a", { query: "cat" }),
    );
    expect(datasetKeys.members("a", { stage: "collect", decision: "excluded" }).at(-1)).toEqual({
      stage: "collect",
      decision: "excluded",
      query: "",
    });
    expect(datasetKeys.stageRuns("a")).toEqual(["datasets", "item", "a", "stage-runs", null]);
    expect(datasetKeys.stageRuns("a", "dedup").at(-1)).toBe("dedup");
  });
});

describe("dataset queries", () => {
  it("列表、根目录、阶段运行、采集取 items", async () => {
    const { api, requests } = fakeApi(() => ({ body: { items: [{ id: "x" }] } }));
    const queries = client();
    await expect(queries.fetchQuery(datasetListQuery(api))).resolves.toEqual([{ id: "x" }]);
    await expect(queries.fetchQuery(datasetRootsQuery(api, "ds1"))).resolves.toEqual([{ id: "x" }]);
    await expect(queries.fetchQuery(datasetStageRunsQuery(api, "ds1", "dedup", 5))).resolves.toEqual([{ id: "x" }]);
    await expect(queries.fetchQuery(datasetStageRunsQuery(api, "ds1"))).resolves.toEqual([{ id: "x" }]);
    await expect(queries.fetchQuery(datasetCrawlsQuery(api, "ds1"))).resolves.toEqual([{ id: "x" }]);
    expect(requests.map((request) => url(request).pathname)).toEqual([
      "/api/v1/datasets",
      "/api/v1/datasets/ds1/roots",
      "/api/v1/datasets/ds1/stage-runs",
      "/api/v1/datasets/ds1/stage-runs",
      "/api/v1/datasets/ds1/crawls",
    ]);
    expect(url(requests[2]!).searchParams.get("stage")).toBe("dedup");
    expect(url(requests[2]!).searchParams.get("limit")).toBe("5");
    expect(url(requests[3]!).searchParams.has("stage")).toBe(false);
  });

  it("详情、漏斗、哈希原样返回", async () => {
    const { api, requests } = fakeApi((request) => ({ body: { path: url(request).pathname } }));
    const queries = client();
    await expect(queries.fetchQuery(datasetDetailQuery(api, "ds1"))).resolves.toEqual({ path: "/api/v1/datasets/ds1" });
    await expect(queries.fetchQuery(datasetFunnelQuery(api, "ds1"))).resolves.toEqual({
      path: "/api/v1/datasets/ds1/funnel",
    });
    await expect(queries.fetchQuery(datasetHashingQuery(api, "ds1"))).resolves.toEqual({
      path: "/api/v1/datasets/ds1/hashing",
    });
    expect(requests).toHaveLength(3);
  });

  it("成员按游标翻页，过滤条件进查询参数", async () => {
    const { api, requests } = fakeApi((request) => {
      const cursor = url(request).searchParams.get("cursor");
      return { body: cursor ? { items: [{ id: "m2" }], next_cursor: null } : { items: [{ id: "m1" }], next_cursor: "c2" } };
    });
    const queries = client();
    const options = datasetMembersQuery(api, "ds1", { stage: "collect", decision: "excluded", query: " cat " }, 1);
    await queries.fetchInfiniteQuery(options);
    await queries.fetchInfiniteQuery({ ...options, pages: 2 });
    const pages = queries.getQueryData(options.queryKey)?.pages ?? [];
    expect(pages.flatMap((page) => page.items)).toEqual([{ id: "m1" }, { id: "m2" }]);
    expect(options.getNextPageParam(pages[1]!, pages, null, [])).toBeUndefined();
    const first = url(requests[0]!).searchParams;
    expect(Object.fromEntries(first)).toEqual({ stage: "collect", decision: "excluded", query: "cat", limit: "1" });
    expect(url(requests.at(-1)!).searchParams.get("cursor")).toBe("c2");

    const plain = fakeApi(() => ({ body: { items: [], next_cursor: null } }));
    await client().fetchInfiniteQuery(datasetMembersQuery(plain.api, "ds1"));
    expect(Object.fromEntries(url(plain.requests[0]!).searchParams)).toEqual({ limit: "200" });
  });
});

describe("dataset mutations", () => {
  it("每个写操作打到对应的方法和路径", async () => {
    const { api, requests } = fakeApi((request) => ({
      status: request.method === "DELETE" ? 204 : 200,
      body: { method: request.method },
    }));
    await expect(createDataset(api, { name: "A", kind: "style" } as never)).resolves.toEqual({ method: "POST" });
    await expect(updateDataset(api, "ds1", { trigger_word: "abc" } as never)).resolves.toEqual({ method: "PATCH" });
    await expect(deleteDataset(api, "ds1")).resolves.toBeUndefined();
    await expect(addDatasetRoot(api, "ds1", { path: "/pics" } as never)).resolves.toEqual({ method: "POST" });
    await expect(removeDatasetRoot(api, "ds1", "r1")).resolves.toBeUndefined();
    await expect(decideMembers(api, "ds1", { stage: "collect", decision: "excluded" } as never)).resolves.toEqual({
      method: "POST",
    });
    await expect(startHashing(api, "ds1")).resolves.toEqual({ method: "POST" });
    await expect(startDatasetCrawl(api, "ds1", { sources: [] } as never, "crawl-key-0001")).resolves.toEqual({
      method: "POST",
    });
    expect(requests.map((request) => `${request.method} ${url(request).pathname}`)).toEqual([
      "POST /api/v1/datasets",
      "PATCH /api/v1/datasets/ds1",
      "DELETE /api/v1/datasets/ds1",
      "POST /api/v1/datasets/ds1/roots",
      "DELETE /api/v1/datasets/ds1/roots/r1",
      "POST /api/v1/datasets/ds1/decisions",
      "POST /api/v1/datasets/ds1/hashing",
      "POST /api/v1/datasets/ds1/crawls",
    ]);
    expect(await requests[0]!.json()).toEqual({ name: "A", kind: "style" });
    expect(requests.at(-1)!.headers.get("Idempotency-Key")).toBe("crawl-key-0001");
  });

  it("失败抛 ApiError", async () => {
    const { api } = fakeApi(() => ({ status: 409, body: { error: { code: "dataset_name_taken", message: "重名" } } }));
    await expect(createDataset(api, { name: "A", kind: "style" } as never)).rejects.toMatchObject({
      status: 409,
      code: "dataset_name_taken",
    });
    await expect(deleteDataset(api, "ds1")).rejects.toMatchObject({ status: 409 });
  });
});

describe("applyFunnel", () => {
  it("写入漏斗，并更新已有详情的计数", () => {
    const queries = client();
    queries.setQueryData(datasetKeys.detail("ds1"), DETAIL);
    applyFunnel(queries, FUNNEL);
    expect(queries.getQueryData(datasetKeys.funnel("ds1"))).toBe(FUNNEL);
    expect(queries.getQueryData<DatasetDetail>(datasetKeys.detail("ds1"))).toMatchObject({
      name: "角色 A",
      member_count: 24,
      output_count: 20,
      funnel: FUNNEL.stages,
      stage_outputs: [
        { stage: "collect", output: 22, stale: false },
        { stage: "dedup", output: 22, stale: false },
        { stage: "export", output: 20, stale: true },
      ],
    });
  });

  it("没有详情缓存时不凭空造一个；空漏斗保留原输出数", () => {
    const queries = client();
    applyFunnel(queries, FUNNEL);
    expect(queries.getQueryData(datasetKeys.detail("ds1"))).toBeUndefined();
    queries.setQueryData(datasetKeys.detail("ds1"), DETAIL);
    applyFunnel(queries, { ...FUNNEL, stages: [] });
    expect(queries.getQueryData<DatasetDetail>(datasetKeys.detail("ds1"))?.output_count).toBe(24);
  });
});

describe("dataset invalidation", () => {
  const ALWAYS = [
    datasetKeys.list(),
    datasetKeys.detail("ds1"),
    datasetKeys.funnel("ds1"),
    datasetKeys.stageRunsAll("ds1"),
  ];
  const MEMBERS = [
    datasetKeys.roots("ds1"),
    datasetKeys.hashing("ds1"),
    datasetKeys.crawls("ds1"),
    datasetKeys.membersAll("ds1"),
  ];

  it("按事件和原因选键", () => {
    expect(datasetInvalidation("resync", { last_event_id: "1", reason: "gap" })).toEqual([datasetKeys.all]);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1", reason: "deleted" })).toEqual([
      datasetKeys.list(),
      datasetKeys.dataset("ds1"),
    ]);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1", reason: "updated" })).toEqual(ALWAYS);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1", reason: "captions" })).toEqual(ALWAYS);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1", reason: "hashing" })).toEqual([
      ...ALWAYS,
      datasetKeys.hashing("ds1"),
    ]);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1", reason: "decisions" })).toEqual([
      ...ALWAYS,
      ...MEMBERS,
    ]);
    expect(datasetInvalidation("dataset.updated", { dataset_id: "ds1" })).toEqual([...ALWAYS, ...MEMBERS]);
    expect(
      datasetInvalidation("dataset.stage.updated", { dataset_id: "ds1", stage: "dedup", status: "succeeded" }),
    ).toEqual([...ALWAYS, ...MEMBERS]);
  });

  it("删除时移除缓存，其余只标记失效", () => {
    const queries = client();
    queries.setQueryData(datasetKeys.detail("ds1"), DETAIL);
    queries.setQueryData(datasetKeys.roots("ds1"), []);
    queries.setQueryData(datasetKeys.list(), []);
    queries.setQueryData(datasetKeys.detail("ds2"), DETAIL);

    invalidateForDatasetEvent(queries, "dataset.updated", { dataset_id: "ds1", reason: "updated" });
    expect(queries.getQueryState(datasetKeys.detail("ds1"))?.isInvalidated).toBe(true);
    expect(queries.getQueryState(datasetKeys.roots("ds1"))?.isInvalidated).toBe(false);
    expect(queries.getQueryState(datasetKeys.detail("ds2"))?.isInvalidated).toBe(false);

    invalidateForDatasetEvent(queries, "dataset.updated", { dataset_id: "ds1", reason: "deleted" });
    expect(queries.getQueryData(datasetKeys.detail("ds1"))).toBeUndefined();
    expect(queries.getQueryData(datasetKeys.roots("ds1"))).toBeUndefined();
    expect(queries.getQueryState(datasetKeys.list())?.isInvalidated).toBe(true);
    expect(queries.getQueryData(datasetKeys.detail("ds2"))).toBe(DETAIL);
  });
});
