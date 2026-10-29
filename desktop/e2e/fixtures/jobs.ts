// 实时任务的模拟：/api/v1/jobs 快照和 /api/v1/events 的 SSE 流，外加采集批次、下载任务的样例数据。
// 外壳一挂载就会连 SSE；不模拟的话请求落到 Vite，EventSource 因为 MIME 不对报 console.error。

import type { Page } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { mockApi } from "./api";

type Schemas = components["schemas"];
export type Job = Schemas["JobResponse"];

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
}

/** 一段有限的 SSE 正文；流结束后客户端按自己的退避重连。 */
export function sseBody(events: readonly SseEvent[]): string {
  return events
    .map(({ event, data, id }) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

/**
 * 模拟 /api/v1/events。第一次连接收到 `events`，之后的重连只拿到空流。
 * 返回每次连接的完整 URL（检查 `last_event_id` 用）。
 */
export async function mockEvents(page: Page, events: readonly SseEvent[] = []): Promise<string[]> {
  const urls: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/v1/events",
    async (route) => {
      urls.push(route.request().url());
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `: ldos e2e\n\n${sseBody(urls.length === 1 ? events : [])}`,
      });
    },
  );
  return urls;
}

export async function mockJobs(page: Page, items: readonly Job[] = [], lastEventId = "e2e-0"): Promise<void> {
  await mockApi(page, "get", "/api/v1/jobs", { items: [...items], last_event_id: lastEventId });
}

/** 默认：没有任务，SSE 连上后什么也不发。 */
export async function mockQuietRealtime(page: Page): Promise<void> {
  await mockJobs(page);
  await mockEvents(page);
}

const NOW = Math.floor(Date.now() / 1000);

export function job(overrides: Partial<Job> & Pick<Job, "id" | "kind">): Job {
  return {
    title: overrides.kind,
    status: "running",
    current: null,
    total: null,
    message: "",
    ref: {},
    started_at: NOW - 42,
    updated_at: NOW - 1,
    finished_at: null,
    ...overrides,
  };
}

export const CRAWL_JOB = job({
  id: "crawl:batch-7",
  kind: "crawl.batch",
  title: "采集批次 batch-7",
  current: 6,
  total: 10,
  message: "1 个任务失败",
  ref: { batch_id: "batch-7" },
});

export const CRAWL_LIST: Schemas["CrawlBatchListResponse"] = {
  items: [
    { id: "batch-7", status: "running", created_at: NOW - 600 },
    { id: "batch-6", status: "completed_with_errors", created_at: NOW - 7_200 },
  ],
};

export const CRAWL_BATCH: Schemas["CrawlBatchResponse"] = {
  response_profile: "desktop-crawl-v1",
  id: "batch-7",
  status: "running",
  created_at: NOW - 600,
  updated_at: NOW - 5,
  finished_at: null,
  cancel_requested: false,
  concurrency: 2,
  max_tasks: 400,
  task_count: 10,
  succeeded_task_count: 5,
  failed_task_count: 1,
  cancelled_task_count: 0,
  pre_dedup_skipped_count: 3,
  resumable: true,
  current: { address_id: "a2", site: "danbooru", source_order: 0, address_order: 1, status: "running" },
  sources: [
    {
      order: 0,
      site: "danbooru",
      status: "running",
      pre_dedup_skipped_count: 3,
      addresses: [
        {
          id: "a1",
          address_order: 0,
          label: "frieren rating:g",
          address_type: "search",
          status: "succeeded",
          planned_task_count: 4,
          succeeded_task_count: 4,
          failed_task_count: 0,
          cancelled_task_count: 0,
          pre_dedup_skipped_count: 1,
          planning_error: "",
        },
        {
          id: "a2",
          address_order: 1,
          label: "fern rating:g",
          address_type: "search",
          status: "running",
          planned_task_count: 6,
          succeeded_task_count: 1,
          failed_task_count: 1,
          cancelled_task_count: 0,
          pre_dedup_skipped_count: 2,
          planning_error: "",
        },
      ],
    },
  ],
  address_rows_truncated: false,
  review: null,
};

export const CRAWL_TASKS: Schemas["CrawlTaskListResponse"] = {
  items: [
    { id: "task-1", site: "danbooru", status: "succeeded", sequence_no: 1, attempt_count: 1, max_attempts: 3, crawl_address_id: "a1" },
    { id: "task-2", site: "danbooru", status: "failed", sequence_no: 2, attempt_count: 3, max_attempts: 3, crawl_address_id: "a2", last_error_class: "network_timeout" },
    { id: "task-3", site: "danbooru", status: "running", sequence_no: 3, attempt_count: 1, max_attempts: 3, crawl_address_id: "a2" },
  ],
};

export const TASK_LOGS: Schemas["TaskLogListResponse"] = {
  items: [
    { id: 1, task_id: "task-2", ts: NOW - 60, stream: "backend", line: "proxy acquired" },
    { id: 2, task_id: "task-2", ts: NOW - 59, stream: "stderr", line: "[danbooru][error] HTTP 504 Gateway Timeout" },
  ],
};

export const TASK_EVENTS: Schemas["TaskEventListResponse"] = {
  items: [
    { id: 1, task_id: "task-2", ts: NOW - 61, event_type: "queued" },
    { id: 2, task_id: "task-2", ts: NOW - 60, event_type: "attempt_started" },
  ],
};

export const DOWNLOAD_TASKS: Schemas["TaskListResponse"] = {
  items: [
    {
      id: "task-9",
      site: "pixiv",
      status: "failed",
      url: "https://www.pixiv.net/artworks/1?token=secret",
      created_at: NOW - 300,
      attempt_count: 3,
      max_attempts: 3,
      last_error_class: "auth_expired",
      last_error: "HTTP 403",
    },
    { id: "task-8", site: "danbooru", status: "succeeded", url: "https://danbooru.donmai.us/posts/1", created_at: NOW - 900, attempt_count: 1, max_attempts: 3 },
  ],
};
