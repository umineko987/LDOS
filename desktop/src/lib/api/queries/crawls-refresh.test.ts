import { QueryClient, QueryObserver } from "@tanstack/svelte-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApi } from "../client.ts";
import { ApiError } from "../errors.ts";
import { crawlBatchQuery, crawlKeys, crawlTasksQuery } from "./crawls.ts";

// TanStack computes isServer at import time; Node otherwise disables observer timers.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function snapshots(...responses: Response[]) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("unexpected refresh");
      return response;
    },
  });
  return { api, requests };
}

function controlledApi() {
  const pending: { request: Request; respond: (body: unknown) => void }[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    // Deliberately allow a transport to finish after cancellation.
    fetchImpl: (request) => new Promise<Response>((resolve) => {
      pending.push({ request, respond: (body) => resolve(json(body)) });
    }),
  });
  return { api, pending };
}

const batch = (status: string, succeeded = 0) => ({
  id: "batch-a", status, task_count: 3, succeeded_task_count: succeeded,
});
const taskPage = (...statuses: string[]) => ({
  items: statuses.map((status, index) => ({
    id: `task-${index}`, status, sequence_no: index + 1,
    artifact_count: status === "succeeded" ? 1 : 0,
    last_error_class: status === "failed" ? "network_timeout" : "",
  })),
});

let client: QueryClient;
let cleanups: (() => void)[];

function observe<T extends { subscribe: (listener: () => void) => () => void; destroy: () => void }>(observer: T): T {
  cleanups.push(() => observer.destroy());
  observer.subscribe(() => {});
  return observer;
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 5_000, refetchOnWindowFocus: false } },
  });
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  client.clear();
  vi.useRealTimers();
});

afterAll(() => vi.unstubAllGlobals());

describe("crawl subscriptions reconcile without events", () => {
  it.each(["succeeded", "completed_with_errors", "failed", "cancelled"])(
    "requests queued/running snapshots and stops at %s",
    async (terminal) => {
      const { api, requests } = snapshots(json(batch("queued")), json(batch("running", 1)), json(batch(terminal, 2)));
      const observer = observe(new QueryObserver(client, crawlBatchQuery(api, "batch-a")));
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.getCurrentResult().data).toMatchObject({ status: "queued", succeeded: 0 });
      expect(requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toHaveLength(2);
      expect(observer.getCurrentResult().data).toMatchObject({ status: "running", succeeded: 1 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observer.getCurrentResult().data).toMatchObject({ status: terminal, succeeded: 2, taskCount: 3 });
      expect(requests).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(requests).toHaveLength(3);
      expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    },
  );

  it("continues stale task snapshots after the batch has finished, then stops for all task terminal states", async () => {
    const { api, requests } = snapshots(
      json(taskPage("queued", "held", "starting")),
      json(taskPage("running", "cancelling", "succeeded")),
      json(taskPage("succeeded", "failed", "cancelled")),
    );
    const observer = observe(new QueryObserver(client, crawlTasksQuery(api, "batch-a", 100, "completed_with_errors")));
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.items.map((task) => task.status)).toEqual(["queued", "held", "starting"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().data?.items.map((task) => task.status)).toEqual(["running", "cancelling", "succeeded"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().data).toMatchObject({
      offset: 100,
      items: [
        { status: "succeeded", artifactCount: 1 },
        { status: "failed", errorClass: "network_timeout" },
        { status: "cancelled" },
      ],
    });
    expect(requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requests).toHaveLength(3);
  });

  it("keeps polling an empty/finished task page until the observed batch finishes", async () => {
    let detailRequests = 0;
    let taskRequests = 0;
    const api = createApi("http://127.0.0.1:8787", {
      fetchImpl: async (request) => {
        if (new URL(request.url).pathname.endsWith("/tasks")) {
          taskRequests++;
          return json(taskRequests === 1 ? taskPage() : taskPage("succeeded"));
        }
        detailRequests++;
        return json(batch(detailRequests < 4 ? "running" : "succeeded", detailRequests < 4 ? 0 : 1));
      },
    });
    const tasks = observe(new QueryObserver(client, crawlTasksQuery(api, "batch-a", 0)));
    const detail = new QueryObserver(client, crawlBatchQuery(api, "batch-a"));
    cleanups.push(() => detail.destroy());
    detail.subscribe((result) => {
      if (result.data) tasks.setOptions(crawlTasksQuery(api, "batch-a", 0, result.data.status));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tasks.getCurrentResult().data?.items).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tasks.getCurrentResult().data?.items[0]).toMatchObject({ status: "succeeded", artifactCount: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(taskRequests).toBe(3);
    expect(detail.getCurrentResult().data?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(detail.getCurrentResult().data?.status).toBe("succeeded");
    const stoppedAt = taskRequests;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(taskRequests).toBe(stoppedAt);
    expect(detailRequests).toBe(4);
  });

  it("keeps pages/batches separate and ignores late responses from the previous subscription", async () => {
    const { api, pending } = controlledApi();
    const observer = observe(new QueryObserver(client, crawlTasksQuery(api, "batch-a", 0, "running")));
    await vi.advanceTimersByTimeAsync(0);
    pending[0]!.respond({ items: [{ id: "a-first", status: "queued", sequence_no: 1 }] });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pending).toHaveLength(2);

    observer.setOptions(crawlTasksQuery(api, "batch-a", 100, "running"));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending[1]!.request.signal.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();
    pending[2]!.respond({ items: [{ id: "a-second", status: "running", sequence_no: 101 }] });
    pending[1]!.respond({ items: [{ id: "a-first", status: "succeeded" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toMatchObject({ offset: 100, items: [{ id: "a-second", sequence: 101 }] });

    await vi.advanceTimersByTimeAsync(2_000);
    observer.setOptions(crawlTasksQuery(api, "batch-b", 0, "succeeded"));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending[3]!.request.signal.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();
    pending[4]!.respond({ items: [{ id: "b-first", status: "succeeded", artifact_count: 1 }] });
    pending[3]!.respond({ items: [{ id: "a-second", status: "failed" }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.getCurrentResult().data).toMatchObject({ offset: 0, items: [{ id: "b-first", artifactCount: 1 }] });
    expect(client.getQueryData(crawlKeys.taskPage("batch-a", 0))).toMatchObject({ offset: 0, items: [{ id: "a-first", status: "queued" }] });
    expect(client.getQueryData(crawlKeys.taskPage("batch-a", 100))).toMatchObject({ offset: 100, items: [{ id: "a-second", status: "running" }] });
    expect(pending.map(({ request }) => {
      const url = new URL(request.url);
      return `${url.pathname}?${url.searchParams.get("offset")}`;
    })).toEqual([
      "/api/v1/crawls/batch-a/tasks?0", "/api/v1/crawls/batch-a/tasks?0",
      "/api/v1/crawls/batch-a/tasks?100", "/api/v1/crawls/batch-a/tasks?100",
      "/api/v1/crawls/batch-b/tasks?0",
    ]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(pending).toHaveLength(5);
  });

  it("retains the active snapshot through a request failure and recovers on the next interval", async () => {
    const { api, requests } = snapshots(
      json(batch("queued")),
      json({ error: { code: "temporarily_unavailable", message: "try again" } }, 503),
      json(batch("succeeded", 3)),
    );
    const observer = observe(new QueryObserver(client, crawlBatchQuery(api, "batch-a")));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().error).toBeInstanceOf(ApiError);
    expect(observer.getCurrentResult().error).toMatchObject({ status: 503, code: "temporarily_unavailable" });
    expect(observer.getCurrentResult().data?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult()).toMatchObject({ status: "success", error: null, data: { status: "succeeded", succeeded: 3 } });
    expect(requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(requests).toHaveLength(3);
  });
});
