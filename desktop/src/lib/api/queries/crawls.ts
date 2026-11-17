// 采集批次：列表（view=desktop）、批次详情（view=desktop 的安全投影）、批次内任务（view=tasks），
// 以及取消 / 重试失败 / 重新运行。响应模型是宽松的透传模型，这里按字段消毒成界面用的类型。

import { queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { boundedCount, isPlainRecord, ownRecord, ownValue } from "../sanitize.ts";
import { plainText } from "./jobs.ts";
import { ContractError } from "./system.ts";

export const CRAWL_LIST_LIMIT = 100;
export const CRAWL_TASK_PAGE = 100;
const CRAWL_POLL_MS = 2_000;

export const crawlKeys = {
  all: ["crawls"] as const,
  lists: () => [...crawlKeys.all, "list"] as const,
  list: (limit: number) => [...crawlKeys.lists(), limit] as const,
  details: () => [...crawlKeys.all, "detail"] as const,
  detail: (batchId: string) => [...crawlKeys.details(), batchId] as const,
  tasks: (batchId: string) => [...crawlKeys.all, "tasks", batchId] as const,
  taskPage: (batchId: string, offset: number) => [...crawlKeys.tasks(batchId), offset] as const,
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATUS = /^[a-z][a-z0-9_]{0,31}$/;
const ACTIVE_BATCH: ReadonlySet<string> = new Set(["queued", "pending", "planning", "starting", "running", "cancelling"]);
const TERMINAL_BATCH: ReadonlySet<string> = new Set(["succeeded", "completed_with_errors", "failed", "cancelled"]);
const TERMINAL_TASK: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export function isActiveBatchStatus(status: string): boolean {
  return ACTIVE_BATCH.has(status);
}

/** 只有终态批次能重试和重新规划（与旧版一致）。 */
export function isTerminalBatchStatus(status: string): boolean {
  return TERMINAL_BATCH.has(status);
}

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK.has(status);
}

export function validBatchId(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

export function safeId(value: unknown): string {
  return typeof value === "string" && ID.test(value) ? value : "";
}

export function safeStatus(value: unknown): string {
  return typeof value === "string" && STATUS.test(value) ? value : "unknown";
}

export function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 列表里的计数字段：后端没给（旧投影）时为 null，界面就不显示。 */
function optionalCount(record: Record<string, unknown>, key: string): number | null {
  const value = ownValue(record, key);
  return value === undefined || value === null ? null : boundedCount(value);
}

function records(value: unknown, maximum: number): Record<string, unknown>[] {
  return Array.isArray(value) ? value.slice(0, maximum).filter(isPlainRecord) : [];
}

export interface CrawlBatchSummary {
  readonly id: string;
  readonly status: string;
  readonly createdAt: number | null;
  readonly taskCount: number | null;
  readonly succeeded: number | null;
  readonly failed: number | null;
}

export interface CrawlAddress {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly type: string;
  readonly status: string;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly preDedupSkipped: number;
  readonly planningError: string;
}

export interface CrawlSource {
  readonly order: number;
  readonly site: string;
  readonly status: string;
  readonly preDedupSkipped: number;
  readonly addresses: readonly CrawlAddress[];
}

export interface CrawlCurrent {
  readonly addressId: string;
  readonly site: string;
  readonly sourceOrder: number;
  readonly addressOrder: number;
  readonly status: string;
}

export interface CrawlReview {
  readonly status: string;
  readonly totalImages: number;
  readonly duplicateGroups: number;
  readonly decidedGroups: number;
  readonly totalGroups: number;
}

export interface CrawlBatch {
  readonly id: string;
  readonly status: string;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly finishedAt: number | null;
  readonly cancelRequested: boolean;
  readonly concurrency: number;
  readonly maxTasks: number;
  readonly taskCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly preDedupSkipped: number;
  readonly resumable: boolean;
  readonly current: CrawlCurrent | null;
  readonly sources: readonly CrawlSource[];
  readonly addressesTruncated: boolean;
  readonly review: CrawlReview | null;
}

export interface CrawlTask {
  readonly id: string;
  readonly site: string;
  readonly status: string;
  readonly sourceOrder: number;
  readonly addressOrder: number;
  readonly sequence: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly addressId: string;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly errorClass: string;
}

export interface CrawlTaskPage {
  readonly offset: number;
  readonly items: readonly CrawlTask[];
  /** 这一页装满了：可能还有下一页。 */
  readonly hasMore: boolean;
}

export function sanitizeBatchList(value: unknown): CrawlBatchSummary[] {
  if (!isPlainRecord(value)) throw new ContractError("invalid_crawl_list");
  const items: CrawlBatchSummary[] = [];
  for (const item of records(ownValue(value, "items"), 500)) {
    const id = validBatchId(ownValue(item, "id"));
    if (!id) continue;
    items.push(
      Object.freeze({
        id,
        status: safeStatus(ownValue(item, "status")),
        createdAt: timestamp(ownValue(item, "created_at")),
        taskCount: optionalCount(item, "task_count"),
        succeeded: optionalCount(item, "succeeded_task_count"),
        failed: optionalCount(item, "failed_task_count"),
      }),
    );
  }
  return items;
}

function sanitizeAddress(item: Record<string, unknown>): CrawlAddress {
  return Object.freeze({
    id: safeId(ownValue(item, "id")),
    order: boundedCount(ownValue(item, "address_order")),
    label: plainText(ownValue(item, "label"), 200),
    type: plainText(ownValue(item, "address_type"), 100),
    status: safeStatus(ownValue(item, "status")),
    planned: boundedCount(ownValue(item, "planned_task_count")),
    succeeded: boundedCount(ownValue(item, "succeeded_task_count")),
    failed: boundedCount(ownValue(item, "failed_task_count")),
    cancelled: boundedCount(ownValue(item, "cancelled_task_count")),
    preDedupSkipped: boundedCount(ownValue(item, "pre_dedup_skipped_count")),
    planningError: plainText(ownValue(item, "planning_error"), 500),
  });
}

export function sanitizeBatch(value: unknown): CrawlBatch {
  if (!isPlainRecord(value)) throw new ContractError("invalid_crawl_batch");
  const id = validBatchId(ownValue(value, "id"));
  if (!id) throw new ContractError("invalid_crawl_batch");
  const current = ownRecord(value, "current");
  const review = ownRecord(value, "review");
  return Object.freeze({
    id,
    status: safeStatus(ownValue(value, "status")),
    createdAt: timestamp(ownValue(value, "created_at")),
    updatedAt: timestamp(ownValue(value, "updated_at")),
    finishedAt: timestamp(ownValue(value, "finished_at")),
    cancelRequested: ownValue(value, "cancel_requested") === true,
    concurrency: boundedCount(ownValue(value, "concurrency"), 1_000),
    maxTasks: boundedCount(ownValue(value, "max_tasks")),
    taskCount: boundedCount(ownValue(value, "task_count")),
    succeeded: boundedCount(ownValue(value, "succeeded_task_count")),
    failed: boundedCount(ownValue(value, "failed_task_count")),
    cancelled: boundedCount(ownValue(value, "cancelled_task_count")),
    preDedupSkipped: boundedCount(ownValue(value, "pre_dedup_skipped_count")),
    resumable: ownValue(value, "resumable") === true,
    current: current
      ? Object.freeze({
          addressId: safeId(ownValue(current, "address_id")),
          site: plainText(ownValue(current, "site"), 128),
          sourceOrder: boundedCount(ownValue(current, "source_order")),
          addressOrder: boundedCount(ownValue(current, "address_order")),
          status: safeStatus(ownValue(current, "status")),
        })
      : null,
    sources: Object.freeze(
      records(ownValue(value, "sources"), 20).map((source) =>
        Object.freeze({
          order: boundedCount(ownValue(source, "order")),
          site: plainText(ownValue(source, "site"), 128),
          status: safeStatus(ownValue(source, "status")),
          preDedupSkipped: boundedCount(ownValue(source, "pre_dedup_skipped_count")),
          addresses: Object.freeze(records(ownValue(source, "addresses"), 500).map(sanitizeAddress)),
        }),
      ),
    ),
    addressesTruncated: ownValue(value, "address_rows_truncated") === true,
    review: review
      ? Object.freeze({
          status: safeStatus(ownValue(review, "status")),
          totalImages: boundedCount(ownValue(review, "total_image_count")),
          duplicateGroups: boundedCount(ownValue(review, "duplicate_group_count")),
          decidedGroups: boundedCount(ownValue(review, "decided_group_count")),
          totalGroups: boundedCount(ownValue(review, "total_group_count")),
        })
      : null,
  });
}

export function sanitizeCrawlTask(item: Record<string, unknown>): CrawlTask | null {
  const id = validBatchId(ownValue(item, "id"));
  if (!id) return null;
  return Object.freeze({
    id,
    site: plainText(ownValue(item, "site"), 128),
    status: safeStatus(ownValue(item, "status")),
    sourceOrder: boundedCount(ownValue(item, "source_order")),
    addressOrder: boundedCount(ownValue(item, "address_order")),
    sequence: boundedCount(ownValue(item, "sequence_no")),
    attempts: boundedCount(ownValue(item, "attempt_count"), 1_000),
    maxAttempts: boundedCount(ownValue(item, "max_attempts"), 1_000),
    addressId: safeId(ownValue(item, "crawl_address_id")),
    artifactCount: boundedCount(ownValue(item, "artifact_count")),
    artifactBytes: boundedCount(ownValue(item, "artifact_bytes"), Number.MAX_SAFE_INTEGER),
    errorClass: plainText(ownValue(item, "last_error_class"), 80),
  });
}

export function sanitizeCrawlTaskPage(value: unknown, offset: number): CrawlTaskPage {
  if (!isPlainRecord(value)) throw new ContractError("invalid_crawl_tasks");
  const raw = records(ownValue(value, "items"), CRAWL_TASK_PAGE);
  const items = raw.map(sanitizeCrawlTask).filter((task): task is CrawlTask => task !== null);
  return Object.freeze({ offset, items: Object.freeze(items), hasMore: raw.length >= CRAWL_TASK_PAGE });
}

export function crawlBatchesQuery(api: Api, limit = CRAWL_LIST_LIMIT) {
  return queryOptions({
    queryKey: crawlKeys.list(limit),
    queryFn: async ({ signal }) =>
      sanitizeBatchList(
        await data(api.client.GET("/api/v1/crawls", { params: { query: { view: "desktop", limit } }, signal })),
      ),
  });
}

export function crawlBatchQuery(api: Api, batchId: string) {
  return queryOptions({
    queryKey: crawlKeys.detail(batchId),
    queryFn: async ({ signal }) =>
      sanitizeBatch(
        await data(
          api.client.GET("/api/v1/crawls/{batch_id}", {
            params: { path: { batch_id: batchId }, query: { view: "desktop" } },
            signal,
          }),
        ),
      ),
    refetchInterval: (query) =>
      query.state.data && isActiveBatchStatus(query.state.data.status) ? CRAWL_POLL_MS : false,
  });
}

export function crawlTasksQuery(api: Api, batchId: string, offset: number, batchStatus?: string) {
  return queryOptions({
    queryKey: crawlKeys.taskPage(batchId, offset),
    queryFn: async ({ signal }) =>
      sanitizeCrawlTaskPage(
        await data(
          api.client.GET("/api/v1/crawls/{batch_id}/tasks", {
            params: { path: { batch_id: batchId }, query: { view: "tasks", limit: CRAWL_TASK_PAGE, offset } },
            signal,
          }),
        ),
        offset,
      ),
    // 批次可能先读到终态，仍要刷新缓存中尚未结束的任务行。
    refetchInterval: (query) =>
      isActiveBatchStatus(batchStatus ?? "") || query.state.data?.items.some((task) => !isTerminalTaskStatus(task.status))
        ? CRAWL_POLL_MS
        : false,
  });
}

export type CrawlOperation = "cancel" | "retry" | "rerun";

/** 写操作只返回状态投影，调用方随后让详情和任务页失效。重试额外给两次机会（与旧版一致）；重新规划显式写出后端默认值。 */
export async function runCrawlOperation(api: Api, batchId: string, operation: CrawlOperation): Promise<void> {
  const params = { path: { batch_id: batchId }, query: { view: "desktop" as const } };
  if (operation === "cancel") await data(api.client.POST("/api/v1/crawls/{batch_id}/cancel", { params }));
  else if (operation === "retry")
    await data(api.client.POST("/api/v1/crawls/{batch_id}/retry", { params, body: { additional_attempts: 2 } }));
  else await data(api.client.POST("/api/v1/crawls/{batch_id}/rerun", { params, body: { additional_attempts: 1, requeue_succeeded: false } }));
}
