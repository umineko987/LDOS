const BATCH_STATUSES = new Set([
  "queued", "pending", "planning", "starting", "running", "succeeded",
  "completed_with_errors", "cancelling", "cancelled", "failed",
]);
const TASK_STATUSES = new Set([
  "queued", "pending", "starting", "running", "succeeded", "failed", "cancelling", "cancelled",
]);
const REVIEW_STATUSES = new Set([
  "not_started", "waiting_for_crawl", "pending", "analyzing", "auto_applying",
  "ready", "applying", "applied", "failed", "apply_failed", "disabled",
]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_REVIEW_STATUSES = new Set(["pending", "analyzing", "auto_applying", "applying"]);
const ACTIVE_BATCH_STATUSES = new Set(["queued", "pending", "planning", "starting", "running", "cancelling"]);
const RECENT_FILTERS = new Set(["all", "active", "attention", "terminal"]);
const SITE_IDS = new Set(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);

export const TASK_PAGE_LIMIT = 100;
export const TASK_POLL_INTERVAL_MS = 1_500;
export const TERMINAL_BATCH_STATUSES = new Set(["succeeded", "completed_with_errors", "cancelled"]);

export type StatusKind = "ready" | "running" | "warning" | "error" | "disabled";
export type RecentFilter = "all" | "active" | "attention" | "terminal";
export type TasksPhase = "loading" | "empty" | "content" | "partial" | "error" | "terminal" | "writing";
export type TasksOperation = "cancel" | "retry" | "rerun";

export interface TaskErrorCategory {
  readonly id: "authentication" | "proxy" | "network" | "rate_limit" | "extraction" | "storage" | "cancelled" | "unknown";
  readonly label: string;
  readonly kind: "warning" | "error";
  readonly targetApp: "vault" | "proxy" | "diagnostics";
}

export interface BatchAddress {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly addressType: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusKind: StatusKind;
  readonly plannedTaskCount: number;
  readonly succeededTaskCount: number;
  readonly failedTaskCount: number;
  readonly cancelledTaskCount: number;
  readonly preDedupSkippedCount: number;
  readonly probedProxyCount: number;
  readonly healthyProxyCount: number;
  readonly hasPlanningIssue: boolean;
}

export interface BatchSource {
  readonly order: number;
  readonly site: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusKind: StatusKind;
  readonly preDedupSkippedCount: number;
  readonly addresses: readonly BatchAddress[];
}

export interface BatchCurrentAddress {
  readonly addressId: string;
  readonly site: string;
  readonly sourceOrder: number;
  readonly addressOrder: number;
  readonly status: string;
  readonly statusLabel: string;
}

export interface BatchReviewSummary {
  readonly batchId: string;
  readonly status: string;
  readonly label: string;
  readonly kind: StatusKind;
  readonly totalImageCount: number;
  readonly duplicateGroupCount: number;
  readonly decidedGroupCount: number;
  readonly totalGroupCount: number;
}

export interface BatchSummary {
  readonly id: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusKind: StatusKind;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly finishedAt: number | null;
  readonly cancelRequested: boolean;
  readonly concurrency: number;
  readonly maxTasks: number;
  readonly taskCount: number;
  readonly succeededTaskCount: number;
  readonly failedTaskCount: number;
  readonly cancelledTaskCount: number;
  readonly preDedupSkippedCount: number;
  readonly resumable: boolean;
  readonly current: BatchCurrentAddress | null;
  readonly sources: readonly BatchSource[];
  readonly addressesTruncated: boolean;
  readonly review: BatchReviewSummary | null;
}

export interface RecentBatch {
  readonly id: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusKind: StatusKind;
  readonly createdAt: number | null;
  readonly taskCount: number;
  readonly succeededTaskCount: number;
  readonly failedTaskCount: number;
  readonly terminal: boolean;
}

export interface TaskEntity {
  readonly id: string;
  readonly site: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusKind: StatusKind;
  readonly sourceOrder: number;
  readonly addressOrder: number;
  readonly sequence: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly addressId: string;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly errorClass: string;
  readonly errorCategory: TaskErrorCategory | null;
  readonly terminal: boolean;
}

export interface TaskPageQuery {
  readonly batchId: string;
  readonly offset: number;
  readonly addressId: string;
}

export interface TaskPageSnapshot {
  readonly batchId: string;
  readonly offset: number;
  readonly addressId: string;
  readonly limit: typeof TASK_PAGE_LIMIT;
  readonly items: readonly TaskEntity[];
}

export interface TasksAuthoritySnapshot {
  readonly summary: BatchSummary;
  readonly page: TaskPageSnapshot;
}

export interface TasksErrorPresentation {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly missing: boolean;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
  readonly targetApp: "vault" | "proxy" | "diagnostics";
}

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "等待", pending: "待处理", planning: "规划中", starting: "启动中",
  running: "运行中", succeeded: "成功", failed: "失败", cancelling: "取消中",
  cancelled: "已取消", completed_with_errors: "部分失败",
});
const REVIEW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  not_started: "去重未开始", waiting_for_crawl: "待开始分析", pending: "分析已排队",
  analyzing: "去重分析中", auto_applying: "自动去重中", ready: "待审核",
  applying: "正在应用", applied: "审核已应用", failed: "分析失败",
  apply_failed: "部分处理失败", disabled: "审核未启用",
});

export const TASK_ERROR_CATEGORIES = Object.freeze({
  authentication: Object.freeze({ id: "authentication", label: "授权失效", kind: "warning", targetApp: "vault" }),
  proxy: Object.freeze({ id: "proxy", label: "代理不可用", kind: "warning", targetApp: "proxy" }),
  network: Object.freeze({ id: "network", label: "网络失败", kind: "error", targetApp: "proxy" }),
  rate_limit: Object.freeze({ id: "rate_limit", label: "站点限流", kind: "warning", targetApp: "proxy" }),
  extraction: Object.freeze({ id: "extraction", label: "提取失败", kind: "error", targetApp: "diagnostics" }),
  storage: Object.freeze({ id: "storage", label: "文件写入失败", kind: "error", targetApp: "diagnostics" }),
  cancelled: Object.freeze({ id: "cancelled", label: "任务已取消", kind: "warning", targetApp: "diagnostics" }),
  unknown: Object.freeze({ id: "unknown", label: "未分类错误", kind: "error", targetApp: "diagnostics" }),
} satisfies Record<string, TaskErrorCategory>);

const WORKSPACE_COPY = Object.freeze({
  loading: Object.freeze({ kind: "running", label: "正在加载", message: "正在读取最近批次、批次摘要与当前任务页。" }),
  empty: Object.freeze({ kind: "disabled", label: "尚未选择批次", message: "从最近批次中选择，或先在图片采集页创建批次。" }),
  content: Object.freeze({ kind: "ready", label: "批次详情已就绪", message: "当前显示经过安全投影的批次摘要与任务事实。" }),
  partial: Object.freeze({ kind: "warning", label: "部分信息不可用", message: "保留最近一次完整快照；请刷新以取得最新摘要与任务页。" }),
  error: Object.freeze({ kind: "error", label: "批次读取失败", message: "尚未获得可显示的完整批次快照。" }),
  terminal: Object.freeze({ kind: "warning", label: "批次已结束", message: "该批次处于终态，自动刷新已经停止。" }),
  writing: Object.freeze({ kind: "running", label: "正在写入", message: "操作完成后将只进行一次权威摘要与任务页重读。" }),
} satisfies Record<TasksPhase, { readonly kind: StatusKind; readonly label: string; readonly message: string }>);

interface SafeRecord {
  readonly descriptors: PropertyDescriptorMap;
}

function safeRecord(value: unknown): SafeRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return { descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return null;
  }
}

function own(record: SafeRecord, key: string): unknown {
  const descriptor = record.descriptors[key];
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function requireRecord(value: unknown, code: string): SafeRecord {
  const record = safeRecord(value);
  if (!record) throw new TypeError(code);
  return record;
}

function safeErrorRecord(value: unknown): SafeRecord | null {
  const record = safeRecord(value);
  if (record || !(value instanceof Error)) return record;
  try {
    return { descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return null;
  }
}

function safeText(value: unknown, fallback = "", maximum = 160): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization|oauth|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function safeId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : "";
}

export function validateBatchId(value: unknown): string {
  const id = safeId(value);
  if (!id || id !== value) throw new TypeError("invalid_batch_id");
  return id;
}

function boundedCount(value: unknown, maximum = 1_000_000_000): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function safeTime(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10_000_000_000 ? number : null;
}

function safeSite(value: unknown): string {
  const site = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SITE_IDS.has(site) ? site : "unknown";
}

function safeStatus(value: unknown, allowed: ReadonlySet<string>, fallback = "failed"): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function statusKind(status: string): StatusKind {
  if (status === "succeeded") return "ready";
  if (["queued", "pending", "planning", "starting", "running", "cancelling"].includes(status)) return "running";
  if (["completed_with_errors", "cancelled"].includes(status)) return "warning";
  return "error";
}

function sanitizeReview(value: unknown, batchId: string): BatchReviewSummary | null {
  const record = safeRecord(value);
  if (!record) return null;
  const status = safeStatus(own(record, "status"), REVIEW_STATUSES, "not_started");
  const kind: StatusKind = ["ready", "applied"].includes(status)
    ? "ready"
    : ACTIVE_REVIEW_STATUSES.has(status)
      ? "running"
      : status === "disabled"
        ? "disabled"
        : ["failed", "apply_failed"].includes(status)
          ? "error"
          : "warning";
  return Object.freeze({
    batchId,
    status,
    label: REVIEW_LABELS[status] ?? status,
    kind,
    totalImageCount: boundedCount(own(record, "total_image_count")),
    duplicateGroupCount: boundedCount(own(record, "duplicate_group_count")),
    decidedGroupCount: boundedCount(own(record, "decided_group_count")),
    totalGroupCount: boundedCount(own(record, "total_group_count")),
  });
}

function sanitizeAddress(value: unknown, fallbackOrder: number): BatchAddress | null {
  const record = safeRecord(value);
  if (!record) return null;
  const id = safeId(own(record, "id"));
  if (!id) return null;
  const status = safeStatus(own(record, "status"), BATCH_STATUSES);
  return Object.freeze({
    id,
    order: boundedCount(own(record, "address_order"), 100_000) || fallbackOrder,
    label: safeText(own(record, "label"), "未命名来源", 140),
    addressType: safeText(own(record, "address_type"), "来源地址", 60),
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    statusKind: statusKind(status),
    plannedTaskCount: boundedCount(own(record, "planned_task_count")),
    succeededTaskCount: boundedCount(own(record, "succeeded_task_count")),
    failedTaskCount: boundedCount(own(record, "failed_task_count")),
    cancelledTaskCount: boundedCount(own(record, "cancelled_task_count")),
    preDedupSkippedCount: boundedCount(own(record, "pre_dedup_skipped_count")),
    probedProxyCount: boundedCount(own(record, "probed_proxy_count")),
    healthyProxyCount: boundedCount(own(record, "healthy_proxy_count")),
    hasPlanningIssue: Boolean(safeText(
      own(record, "planning_error") || own(record, "last_error"),
      "",
      10,
    )),
  });
}

function sanitizeSources(value: unknown): readonly BatchSource[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const sources: BatchSource[] = [];
  for (const raw of value.slice(0, 20)) {
    const record = safeRecord(raw);
    if (!record) continue;
    const site = safeSite(own(record, "site"));
    if (site === "unknown") continue;
    const status = safeStatus(own(record, "status"), BATCH_STATUSES);
    const addresses: BatchAddress[] = [];
    const rawAddresses = own(record, "addresses");
    if (Array.isArray(rawAddresses)) {
      for (const item of rawAddresses.slice(0, 500)) {
        const address = sanitizeAddress(item, addresses.length);
        if (address) addresses.push(address);
      }
    }
    sources.push(Object.freeze({
      order: boundedCount(own(record, "order"), 100_000) || sources.length,
      site,
      status,
      statusLabel: STATUS_LABELS[status] ?? status,
      statusKind: statusKind(status),
      preDedupSkippedCount: boundedCount(own(record, "pre_dedup_skipped_count")),
      addresses: Object.freeze(addresses),
    }));
  }
  return Object.freeze(sources);
}

function sanitizeCurrent(value: unknown): BatchCurrentAddress | null {
  const record = safeRecord(value);
  if (!record) return null;
  const addressId = safeId(own(record, "address_id"));
  if (!addressId) return null;
  const status = safeStatus(own(record, "status"), BATCH_STATUSES);
  return Object.freeze({
    addressId,
    site: safeSite(own(record, "site")),
    sourceOrder: boundedCount(own(record, "source_order"), 100_000),
    addressOrder: boundedCount(own(record, "address_order"), 100_000),
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
  });
}

export function sanitizeBatchSummary(value: unknown, expectedId?: string): BatchSummary {
  const record = requireRecord(value, "invalid_batch_summary");
  const id = safeId(own(record, "id"));
  if (!id || (expectedId !== undefined && id !== validateBatchId(expectedId))) {
    throw new TypeError("invalid_batch_id");
  }
  const status = safeStatus(own(record, "status"), BATCH_STATUSES);
  return Object.freeze({
    id,
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    statusKind: statusKind(status),
    createdAt: safeTime(own(record, "created_at")),
    updatedAt: safeTime(own(record, "updated_at")),
    finishedAt: safeTime(own(record, "finished_at")),
    cancelRequested: Boolean(own(record, "cancel_requested")),
    concurrency: boundedCount(own(record, "concurrency"), 128),
    maxTasks: boundedCount(own(record, "max_tasks"), 100_000),
    taskCount: boundedCount(own(record, "task_count")),
    succeededTaskCount: boundedCount(own(record, "succeeded_task_count")),
    failedTaskCount: boundedCount(own(record, "failed_task_count")),
    cancelledTaskCount: boundedCount(own(record, "cancelled_task_count")),
    preDedupSkippedCount: boundedCount(own(record, "pre_dedup_skipped_count")),
    resumable: Boolean(own(record, "resumable")),
    current: sanitizeCurrent(own(record, "current")),
    sources: sanitizeSources(own(record, "sources")),
    addressesTruncated: own(record, "address_rows_truncated") === true,
    review: sanitizeReview(own(record, "review"), id),
  });
}

export function taskErrorCategory(value: unknown): TaskErrorCategory | null {
  const errorClass = safeText(value, "", 80).toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  if (!errorClass) return null;
  if (/auth|credential|cookie|oauth|login/.test(errorClass)) return TASK_ERROR_CATEGORIES.authentication;
  if (/proxy/.test(errorClass)) return TASK_ERROR_CATEGORIES.proxy;
  if (/rate|429|throttle/.test(errorClass)) return TASK_ERROR_CATEGORIES.rate_limit;
  if (/network|timeout|connection|dns|tls/.test(errorClass)) return TASK_ERROR_CATEGORIES.network;
  if (/storage|artifact|write|disk|file/.test(errorClass)) return TASK_ERROR_CATEGORIES.storage;
  if (/cancel/.test(errorClass)) return TASK_ERROR_CATEGORIES.cancelled;
  if (/extract|gallery|metadata|parse/.test(errorClass)) return TASK_ERROR_CATEGORIES.extraction;
  return TASK_ERROR_CATEGORIES.unknown;
}

function sanitizeTask(value: unknown): TaskEntity | null {
  const record = safeRecord(value);
  if (!record) return null;
  const id = safeId(own(record, "id"));
  if (!id) return null;
  const status = safeStatus(own(record, "status"), TASK_STATUSES);
  const errorClass = safeText(
    own(record, "error_class") || own(record, "last_error_class"),
    "",
    80,
  ).toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  return Object.freeze({
    id,
    site: safeSite(own(record, "site")),
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    statusKind: statusKind(status),
    sourceOrder: boundedCount(own(record, "source_order"), 100_000),
    addressOrder: boundedCount(own(record, "address_order"), 100_000),
    sequence: boundedCount(own(record, "sequence_no"), 1_000_000),
    attemptCount: boundedCount(own(record, "attempt_count"), 1_000),
    maxAttempts: boundedCount(own(record, "max_attempts"), 1_000),
    addressId: safeId(own(record, "crawl_address_id") || own(record, "address_id")),
    artifactCount: boundedCount(own(record, "artifact_count")),
    artifactBytes: boundedCount(own(record, "artifact_bytes"), Number.MAX_SAFE_INTEGER),
    errorClass,
    errorCategory: taskErrorCategory(errorClass),
    terminal: TERMINAL_TASK_STATUSES.has(status),
  });
}

export function sanitizeTaskPage(value: unknown, query: TaskPageQuery): TaskPageSnapshot {
  const batchId = validateBatchId(query.batchId);
  const offset = boundedCount(query.offset, Number.MAX_SAFE_INTEGER);
  if (offset !== query.offset || offset % TASK_PAGE_LIMIT !== 0) throw new TypeError("invalid_task_offset");
  if (query.addressId && !safeId(query.addressId)) throw new TypeError("invalid_address_id");
  const record = requireRecord(value, "invalid_task_page");
  const rawItems = own(record, "items");
  if (!Array.isArray(rawItems)) throw new TypeError("invalid_task_page");
  const responseLimit = own(record, "limit");
  const responseOffset = own(record, "offset");
  if (responseLimit !== undefined && responseLimit !== TASK_PAGE_LIMIT) throw new TypeError("invalid_task_page_limit");
  if (responseOffset !== undefined && responseOffset !== offset) throw new TypeError("invalid_task_page_offset");

  const seen = new Set<string>();
  const items: TaskEntity[] = [];
  for (const raw of rawItems.slice(0, TASK_PAGE_LIMIT)) {
    const task = sanitizeTask(raw);
    if (!task) continue;
    if (seen.has(task.id)) throw new TypeError("duplicate_task_id");
    seen.add(task.id);
    items.push(task);
  }
  return Object.freeze({
    batchId,
    offset,
    addressId: query.addressId,
    limit: TASK_PAGE_LIMIT,
    items: Object.freeze(items),
  });
}

export function sanitizeRecentBatches(value: unknown): readonly RecentBatch[] {
  const record = requireRecord(value, "invalid_recent_batches");
  const rawItems = own(record, "items");
  if (!Array.isArray(rawItems)) throw new TypeError("invalid_recent_batches");
  const seen = new Set<string>();
  const items: RecentBatch[] = [];
  for (const raw of rawItems.slice(0, 30)) {
    const item = safeRecord(raw);
    if (!item) continue;
    const id = safeId(own(item, "id"));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const status = safeStatus(own(item, "status"), BATCH_STATUSES);
    items.push(Object.freeze({
      id,
      status,
      statusLabel: STATUS_LABELS[status] ?? status,
      statusKind: statusKind(status),
      createdAt: safeTime(own(item, "created_at")),
      taskCount: boundedCount(own(item, "task_count")),
      succeededTaskCount: boundedCount(own(item, "succeeded_task_count")),
      failedTaskCount: boundedCount(own(item, "failed_task_count")),
      terminal: TERMINAL_BATCH_STATUSES.has(status),
    }));
  }
  return Object.freeze(items);
}

export function recentBatchFromSummary(summary: BatchSummary): RecentBatch {
  return Object.freeze({
    id: summary.id,
    status: summary.status,
    statusLabel: summary.statusLabel,
    statusKind: summary.statusKind,
    createdAt: summary.createdAt,
    taskCount: summary.taskCount,
    succeededTaskCount: summary.succeededTaskCount,
    failedTaskCount: summary.failedTaskCount,
    terminal: TERMINAL_BATCH_STATUSES.has(summary.status),
  });
}

export function filterRecentBatches(items: readonly RecentBatch[], filter: RecentFilter): readonly RecentBatch[] {
  if (!RECENT_FILTERS.has(filter)) throw new TypeError("invalid_recent_filter");
  if (filter === "all") return items;
  if (filter === "active") return items.filter(({ status }) => ACTIVE_BATCH_STATUSES.has(status));
  if (filter === "attention") {
    return items.filter(({ status }) => ["completed_with_errors", "cancelled", "failed"].includes(status));
  }
  return items.filter(({ status }) => TERMINAL_BATCH_STATUSES.has(status));
}

export function shouldPollBatch(summary: BatchSummary | null): boolean {
  return Boolean(summary && !TERMINAL_BATCH_STATUSES.has(summary.status));
}

export function deriveBatchProgress(summary: BatchSummary | null) {
  if (!summary) return Object.freeze({ terminal: 0, total: 0, percent: 0 });
  const terminal = summary.succeededTaskCount + summary.failedTaskCount + summary.cancelledTaskCount;
  const percent = summary.taskCount
    ? Math.min(100, Math.round((terminal / summary.taskCount) * 100))
    : TERMINAL_BATCH_STATUSES.has(summary.status) ? 100 : 0;
  return Object.freeze({ terminal, total: summary.taskCount, percent });
}

export function taskPageTotal(summary: BatchSummary | null, addressId: string): number {
  if (!summary) return 0;
  if (!addressId) return summary.taskCount;
  for (const source of summary.sources) {
    const address = source.addresses.find(({ id }) => id === addressId);
    if (address) return address.plannedTaskCount;
  }
  return 0;
}

export function taskPageCount(summary: BatchSummary | null, addressId: string): number {
  return Math.max(1, Math.ceil(taskPageTotal(summary, addressId) / TASK_PAGE_LIMIT));
}

export function deriveTaskFileFacts(tasks: readonly TaskEntity[]) {
  let taskWithFilesCount = 0;
  let artifactCount = 0;
  let artifactBytes = 0;
  for (const task of tasks) {
    if (task.artifactCount || task.artifactBytes) taskWithFilesCount += 1;
    artifactCount += task.artifactCount;
    artifactBytes += task.artifactBytes;
  }
  return Object.freeze({ taskCount: tasks.length, taskWithFilesCount, artifactCount, artifactBytes });
}

export function deriveTaskErrorFacts(tasks: readonly TaskEntity[]) {
  const counts = new Map<string, { category: TaskErrorCategory; count: number }>();
  for (const task of tasks) {
    if (!task.errorCategory) continue;
    const current = counts.get(task.errorCategory.id);
    counts.set(task.errorCategory.id, { category: task.errorCategory, count: (current?.count ?? 0) + 1 });
  }
  return Object.freeze([...counts.values()].map((fact) => Object.freeze(fact)));
}

export function deriveTaskRecovery(tasks: readonly TaskEntity[]) {
  const authSites = new Set<string>();
  let proxyIssue = false;
  for (const task of tasks) {
    if (task.errorCategory?.id === "authentication" && task.site !== "unknown") authSites.add(task.site);
    if (["proxy", "network", "rate_limit"].includes(task.errorCategory?.id ?? "")) proxyIssue = true;
  }
  return Object.freeze({ authSites: Object.freeze([...authSites]), proxyIssue });
}

export function deriveWorkspacePresentation(phase: TasksPhase) {
  return WORKSPACE_COPY[phase];
}

export function deriveOperationAvailability(summary: BatchSummary | null, busy: TasksOperation | "load" | "refresh" | "") {
  const terminal = Boolean(summary && TERMINAL_BATCH_STATUSES.has(summary.status));
  return Object.freeze({
    cancel: !busy && Boolean(summary) && !terminal && !summary?.cancelRequested && summary?.status !== "cancelling",
    retry: !busy && Boolean(summary?.resumable) && terminal,
    rerun: !busy && Boolean(summary) && terminal,
  });
}

export function tasksErrorPresentation(error: unknown): TasksErrorPresentation {
  const record = safeErrorRecord(error);
  const code = safeText(record ? own(record, "code") : "", "request_failed", 128)
    .replace(/[^A-Za-z0-9._:-]/g, "") || "request_failed";
  const rawStatus = record ? own(record, "status") : 0;
  const status = Number.isInteger(rawStatus) && Number(rawStatus) >= 0 ? Number(rawStatus) : 0;
  const requestId = safeId(record ? own(record, "requestId") : "");
  const missing = code === "crawl_not_found" || status === 404;
  const conflict = status === 409;
  const validation = status === 422;
  const auth = /auth|credential|cookie|oauth|login/i.test(code);
  const proxy = /proxy/i.test(code);
  return Object.freeze({
    code,
    status,
    requestId,
    missing,
    targetApp: auth ? "vault" : proxy ? "proxy" : "diagnostics",
    title: missing ? "批次不存在" : conflict ? "批次状态已变化" : validation ? "批次参数无效" : "批次操作失败",
    message: status === 0 ? "无法连接到 LDOS 服务。" : validation ? "服务拒绝了本次批次参数。" : "服务未接受本次批次操作。",
    nextStep: missing
      ? "请选择其他最近批次。"
      : conflict
        ? "已保留当前快照；请根据权威重读后的可用操作继续。"
        : auth
          ? "打开授权管理修复授权后，再重试未完成项。"
          : proxy
            ? "打开代理管理检查代理池后，再重试未完成项。"
            : "保留当前批次，刷新或打开系统诊断检查连接。",
  });
}

export function formatTaskBytes(value: number): string {
  const bytes = boundedCount(value, Number.MAX_SAFE_INTEGER);
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** index);
  return `${index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

export function formatBatchTime(value: number | null): string {
  if (value === null) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(value * 1_000));
  } catch {
    return "—";
  }
}

export function shortBatchId(value: string): string {
  const id = safeId(value);
  if (!id) return "—";
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function siteLabel(site: string): string {
  return ({
    danbooru: "Danbooru",
    twitter: "X / Twitter",
    pixiv: "Pixiv",
    exhentai: "EH",
    pawchive: "Pawchive",
  } as Readonly<Record<string, string>>)[site] ?? "未知来源";
}
