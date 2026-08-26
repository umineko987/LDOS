import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { TASK_PAGE_LIMIT } from "./model";
import { TASKS_ENDPOINTS, createTasksService, taskBatchPath, taskPagePath } from "./service";

function rawBatch(status = "running") {
  return {
    id: "batch:service.1",
    status,
    concurrency: 2,
    max_tasks: 500,
    task_count: 1,
    succeeded_task_count: status === "succeeded" ? 1 : 0,
    failed_task_count: 0,
    cancelled_task_count: 0,
    sources: [],
    current: null,
    review: null,
    resumable: false,
  };
}

function rawTask() {
  return {
    id: "task-service",
    crawl_address_id: "address-service",
    site: "pixiv",
    status: "running",
    source_order: 0,
    address_order: 0,
    sequence_no: 1,
    attempt_count: 0,
    max_attempts: 3,
    artifact_count: 0,
    artifact_bytes: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function api(get: ApiClient["get"] = vi.fn(async () => ({ items: [] }))) {
  return {
    request: vi.fn(),
    get,
    post: vi.fn(async () => ({})),
    put: vi.fn(),
    delete: vi.fn(),
    createIdempotencyKey: vi.fn(() => "desktop-test-key"),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
}

describe("Tasks API service", () => {
  it("uses the existing crawls endpoint with fixed 100-row offset pagination", () => {
    expect(TASKS_ENDPOINTS).toEqual({ crawls: "/api/v1/crawls" });
    expect(taskBatchPath("batch:service.1")).toBe("/api/v1/crawls/batch%3Aservice.1");
    expect(taskPagePath({ batchId: "batch:service.1", offset: 0, addressId: "" }))
      .toBe("/api/v1/crawls/batch%3Aservice.1/tasks?limit=100&offset=0&view=tasks");
    expect(taskPagePath({ batchId: "batch:service.1", offset: 200, addressId: "address:one" }))
      .toBe("/api/v1/crawls/batch%3Aservice.1/tasks?limit=100&offset=200&view=tasks&address_id=address%3Aone");
    expect(TASK_PAGE_LIMIT).toBe(100);
    expect(() => taskPagePath({ batchId: "batch:service.1", offset: 1, addressId: "" })).toThrow("invalid_task_offset");
    expect(() => taskPagePath({ batchId: "bad/path", offset: 0, addressId: "" })).toThrow("invalid_batch_id");
    expect(() => taskPagePath({ batchId: "batch:service.1", offset: 0, addressId: "bad/path" })).toThrow("invalid_batch_id");
  });

  it("starts summary and current-page GETs concurrently with the same AbortSignal, then sanitizes both", async () => {
    const summary = deferred<unknown>();
    const page = deferred<unknown>();
    const get = vi.fn((path: string) => {
      if (path.endsWith("/tasks?limit=100&offset=100&view=tasks")) return page.promise;
      return summary.promise;
    });
    const client = api(get as ApiClient["get"]);
    const service = createTasksService(client);
    const controller = new AbortController();
    const pending = service.readAuthority({ batchId: "batch:service.1", offset: 100, addressId: "" }, controller.signal);

    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/crawls/batch%3Aservice.1?view=desktop",
      "/api/v1/crawls/batch%3Aservice.1/tasks?limit=100&offset=100&view=tasks",
    ]);
    const signals = client.get.mock.calls.map(([, options]) => options.signal as AbortSignal);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]).not.toBe(controller.signal);
    expect(signals[0].aborted).toBe(false);

    page.resolve({ items: [rawTask()], limit: 100, offset: 100 });
    await Promise.resolve();
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    summary.resolve(rawBatch());
    await expect(pending).resolves.toMatchObject({
      summary: { id: "batch:service.1", status: "running" },
      page: { batchId: "batch:service.1", offset: 100, items: [{ id: "task-service" }] },
    });
  });

  it("reads and sanitizes only the existing recent-batch list", async () => {
    const client = api(vi.fn(async () => ({ items: [rawBatch("succeeded")] })) as ApiClient["get"]);
    const service = createTasksService(client);
    const controller = new AbortController();
    await expect(service.readRecent(controller.signal)).resolves.toEqual([
      expect.objectContaining({ id: "batch:service.1", status: "succeeded", terminal: true }),
    ]);
    expect(client.get).toHaveBeenCalledWith("/api/v1/crawls?limit=30&view=desktop", { signal: controller.signal });
  });

  it("uses exact POST endpoints and bodies for cancel, retry, and rerun", async () => {
    const client = api();
    const service = createTasksService(client);
    const controller = new AbortController();
    await service.write("cancel", "batch:service.1", controller.signal);
    await service.write("retry", "batch:service.1", controller.signal);
    await service.write("rerun", "batch:service.1", controller.signal);
    expect(client.post.mock.calls).toEqual([
      ["/api/v1/crawls/batch%3Aservice.1/cancel?view=desktop", {}, { signal: controller.signal }],
      ["/api/v1/crawls/batch%3Aservice.1/retry?view=desktop", { additional_attempts: 2 }, { signal: controller.signal }],
      ["/api/v1/crawls/batch%3Aservice.1/rerun?view=desktop", {}, { signal: controller.signal }],
    ]);
    await expect(service.write("invalid" as never, "batch:service.1", controller.signal))
      .rejects.toThrow("invalid_tasks_operation");
    expect(client.get.mock.calls.some(([path]) => String(path).includes("/api/v1/tasks"))).toBe(false);
  });

  it("rejects the whole authority read when either response is invalid", async () => {
    const responses = [rawBatch(), { items: [], limit: 1, offset: 0 }];
    const client = api(vi.fn(async () => responses.shift()) as ApiClient["get"]);
    const service = createTasksService(client);
    await expect(service.readAuthority(
      { batchId: "batch:service.1", offset: 0, addressId: "" },
      new AbortController().signal,
    )).rejects.toThrow("invalid_task_page_limit");
  });

  it("aborts the sibling on partial failure and propagates an external abort to both reads", async () => {
    const never = deferred<unknown>();
    const failure = new Error("summary failed");
    const partialGet = vi.fn((path: string) => path.endsWith("/tasks?limit=100&offset=0&view=tasks")
      ? never.promise
      : Promise.reject(failure));
    const partialClient = api(partialGet as ApiClient["get"]);
    const partialService = createTasksService(partialClient);
    await expect(partialService.readAuthority(
      { batchId: "batch:service.1", offset: 0, addressId: "" },
      new AbortController().signal,
    )).rejects.toBe(failure);
    const partialSignals = partialClient.get.mock.calls.map(([, options]) => options.signal as AbortSignal);
    expect(partialSignals[0]).toBe(partialSignals[1]);
    expect(partialSignals[0].aborted).toBe(true);

    const abortGet = vi.fn((_path: string, options?: { signal?: AbortSignal }) => new Promise<unknown>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
    }));
    const abortClient = api(abortGet as ApiClient["get"]);
    const abortService = createTasksService(abortClient);
    const external = new AbortController();
    const pending = abortService.readAuthority(
      { batchId: "batch:service.1", offset: 0, addressId: "" },
      external.signal,
    );
    external.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const abortSignals = abortClient.get.mock.calls.map(([, options]) => options.signal as AbortSignal);
    expect(abortSignals).toHaveLength(2);
    expect(abortSignals.every((signal) => signal.aborted)).toBe(true);
  });
});
