import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  displayTarget,
  sanitizeTaskEvents,
  sanitizeTaskList,
  sanitizeTaskLogs,
  taskEventsQuery,
  taskKeys,
  taskLogsQuery,
  tasksQuery,
} from "./tasks.ts";

function apiReturning(payload: unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

function fetchWith<T>(options: { queryKey: readonly unknown[]; queryFn?: unknown }): Promise<T> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return client.fetchQuery(options as never) as Promise<T>;
}

describe("displayTarget", () => {
  it("只保留主机和路径", () => {
    expect(displayTarget("https://danbooru.donmai.us/posts?tags=frieren&api_key=secret")).toBe("danbooru.donmai.us/posts");
    expect(displayTarget("https://example.com/")).toBe("example.com");
    expect(displayTarget("https://example.com/%E5%9B%BE")).toBe("example.com/图");
    expect(displayTarget("https://example.com/%E5")).toBe("example.com/%E5");
    expect(displayTarget("file:///etc/passwd")).toBe("");
    expect(displayTarget("not a url")).toBe("");
    expect(displayTarget(3)).toBe("");
  });
});

describe("task sanitizers", () => {
  it("sanitizeTaskList", () => {
    const list = sanitizeTaskList({
      items: [
        {
          id: "t1",
          site: "pixiv",
          status: "failed",
          url: "https://www.pixiv.net/artworks/1?lang=ja",
          created_at: 1_700_000_000,
          finished_at: 1_700_000_100,
          attempt_count: 3,
          max_attempts: 3,
          artifact_count: 0,
          artifact_bytes: 0,
          last_error_class: "auth_expired",
          last_error: "HTTP 403\nforbidden",
        },
        { id: "" },
      ],
    });
    expect(list).toEqual([
      {
        id: "t1",
        site: "pixiv",
        status: "failed",
        target: "www.pixiv.net/artworks/1",
        createdAt: 1_700_000_000,
        finishedAt: 1_700_000_100,
        attempts: 3,
        maxAttempts: 3,
        artifactCount: 0,
        artifactBytes: 0,
        errorClass: "auth_expired",
        lastError: "HTTP 403 forbidden",
      },
    ]);
    expect(() => sanitizeTaskList(null)).toThrow("invalid_task_list");
    expect(sanitizeTaskList({ items: "x" })).toEqual([]);
  });

  it("sanitizeTaskLogs 保留缩进、去掉控制字符", () => {
    expect(
      sanitizeTaskLogs({
        items: [
          { id: 1, ts: 1_700_000_000, stream: "stderr", line: "\tdownloading\u0007 1.jpg" },
          { id: 2, stream: "backend", line: "proxy acquired" },
          { id: 3, stream: "weird", line: 5 },
        ],
      }),
    ).toEqual([
      { id: 1, ts: 1_700_000_000, stream: "stderr", line: "  downloading 1.jpg" },
      { id: 2, ts: null, stream: "backend", line: "proxy acquired" },
      { id: 3, ts: null, stream: "stdout", line: "" },
    ]);
    expect(() => sanitizeTaskLogs("x")).toThrow("invalid_task_logs");
  });

  it("sanitizeTaskEvents 丢掉类型不合法的事件", () => {
    expect(
      sanitizeTaskEvents({ items: [{ id: 1, ts: 1, event_type: "queued", payload: { secret: 1 } }, { id: 2, event_type: "Bad Type" }] }),
    ).toEqual([{ id: 1, ts: 1, type: "queued" }]);
    expect(() => sanitizeTaskEvents(undefined)).toThrow("invalid_task_events");
  });
});

describe("task queries", () => {
  it("列表按筛选传 status；日志取尾部；事件按任务", async () => {
    const all = apiReturning({ items: [] });
    await fetchWith(tasksQuery(all.api, "all"));
    expect(new URL(all.requests[0]!.url).search).toBe("?limit=100");

    const failed = apiReturning({ items: [] });
    await fetchWith(tasksQuery(failed.api, "failed"));
    expect(new URL(failed.requests[0]!.url).searchParams.get("status")).toBe("failed");

    const logs = apiReturning({ items: [{ id: 1, line: "x" }] });
    expect(await fetchWith(taskLogsQuery(logs.api, "t1"))).toHaveLength(1);
    expect(new URL(logs.requests[0]!.url).pathname).toBe("/api/v1/tasks/t1/logs");
    expect(new URL(logs.requests[0]!.url).searchParams.get("tail")).toBe("300");

    const events = apiReturning({ items: [] });
    await fetchWith(taskEventsQuery(events.api, "t1"));
    expect(new URL(events.requests[0]!.url).pathname).toBe("/api/v1/tasks/t1/events");
  });

  it("key 工厂", () => {
    expect(taskKeys.list("running")).toEqual(["tasks", "list", "running"]);
    expect(taskKeys.logs("t")).toEqual(["tasks", "logs", "t"]);
    expect(taskKeys.events("t")).toEqual(["tasks", "events", "t"]);
  });
});
