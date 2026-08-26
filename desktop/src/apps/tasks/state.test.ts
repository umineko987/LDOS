import { describe, expect, it, vi } from "vitest";

import {
  sanitizeBatchSummary,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  tasksErrorPresentation,
  type TasksAuthoritySnapshot,
} from "./model";
import { createTasksStore, filteredRecentFromState, tasksFromState } from "./state";

function rawBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-state",
    status: "running",
    concurrency: 4,
    max_tasks: 1_000,
    task_count: 205,
    succeeded_task_count: 10,
    failed_task_count: 1,
    cancelled_task_count: 0,
    created_at: 1_700_000_000,
    resumable: false,
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      addresses: [{
        id: "address-state",
        address_order: 0,
        label: "来源",
        address_type: "account",
        status: "running",
        planned_task_count: 105,
      }],
    }],
    current: null,
    review: null,
    ...overrides,
  };
}

function rawTask(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `task-${index}`,
    crawl_address_id: "address-state",
    site: "pixiv",
    status: "running",
    source_order: 0,
    address_order: 0,
    sequence_no: index,
    attempt_count: 0,
    max_attempts: 3,
    artifact_count: 0,
    artifact_bytes: 0,
    last_error_class: "",
    ...overrides,
  };
}

function authority({
  batch = rawBatch(),
  items = [rawTask(0), rawTask(1)],
  offset = 0,
  addressId = "",
}: {
  batch?: Record<string, unknown>;
  items?: Record<string, unknown>[];
  offset?: number;
  addressId?: string;
} = {}): TasksAuthoritySnapshot {
  const query = { batchId: "batch-state", offset, addressId };
  return Object.freeze({
    summary: sanitizeBatchSummary(batch, "batch-state"),
    page: sanitizeTaskPage({ items, limit: 100, offset }, query),
  });
}

describe("the one Tasks domain state owner", () => {
  it("owns active/recent selection and filter transitions without shell state", () => {
    const store = createTasksStore();
    expect(store.getState()).toMatchObject({ activeBatchId: "", phase: "empty", pageIndex: 0, addressId: "" });
    const recent = sanitizeRecentBatches({ items: [
      rawBatch({ id: "batch-active", status: "running" }),
      rawBatch({ id: "batch-terminal", status: "succeeded" }),
    ] });
    expect(store.commitRecent(recent)).toBe(true);
    expect(store.selectRecent("batch-active")).toBe(true);
    expect(store.selectRecent("missing")).toBe(false);
    expect(store.setRecentFilter("terminal")).toBe(true);
    expect(store.getState().selectedRecentId).toBe("");
    expect(filteredRecentFromState(store.getState()).map(({ id }) => id)).toEqual(["batch-terminal"]);
    expect(store.setRecentFilter("all")).toBe(true);
    expect(store.selectRecent("batch-active")).toBe(true);
    expect(store.activateBatch("batch-active")).toBe(true);
    expect(store.getState()).toMatchObject({
      activeBatchId: "batch-active", selectedRecentId: "batch-active", phase: "loading", busy: "load",
    });
  });

  it("commits summary plus current page once, stores entities/order, and reuses unchanged row identities", () => {
    const store = createTasksStore({ activeBatchId: "batch-state" });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    listener.mockClear();

    const first = authority({ items: Array.from({ length: 100 }, (_, index) => rawTask(index)) });
    expect(store.commitAuthority(first)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().order).toHaveLength(100);
    expect(Object.keys(store.getState().entities)).toHaveLength(100);
    expect(tasksFromState(store.getState())).toHaveLength(100);
    expect(store.getState()).toMatchObject({ phase: "content", busy: "", error: null });
    const firstTask = store.getState().entities["task-0"];
    const secondTask = store.getState().entities["task-1"];

    listener.mockClear();
    const changed = authority({
      items: [rawTask(0), rawTask(1, { status: "succeeded" }), ...Array.from({ length: 98 }, (_, index) => rawTask(index + 2))],
    });
    expect(store.commitAuthority(changed)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().entities["task-0"]).toBe(firstTask);
    expect(store.getState().entities["task-1"]).not.toBe(secondTask);
    expect(store.getState().entities["task-1"].status).toBe("succeeded");
    expect(store.getState().recent[0]).toMatchObject({ id: "batch-state", taskCount: 205 });
    store.commitRecent(sanitizeRecentBatches({ items: [rawBatch({ status: "succeeded" })] }));
    expect(store.getState().recent[0].status).toBe("running");
    unsubscribe();
  });
  it("keeps an actionable confirmation across successful and failed passive polls, then closes it at terminal state", () => {
    const store = createTasksStore({ activeBatchId: "batch-state" });
    store.commitAuthority(authority());
    expect(store.requestConfirmation("cancel")).toBe(true);
    const confirmation = store.getState().confirmation;

    expect(store.commitAuthority(authority(), { clearBusy: true })).toBe(true);
    expect(store.getState().confirmation).toBe(confirmation);

    const pollError = tasksErrorPresentation({ status: 503, code: "network_error" });
    expect(store.failAuthority(pollError, { clearBusy: true })).toBe(true);
    expect(store.getState()).toMatchObject({ phase: "partial", confirmation });

    expect(store.commitAuthority(authority({ batch: rawBatch({ status: "cancelled" }) }))).toBe(true);
    expect(store.getState().confirmation).toBeNull();
  });

  it("owns page/address queries and rejects stale authority commits", () => {
    const store = createTasksStore({ activeBatchId: "batch-state" });
    store.commitAuthority(authority());
    expect(store.setPage(1)).toBe(true);
    expect(store.getState()).toMatchObject({ pageIndex: 1, busy: "load", phase: "loading" });
    expect(store.getState().order).toEqual([]);
    expect(store.commitAuthority(authority({ offset: 0 }))).toBe(false);
    expect(store.commitAuthority(authority({ offset: 100 }), { clearBusy: true })).toBe(true);
    expect(store.getState()).toMatchObject({ pageIndex: 1, busy: "", phase: "content" });
    expect(store.setPage(3)).toBe(false);
    expect(store.setPage(1)).toBe(false);

    expect(store.setAddress("address-state")).toBe(true);
    expect(store.getState()).toMatchObject({ addressId: "address-state", pageIndex: 0, busy: "load" });
    expect(store.setAddress("missing-address")).toBe(false);
    expect(store.commitAuthority(authority({ addressId: "" }), { clearBusy: true })).toBe(false);
    expect(store.commitAuthority(authority({ addressId: "address-state" }), { clearBusy: true })).toBe(true);
    expect(store.setPage(1)).toBe(true);
    expect(store.setPage(2)).toBe(false);
  });

  it("owns confirmation, busy, partial/error, missing, messages, and cleanup transitions", () => {
    const store = createTasksStore({ activeBatchId: "batch-state" });
    store.commitAuthority(authority());
    expect(store.requestConfirmation("retry")).toBe(false);
    expect(store.requestConfirmation("cancel")).toBe(true);
    expect(store.requestConfirmation("cancel")).toBe(false);
    expect(store.getState().confirmation).toMatchObject({ operation: "cancel", confirmLabel: "取消批次" });
    expect(store.dismissConfirmation()).toBe(true);
    expect(store.dismissConfirmation()).toBe(false);

    expect(store.requestConfirmation("cancel")).toBe(true);
    expect(store.beginBusy("cancel", "writing")).toBe(true);
    expect(store.getState()).toMatchObject({ busy: "cancel", phase: "writing", confirmation: null });
    expect(store.beginBusy("refresh", "ignored")).toBe(false);
    const operationError = tasksErrorPresentation({ status: 409, code: "review_in_progress" });
    expect(store.commitAuthority(authority({ batch: rawBatch({ status: "cancelled" }) }), {
      clearBusy: true,
      error: operationError,
      operationMessage: "reread",
    })).toBe(true);
    expect(store.getState()).toMatchObject({ busy: "", phase: "terminal", error: operationError, operationMessage: "reread" });

    expect(store.beginBusy("refresh", "refreshing")).toBe(true);
    expect(store.failAuthority(operationError, { clearBusy: true })).toBe(true);
    expect(store.getState()).toMatchObject({ busy: "", phase: "partial", error: operationError });
    expect(store.setOperationMessage("safe message")).toBe(true);
    expect(store.setOperationMessage("safe message")).toBe(false);
    expect(store.setPhase("content", "safe message")).toBe(true);
    expect(store.setPhase("content", "safe message")).toBe(false);

    expect(store.clearMissing(tasksErrorPresentation({ status: 404, code: "crawl_not_found" }))).toBe(true);
    expect(store.getState()).toMatchObject({ activeBatchId: "", phase: "empty", busy: "", summary: null });
    expect(store.beginBusy("refresh", "recent")).toBe(true);
    expect(store.finishBusy("empty", "done")).toBe(true);
    expect(store.finishBusy("empty", "done")).toBe(false);

    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    store.destroy();
    expect(store.setOperationMessage("after destroy")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
