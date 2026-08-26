import { describe, expect, it, vi } from "vitest";

import type { PersistenceService } from "../../core/persistence/service";
import { createPollingService, type PollingVisibilitySource } from "../../core/polling/service";
import {
  sanitizeBatchSummary,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  type TasksAuthoritySnapshot,
} from "./model";
import { createTasksController } from "./controller";
import type { TasksService } from "./service";
import { createTasksStore } from "./state";

class ManualTimers {
  private nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delay: number }>();

  readonly setTimeout = (callback: () => void, delay: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };

  readonly clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  };
}

const visible: PollingVisibilitySource = Object.freeze({
  getState: () => "visible",
  subscribe: () => () => {},
});

function rawBatch(status = "running", overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-controller",
    status,
    concurrency: 2,
    max_tasks: 500,
    task_count: 205,
    succeeded_task_count: status === "succeeded" ? 205 : 10,
    failed_task_count: status === "completed_with_errors" ? 1 : 0,
    cancelled_task_count: status === "cancelled" ? 205 : 0,
    created_at: 1_700_000_000,
    resumable: status === "completed_with_errors",
    sources: [{
      order: 0,
      site: "pixiv",
      status,
      addresses: [{
        id: "address-controller",
        address_order: 0,
        label: "来源",
        address_type: "account",
        status,
        planned_task_count: 105,
      }],
    }],
    current: null,
    review: null,
    ...overrides,
  };
}

function rawTask(index = 0, status = "running") {
  return {
    id: `task-controller-${index}`,
    crawl_address_id: "address-controller",
    site: "pixiv",
    status,
    source_order: 0,
    address_order: 0,
    sequence_no: index,
    attempt_count: 0,
    max_attempts: 3,
    artifact_count: 0,
    artifact_bytes: 0,
  };
}

function authority({
  status = "running",
  offset = 0,
  addressId = "",
  items = [rawTask()],
  overrides = {},
}: {
  status?: string;
  offset?: number;
  addressId?: string;
  items?: Record<string, unknown>[];
  overrides?: Record<string, unknown>;
} = {}): TasksAuthoritySnapshot {
  const query = { batchId: "batch-controller", offset, addressId };
  return Object.freeze({
    summary: sanitizeBatchSummary(rawBatch(status, overrides), "batch-controller"),
    page: sanitizeTaskPage({ items, limit: 100, offset }, query),
  });
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

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function harness({
  activeBatchId = "batch-controller",
  readRecent = vi.fn(async () => sanitizeRecentBatches({ items: [rawBatch()] })),
  readAuthority = vi.fn(async () => authority()),
  write = vi.fn(async () => {}),
}: {
  activeBatchId?: string;
  readRecent?: ReturnType<typeof vi.fn>;
  readAuthority?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
} = {}) {
  const timers = new ManualTimers();
  const polling = createPollingService({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    visibilitySource: visible,
  });
  const store = createTasksStore({ activeBatchId });
  const persistence = {
    writeActiveBatchId: vi.fn(() => true),
  } as unknown as PersistenceService;
  const service = { readRecent, readAuthority, write } as unknown as TasksService;
  const controller = createTasksController({ store, service, polling, persistence });
  return { timers, polling, store, persistence, service, readRecent, readAuthority, write, controller };
}

describe("Tasks controller lifecycle", () => {
  it("loads recent plus authority, commits one successful poll once, and stops at terminal", async () => {
    const first = deferred<TasksAuthoritySnapshot>();
    const readAuthority = vi.fn()
      .mockImplementationOnce((_query, _signal) => first.promise)
      .mockResolvedValueOnce(authority({ status: "succeeded" }));
    const runtime = harness({ readAuthority });
    const listener = vi.fn();
    runtime.store.subscribe(listener);
    runtime.controller.activate();
    await flush();
    expect(runtime.readRecent).toHaveBeenCalledOnce();
    expect(readAuthority).toHaveBeenCalledOnce();
    expect(readAuthority.mock.calls[0][0]).toEqual({ batchId: "batch-controller", offset: 0, addressId: "" });
    expect(readAuthority.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

    listener.mockClear();
    first.resolve(authority());
    await flush();
    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.store.getState().summary?.status).toBe("running");
    expect(runtime.polling.getSummary()).toEqual([
      expect.objectContaining({ key: "tasks.active", scope: "app:tasks", intervalMs: 1_500, state: "scheduled" }),
    ]);

    listener.mockClear();
    await expect(runtime.polling.trigger("tasks.active")).resolves.toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.store.getState().summary?.status).toBe("succeeded");
    expect(runtime.polling.getSummary()).toEqual([]);
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("keeps the last complete snapshot on partial failure and continues transient polling", async () => {
    const readAuthority = vi.fn()
      .mockResolvedValueOnce(authority())
      .mockRejectedValueOnce(Object.assign(new Error("private"), { status: 503, code: "network_error" }));
    const runtime = harness({ readAuthority });
    runtime.controller.activate();
    await flush();
    const previousTask = runtime.store.getState().entities["task-controller-0"];
    expect(runtime.controller.requestOperation("cancel")).toBe(true);
    const confirmation = runtime.store.getState().confirmation;
    await expect(runtime.polling.trigger("tasks.active")).resolves.toBe(false);
    expect(runtime.store.getState()).toMatchObject({ phase: "partial", busy: "", confirmation });
    expect(runtime.store.getState().entities["task-controller-0"]).toBe(previousTask);
    expect(runtime.polling.getSummary()).toEqual([expect.objectContaining({ key: "tasks.active" })]);
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("aborts an old page read and isolates its stale response when page changes again", async () => {
    const oldPage = deferred<TasksAuthoritySnapshot>();
    const currentPage = deferred<TasksAuthoritySnapshot>();
    const signals: AbortSignal[] = [];
    const readAuthority = vi.fn()
      .mockResolvedValueOnce(authority())
      .mockImplementationOnce((_query, signal: AbortSignal) => {
        signals.push(signal);
        return oldPage.promise;
      })
      .mockImplementationOnce((_query, signal: AbortSignal) => {
        signals.push(signal);
        return currentPage.promise;
      });
    const runtime = harness({ readAuthority });
    runtime.controller.activate();
    await flush();

    const stale = runtime.controller.setPage(1);
    await flush();
    expect(readAuthority.mock.calls[1][0]).toEqual({ batchId: "batch-controller", offset: 100, addressId: "" });
    const current = runtime.controller.setPage(0);
    await flush();
    expect(signals[0].aborted).toBe(true);
    expect(readAuthority.mock.calls[2][0]).toEqual({ batchId: "batch-controller", offset: 0, addressId: "" });

    oldPage.resolve(authority({ offset: 100, items: [rawTask(100)] }));
    await expect(stale).resolves.toBe(false);
    expect(runtime.store.getState().entities["task-controller-100"]).toBeUndefined();
    currentPage.resolve(authority({ items: [rawTask(0, "succeeded")] }));
    await expect(current).resolves.toBe(true);
    expect(runtime.store.getState()).toMatchObject({ pageIndex: 0, busy: "", phase: "content" });
    expect(runtime.store.getState().entities["task-controller-0"].status).toBe("succeeded");
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("changes the address query through the same abortable authority path", async () => {
    const filtered = deferred<TasksAuthoritySnapshot>();
    const readAuthority = vi.fn()
      .mockResolvedValueOnce(authority())
      .mockImplementationOnce((_query, _signal) => filtered.promise);
    const runtime = harness({ readAuthority });
    runtime.controller.activate();
    await flush();
    const pending = runtime.controller.setAddress("address-controller");
    await flush();
    expect(readAuthority.mock.calls[1][0]).toEqual({
      batchId: "batch-controller", offset: 0, addressId: "address-controller",
    });
    filtered.resolve(authority({ addressId: "address-controller" }));
    await expect(pending).resolves.toBe(true);
    expect(runtime.store.getState().addressId).toBe("address-controller");
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("performs one write and exactly one authority reread/commit after confirmation", async () => {
    const writeRequest = deferred<void>();
    const reread = deferred<TasksAuthoritySnapshot>();
    const readAuthority = vi.fn()
      .mockResolvedValueOnce(authority({ status: "completed_with_errors", overrides: { resumable: true } }))
      .mockImplementationOnce((_query, _signal) => reread.promise);
    const write = vi.fn((_operation, _batchId, _signal) => writeRequest.promise);
    const runtime = harness({ readAuthority, write });
    const listener = vi.fn();
    runtime.store.subscribe(listener);
    runtime.controller.activate();
    await flush();
    expect(runtime.controller.requestOperation("retry")).toBe(true);
    const operation = runtime.controller.confirmOperation(true);
    await flush();
    expect(write).toHaveBeenCalledWith("retry", "batch-controller", expect.any(AbortSignal));
    expect(runtime.store.getState()).toMatchObject({ busy: "retry", phase: "writing", confirmation: null });

    listener.mockClear();
    writeRequest.resolve();
    await flush();
    expect(readAuthority).toHaveBeenCalledTimes(2);
    expect(runtime.readRecent).toHaveBeenCalledOnce();
    reread.resolve(authority({ status: "running" }));
    await expect(operation).resolves.toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.store.getState()).toMatchObject({ busy: "", phase: "content", error: null });
    expect(runtime.polling.getSummary()).toEqual([expect.objectContaining({ key: "tasks.active" })]);
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("preserves a safe write error while making one authority reread", async () => {
    const readAuthority = vi.fn()
      .mockResolvedValueOnce(authority({ status: "completed_with_errors", overrides: { resumable: true } }))
      .mockResolvedValueOnce(authority({ status: "completed_with_errors", overrides: { resumable: true } }));
    const write = vi.fn(async () => {
      throw Object.assign(new Error("/private/secret"), {
        status: 409,
        code: "review_in_progress",
        details: { token: "secret" },
      });
    });
    const runtime = harness({ readAuthority, write });
    runtime.controller.activate();
    await flush();
    expect(runtime.controller.requestOperation("retry")).toBe(true);
    await expect(runtime.controller.confirmOperation(true)).resolves.toBe(false);
    expect(readAuthority).toHaveBeenCalledTimes(2);
    expect(runtime.store.getState()).toMatchObject({
      busy: "",
      phase: "terminal",
      error: { code: "review_in_progress", status: 409, title: "批次状态已变化" },
    });
    expect(JSON.stringify(runtime.store.getState())).not.toContain("/private/secret");
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("clears a missing persisted active batch and does not keep polling", async () => {
    const missing = Object.assign(new Error("private"), {
      status: 404,
      code: "crawl_not_found",
      requestId: "request-404",
    });
    const runtime = harness({ readAuthority: vi.fn(async () => { throw missing; }) });
    runtime.controller.activate();
    await flush();
    expect(runtime.persistence.writeActiveBatchId).toHaveBeenCalledWith(null);
    expect(runtime.store.getState()).toMatchObject({ activeBatchId: "", summary: null, phase: "empty" });
    expect(runtime.polling.getSummary()).toEqual([]);
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("loads a persisted-style recent selection and writes imageweave active-batch through persistence", async () => {
    const recent = sanitizeRecentBatches({ items: [rawBatch()] });
    const runtime = harness({
      activeBatchId: "",
      readRecent: vi.fn(async () => recent),
      readAuthority: vi.fn(async () => authority()),
    });
    runtime.controller.activate();
    await flush();
    expect(runtime.polling.getSummary()).toEqual([]);
    expect(runtime.controller.selectRecent("batch-controller")).toBe(true);
    await expect(runtime.controller.loadSelected()).resolves.toBe(true);
    expect(runtime.persistence.writeActiveBatchId).toHaveBeenCalledWith("batch-controller");
    expect(runtime.store.getState().activeBatchId).toBe("batch-controller");
    runtime.controller.destroy();
    runtime.polling.destroy();
  });

  it("aborts reads and returns polling/listener/request resources to baseline on destroy", async () => {
    const recent = deferred<readonly never[]>();
    const authorityRequest = deferred<TasksAuthoritySnapshot>();
    let recentSignal: AbortSignal | null = null;
    let authoritySignal: AbortSignal | null = null;
    const runtime = harness({
      readRecent: vi.fn((signal: AbortSignal) => {
        recentSignal = signal;
        return recent.promise;
      }),
      readAuthority: vi.fn((_query, signal: AbortSignal) => {
        authoritySignal = signal;
        return authorityRequest.promise;
      }),
    });
    const listener = vi.fn();
    runtime.store.subscribe(listener);
    runtime.controller.activate();
    await flush();
    const calls = listener.mock.calls.length;
    runtime.controller.destroy();
    runtime.controller.destroy();
    expect((recentSignal as AbortSignal | null)?.aborted).toBe(true);
    expect((authoritySignal as AbortSignal | null)?.aborted).toBe(true);
    expect(runtime.polling.getSummary()).toEqual([]);
    recent.resolve([]);
    authorityRequest.resolve(authority());
    await flush();
    expect(listener).toHaveBeenCalledTimes(calls);
    runtime.polling.destroy();
  });

  it("returns requests, timers, and registrations to baseline across 20 mount/destroy cycles", async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const runtime = harness();
      runtime.controller.activate();
      await flush();
      expect(runtime.polling.getSummary()).toHaveLength(1);
      runtime.controller.destroy();
      expect(runtime.polling.getSummary()).toEqual([]);
      expect(runtime.timers.timers.size).toBe(0);
      runtime.polling.destroy();
    }
  });
});
