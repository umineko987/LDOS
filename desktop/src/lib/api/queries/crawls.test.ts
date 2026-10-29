import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  CRAWL_TASK_PAGE,
  crawlBatchesQuery,
  crawlBatchQuery,
  crawlKeys,
  crawlTasksQuery,
  isActiveBatchStatus,
  isTerminalBatchStatus,
  isTerminalTaskStatus,
  runCrawlOperation,
  sanitizeBatch,
  sanitizeBatchList,
  sanitizeCrawlTaskPage,
  validBatchId,
} from "./crawls.ts";

function apiReturning(payload: unknown, status = 200) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

function fetchWith<T>(options: { queryKey: readonly unknown[]; queryFn?: unknown }): Promise<T> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return client.fetchQuery(options as never) as Promise<T>;
}

const BATCH = {
  id: "batch-1",
  status: "running",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  finished_at: null,
  cancel_requested: false,
  concurrency: 2,
  max_tasks: 400,
  task_count: 10,
  succeeded_task_count: 6,
  failed_task_count: 1,
  cancelled_task_count: 0,
  pre_dedup_skipped_count: 3,
  resumable: true,
  current: { address_id: "a1", site: "danbooru", source_order: 0, address_order: 1, status: "running" },
  sources: [
    {
      order: 0,
      site: "danbooru",
      status: "running",
      pre_dedup_skipped_count: 3,
      addresses: [
        {
          id: "a1",
          address_order: 1,
          label: "frieren rating:g",
          address_type: "search",
          status: "running",
          planned_task_count: 10,
          succeeded_task_count: 6,
          failed_task_count: 1,
          cancelled_task_count: 0,
          pre_dedup_skipped_count: 3,
          planning_error: "",
        },
        "broken",
      ],
    },
  ],
  address_rows_truncated: false,
  review: { status: "not_started", total_image_count: 0, duplicate_group_count: 0, decided_group_count: 0, total_group_count: 0 },
  response_profile: "desktop-crawl-v1",
};

describe("crawl sanitizers", () => {
  it("sanitizeBatchList 跳过没有合法 id 的条目，计数字段可缺省", () => {
    const list = sanitizeBatchList({
      items: [
        { id: "b1", status: "succeeded", created_at: 1_700_000_000 },
        { id: "b2", status: "Weird Status", task_count: 4, succeeded_task_count: 3, failed_task_count: 1 },
        { id: "../b3" },
        "x",
      ],
    });
    expect(list).toEqual([
      { id: "b1", status: "succeeded", createdAt: 1_700_000_000, taskCount: null, succeeded: null, failed: null },
      { id: "b2", status: "unknown", createdAt: null, taskCount: 4, succeeded: 3, failed: 1 },
    ]);
    expect(sanitizeBatchList({})).toEqual([]);
    expect(() => sanitizeBatchList(null)).toThrow("invalid_crawl_list");
  });

  it("sanitizeBatch 读出摘要、来源、地址和审核", () => {
    const batch = sanitizeBatch(BATCH);
    expect(batch).toMatchObject({
      id: "batch-1",
      status: "running",
      taskCount: 10,
      succeeded: 6,
      failed: 1,
      preDedupSkipped: 3,
      resumable: true,
      current: { addressId: "a1", site: "danbooru", addressOrder: 1, status: "running" },
      review: { status: "not_started", totalImages: 0 },
    });
    expect(batch.sources[0]!.addresses).toEqual([
      {
        id: "a1",
        order: 1,
        label: "frieren rating:g",
        type: "search",
        status: "running",
        planned: 10,
        succeeded: 6,
        failed: 1,
        cancelled: 0,
        preDedupSkipped: 3,
        planningError: "",
      },
    ]);
    const bare = sanitizeBatch({ id: "b" });
    expect(bare.current).toBeNull();
    expect(bare.review).toBeNull();
    expect(bare.sources).toEqual([]);
    expect(() => sanitizeBatch({ id: "" })).toThrow("invalid_crawl_batch");
    expect(() => sanitizeBatch("x")).toThrow("invalid_crawl_batch");
  });

  it("sanitizeCrawlTaskPage 标出是否可能还有下一页", () => {
    const page = sanitizeCrawlTaskPage(
      {
        items: [
          {
            id: "t1",
            site: "danbooru",
            status: "failed",
            sequence_no: 4,
            attempt_count: 2,
            max_attempts: 3,
            crawl_address_id: "a1",
            artifact_count: 0,
            artifact_bytes: 0,
            last_error_class: "network_timeout",
          },
          { id: "" },
        ],
      },
      0,
    );
    expect(page.hasMore).toBe(false);
    expect(page.items).toEqual([
      {
        id: "t1",
        site: "danbooru",
        status: "failed",
        sourceOrder: 0,
        addressOrder: 0,
        sequence: 4,
        attempts: 2,
        maxAttempts: 3,
        addressId: "a1",
        artifactCount: 0,
        artifactBytes: 0,
        errorClass: "network_timeout",
      },
    ]);
    const full = sanitizeCrawlTaskPage({ items: Array.from({ length: CRAWL_TASK_PAGE }, (_, index) => ({ id: `t${index}` })) }, 100);
    expect(full.hasMore).toBe(true);
    expect(full.offset).toBe(100);
    expect(() => sanitizeCrawlTaskPage(null, 0)).toThrow("invalid_crawl_tasks");
  });

  it("状态分类和 id 校验", () => {
    expect(isActiveBatchStatus("planning")).toBe(true);
    expect(isActiveBatchStatus("completed_with_errors")).toBe(false);
    expect(isTerminalBatchStatus("completed_with_errors")).toBe(true);
    expect(isTerminalBatchStatus("planning")).toBe(false);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(validBatchId("b-1")).toBe("b-1");
    expect(validBatchId("b/1")).toBeNull();
  });
});

describe("crawl queries", () => {
  it("列表、详情、任务页都请求安全投影", async () => {
    const list = apiReturning({ items: [{ id: "b1", status: "running" }] });
    expect(await fetchWith(crawlBatchesQuery(list.api))).toHaveLength(1);
    expect(new URL(list.requests[0]!.url).search).toBe("?view=desktop&limit=100");

    const detail = apiReturning(BATCH);
    expect((await fetchWith<{ id: string }>(crawlBatchQuery(detail.api, "batch-1"))).id).toBe("batch-1");
    expect(new URL(detail.requests[0]!.url).pathname).toBe("/api/v1/crawls/batch-1");
    expect(new URL(detail.requests[0]!.url).searchParams.get("view")).toBe("desktop");

    const tasks = apiReturning({ items: [] });
    await fetchWith(crawlTasksQuery(tasks.api, "batch-1", 200));
    const url = new URL(tasks.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/crawls/batch-1/tasks");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "tasks", limit: "100", offset: "200" });
  });

  it("key 工厂按批次和页偏移区分", () => {
    expect(crawlKeys.taskPage("b", 100)).toEqual(["crawls", "tasks", "b", 100]);
    expect(crawlKeys.detail("b")).toEqual(["crawls", "detail", "b"]);
    expect(crawlKeys.list(50)).toEqual(["crawls", "list", 50]);
  });

  it("取消、重试、重新运行打到对应接口", async () => {
    const { api, requests } = apiReturning({ response_profile: "desktop-crawl-operation-v1", id: "b1", status: "running" });
    await runCrawlOperation(api, "b1", "cancel");
    await runCrawlOperation(api, "b1", "retry");
    await runCrawlOperation(api, "b1", "rerun");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/crawls/b1/cancel",
      "/api/v1/crawls/b1/retry",
      "/api/v1/crawls/b1/rerun",
    ]);
    expect(await requests[1]!.text()).toBe('{"additional_attempts":2}');
    expect(await requests[2]!.text()).toBe('{"additional_attempts":1,"requeue_succeeded":false}');
  });
});
