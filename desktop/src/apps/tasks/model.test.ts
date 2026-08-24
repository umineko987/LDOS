import { describe, expect, it } from "vitest";

import { ApiError } from "../../core/api/client";
import {
  TASK_PAGE_LIMIT,
  deriveBatchProgress,
  deriveOperationAvailability,
  deriveTaskErrorFacts,
  deriveTaskFileFacts,
  deriveTaskRecovery,
  deriveWorkspacePresentation,
  filterRecentBatches,
  formatBatchTime,
  formatTaskBytes,
  recentBatchFromSummary,
  sanitizeBatchSummary,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  shortBatchId,
  shouldPollBatch,
  siteLabel,
  taskErrorCategory,
  taskPageCount,
  taskPageTotal,
  tasksErrorPresentation,
  validateBatchId,
} from "./model";

const SECRET = "tasks-secret-token-314159";

function rawBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-tasks",
    status: "running",
    output_dir: `/private/${SECRET}`,
    concurrency: 12,
    max_tasks: 1_500,
    task_count: 1_005,
    succeeded_task_count: 500,
    failed_task_count: 2,
    cancelled_task_count: 1,
    pre_dedup_skipped_count: 4,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_030,
    finished_at: null,
    cancel_requested: false,
    resumable: false,
    current: {
      address_id: "address-one",
      source_order: 0,
      address_order: 0,
      site: "pixiv",
      status: "running",
      url: `https://private.invalid/?token=${SECRET}`,
    },
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      pre_dedup_skipped_count: 4,
      addresses: [{
        id: "address-one",
        address_order: 0,
        label: "画师作品",
        address_type: "account",
        status: "running",
        planned_task_count: 105,
        succeeded_task_count: 50,
        failed_task_count: 2,
        cancelled_task_count: 1,
        pre_dedup_skipped_count: 4,
        probed_proxy_count: 3,
        healthy_proxy_count: 2,
        planning_error: `failed /private/${SECRET}`,
        url: `https://private.invalid/${SECRET}`,
      }],
    }],
    review: {
      batch_id: "batch-tasks",
      status: "ready",
      total_image_count: 500,
      duplicate_group_count: 12,
      decided_group_count: 3,
      total_group_count: 12,
      log_path: `/private/${SECRET}`,
    },
    ...overrides,
  };
}

function rawTask(index = 0, overrides: Record<string, unknown> = {}) {
  return {
    id: `task-${index}`,
    crawl_address_id: "address-one",
    site: "pixiv",
    status: index % 2 ? "running" : "failed",
    source_order: 0,
    address_order: 0,
    sequence_no: index,
    attempt_count: 1,
    max_attempts: 3,
    artifact_count: index === 0 ? 2 : 0,
    artifact_bytes: index === 0 ? 5_242_880 : 0,
    last_error_class: index === 0 ? "credentials_unavailable" : "",
    last_error: `cookie=${SECRET}`,
    url: `https://private.invalid/media?token=${SECRET}`,
    output_dir: `/private/${SECRET}`,
    cookies_file: `/private/${SECRET}.txt`,
    ...overrides,
  };
}

const query = Object.freeze({ batchId: "batch-tasks", offset: 0, addressId: "" });

describe("Tasks runtime sanitizer and derived facts", () => {
  it("projects the batch summary, addresses, review, and current facts without paths, URLs, or errors", () => {
    const summary = sanitizeBatchSummary(rawBatch(), "batch-tasks");
    expect(summary).toMatchObject({
      id: "batch-tasks",
      status: "running",
      statusLabel: "运行中",
      statusKind: "running",
      taskCount: 1_005,
      current: { addressId: "address-one", site: "pixiv", status: "running" },
      review: { status: "ready", kind: "ready", totalGroupCount: 12 },
    });
    expect(summary.sources[0].addresses[0]).toMatchObject({
      id: "address-one",
      label: "画师作品",
      plannedTaskCount: 105,
      hasPlanningIssue: true,
    });
    const serialized = JSON.stringify(summary);
    for (const forbidden of [SECRET, "private.invalid", "output_dir", "planning_error", "last_error", "url"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.sources)).toBe(true);
    expect(Object.isFrozen(summary.sources[0].addresses)).toBe(true);
  });

  it("keeps exactly the current 100-task page and only whitelisted row facts", () => {
    const page = sanitizeTaskPage({
      items: Array.from({ length: 1_001 }, (_, index) => rawTask(index)),
      limit: 100,
      offset: 0,
      secret: SECRET,
    }, query);
    expect(TASK_PAGE_LIMIT).toBe(100);
    expect(page.items).toHaveLength(100);
    expect(page).toMatchObject({ batchId: "batch-tasks", addressId: "", offset: 0, limit: 100 });
    expect(page.items[0]).toMatchObject({
      id: "task-0",
      addressId: "address-one",
      artifactCount: 2,
      artifactBytes: 5_242_880,
      errorClass: "credentials_unavailable",
      errorCategory: { id: "authentication", targetApp: "vault" },
    });
    const serialized = JSON.stringify(page);
    for (const forbidden of [SECRET, "private.invalid", "output_dir", "cookies_file", "last_error", "url"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects mismatched roots, IDs, offsets, metadata, duplicates, accessors, and hostile records", () => {
    expect(() => sanitizeBatchSummary(rawBatch({ id: "other" }), "batch-tasks")).toThrow("invalid_batch_id");
    expect(() => sanitizeBatchSummary([], "batch-tasks")).toThrow("invalid_batch_summary");
    expect(() => sanitizeTaskPage(null, query)).toThrow("invalid_task_page");
    expect(() => sanitizeTaskPage({}, query)).toThrow("invalid_task_page");
    expect(() => sanitizeTaskPage({ items: [], limit: 99 }, query)).toThrow("invalid_task_page_limit");
    expect(() => sanitizeTaskPage({ items: [], offset: 100 }, query)).toThrow("invalid_task_page_offset");
    expect(() => sanitizeTaskPage({ items: [] }, { ...query, offset: 1 })).toThrow("invalid_task_offset");
    expect(() => sanitizeTaskPage({ items: [] }, { ...query, addressId: "bad/path" })).toThrow("invalid_address_id");
    expect(() => sanitizeTaskPage({ items: [rawTask(1), rawTask(1)] }, query)).toThrow("duplicate_task_id");
    expect(() => validateBatchId("../batch")).toThrow("invalid_batch_id");
    expect(() => validateBatchId(" batch")).toThrow("invalid_batch_id");

    const accessor = Object.defineProperty({}, "items", { enumerable: true, get: () => [rawTask()] });
    expect(() => sanitizeTaskPage(accessor, query)).toThrow("invalid_task_page");
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error(SECRET); } });
    expect(() => sanitizeBatchSummary(hostile, "batch-tasks")).toThrow("invalid_batch_summary");
  });

  it("sanitizes recent batches, removes duplicates, and derives filters without a second detail tree", () => {
    const recent = sanitizeRecentBatches({ items: [
      rawBatch({ id: "active", status: "running" }),
      rawBatch({ id: "attention", status: "completed_with_errors" }),
      rawBatch({ id: "done", status: "succeeded" }),
      rawBatch({ id: "cancelled", status: "cancelled" }),
      rawBatch({ id: "active", status: "failed" }),
      { id: "bad/path" },
    ] });
    expect(recent.map(({ id }) => id)).toEqual(["active", "attention", "done", "cancelled"]);
    expect(filterRecentBatches(recent, "active").map(({ id }) => id)).toEqual(["active"]);
    expect(filterRecentBatches(recent, "attention").map(({ id }) => id)).toEqual(["attention", "cancelled"]);
    expect(filterRecentBatches(recent, "terminal").map(({ id }) => id)).toEqual(["attention", "done", "cancelled"]);
    expect(filterRecentBatches(recent, "all")).toBe(recent);
    expect(() => filterRecentBatches(recent, "invalid" as never)).toThrow("invalid_recent_filter");
    expect(() => sanitizeRecentBatches({})).toThrow("invalid_recent_batches");

    const projected = recentBatchFromSummary(sanitizeBatchSummary(rawBatch()));
    expect(projected).toEqual(expect.objectContaining({ id: "batch-tasks", taskCount: 1_005, terminal: false }));
    expect(JSON.stringify(projected)).not.toContain("sources");
  });

  it("derives complete progress from the summary and page-local file/error/recovery facts", () => {
    const summary = sanitizeBatchSummary(rawBatch());
    const tasks = sanitizeTaskPage({ items: [
      rawTask(0),
      rawTask(1, { id: "proxy-task", status: "failed", last_error_class: "proxy_exhausted" }),
      rawTask(2, { id: "network-task", status: "failed", last_error_class: "network_timeout" }),
      rawTask(3, { id: "clean-task", status: "succeeded", last_error_class: "" }),
    ] }, query).items;
    expect(deriveBatchProgress(summary)).toEqual({ terminal: 503, total: 1_005, percent: 50 });
    expect(deriveBatchProgress(null)).toEqual({ terminal: 0, total: 0, percent: 0 });
    expect(deriveBatchProgress(sanitizeBatchSummary(rawBatch({
      status: "succeeded", task_count: 0, succeeded_task_count: 0, failed_task_count: 0, cancelled_task_count: 0,
    })))).toEqual({ terminal: 0, total: 0, percent: 100 });
    expect(taskPageTotal(summary, "")).toBe(1_005);
    expect(taskPageTotal(summary, "address-one")).toBe(105);
    expect(taskPageTotal(summary, "missing")).toBe(0);
    expect(taskPageTotal(null, "")).toBe(0);
    expect(taskPageCount(summary, "")).toBe(11);
    expect(taskPageCount(summary, "address-one")).toBe(2);

    expect(deriveTaskFileFacts(tasks)).toEqual({
      taskCount: 4, taskWithFilesCount: 1, artifactCount: 2, artifactBytes: 5_242_880,
    });
    expect(deriveTaskErrorFacts(tasks).map(({ category, count }) => [category.id, count])).toEqual([
      ["authentication", 1], ["proxy", 1], ["network", 1],
    ]);
    expect(deriveTaskRecovery(tasks)).toEqual({ authSites: ["pixiv"], proxyIssue: true });
  });

  it("classifies only safe error classes and produces safe API feedback for Error subclasses", () => {
    const categories = {
      credentials_unavailable: "authentication",
      proxy_exhausted: "proxy",
      rate_limit: "rate_limit",
      network_timeout: "network",
      artifact_write_failed: "storage",
      cancelled: "cancelled",
      extraction_error: "extraction",
      backend_restart: "unknown",
    };
    for (const [value, expected] of Object.entries(categories)) {
      expect(taskErrorCategory(value)?.id).toBe(expected);
    }
    expect(taskErrorCategory("")).toBeNull();

    const error = new ApiError({
      status: 409,
      code: "review_in_progress",
      message: `private ${SECRET}`,
      details: { path: `/private/${SECRET}` },
      requestId: "request-safe",
    });
    expect(tasksErrorPresentation(error)).toEqual({
      code: "review_in_progress",
      status: 409,
      requestId: "request-safe",
      missing: false,
      targetApp: "diagnostics",
      title: "批次状态已变化",
      message: "服务未接受本次批次操作。",
      nextStep: "已保留当前快照；请根据权威重读后的可用操作继续。",
    });
    expect(JSON.stringify(tasksErrorPresentation(error))).not.toContain(SECRET);
    expect(tasksErrorPresentation({ status: 404, code: "crawl_not_found" }).missing).toBe(true);
    expect(tasksErrorPresentation({ status: 422, code: "invalid_crawl" }).title).toBe("批次参数无效");
    expect(tasksErrorPresentation({ status: 401, code: "credentials_unavailable" }).targetApp).toBe("vault");
    expect(tasksErrorPresentation({ status: 503, code: "proxy_pool_unavailable" }).targetApp).toBe("proxy");
    expect(tasksErrorPresentation(new Error(SECRET)).status).toBe(0);
  });

  it("derives polling, operation, workspace, labels, times, and bounded formatting", () => {
    const running = sanitizeBatchSummary(rawBatch());
    const terminal = sanitizeBatchSummary(rawBatch({ status: "completed_with_errors", resumable: true }));
    expect(shouldPollBatch(running)).toBe(true);
    expect(shouldPollBatch(terminal)).toBe(false);
    expect(shouldPollBatch(null)).toBe(false);
    expect(deriveOperationAvailability(running, "")).toEqual({ cancel: true, retry: false, rerun: false });
    expect(deriveOperationAvailability(terminal, "")).toEqual({ cancel: false, retry: true, rerun: true });
    expect(deriveOperationAvailability(terminal, "refresh")).toEqual({ cancel: false, retry: false, rerun: false });
    for (const phase of ["loading", "empty", "content", "partial", "error", "terminal", "writing"] as const) {
      expect(deriveWorkspacePresentation(phase)).toEqual(expect.objectContaining({ label: expect.any(String), message: expect.any(String) }));
    }
    expect(formatTaskBytes(0)).toBe("0 B");
    expect(formatTaskBytes(5_242_880)).toBe("5.0 MiB");
    expect(formatTaskBytes(512)).toBe("512 B");
    expect(formatBatchTime(null)).toBe("—");
    expect(formatBatchTime(1_700_000_000)).not.toBe("—");
    expect(shortBatchId("batch-short")).toBe("batch-short");
    expect(shortBatchId("batch-1234567890-abcdef")).toContain("…");
    expect(shortBatchId("bad/path")).toBe("—");
    expect(siteLabel("pixiv")).toBe("Pixiv");
    expect(siteLabel("unknown")).toBe("未知来源");
  });
});
