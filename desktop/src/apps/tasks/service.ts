import type { ApiClient } from "../../core/api/client";
import {
  TASK_PAGE_LIMIT,
  sanitizeBatchSummary,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  validateBatchId,
  type RecentBatch,
  type TaskPageQuery,
  type TasksAuthoritySnapshot,
  type TasksOperation,
} from "./model";

export const TASKS_ENDPOINTS = Object.freeze({ crawls: "/api/v1/crawls" });

export interface TasksService {
  readRecent(signal: AbortSignal): Promise<readonly RecentBatch[]>;
  readAuthority(query: TaskPageQuery, signal: AbortSignal): Promise<TasksAuthoritySnapshot>;
  write(operation: TasksOperation, batchId: string, signal: AbortSignal): Promise<void>;
}

export function taskBatchPath(batchId: string, suffix = ""): string {
  return `${TASKS_ENDPOINTS.crawls}/${encodeURIComponent(validateBatchId(batchId))}${suffix}`;
}

export function taskPagePath(query: TaskPageQuery): string {
  const offset = Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset % TASK_PAGE_LIMIT !== 0) {
    throw new TypeError("invalid_task_offset");
  }
  const address = query.addressId
    ? `&address_id=${encodeURIComponent(validateBatchId(query.addressId))}`
    : "";
  return taskBatchPath(
    query.batchId,
    `/tasks?limit=${TASK_PAGE_LIMIT}&offset=${offset}${address}`,
  );
}

export function createTasksService(api: ApiClient): TasksService {
  return Object.freeze({
    async readRecent(signal: AbortSignal) {
      return sanitizeRecentBatches(await api.get(`${TASKS_ENDPOINTS.crawls}?limit=30`, { signal }));
    },
    async readAuthority(query: TaskPageQuery, signal: AbortSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      try {
        const [rawSummary, rawPage] = await Promise.all([
          api.get(taskBatchPath(query.batchId), { signal: controller.signal }),
          api.get(taskPagePath(query), { signal: controller.signal }),
        ]);
        return Object.freeze({
          summary: sanitizeBatchSummary(rawSummary, query.batchId),
          page: sanitizeTaskPage(rawPage, query),
        });
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async write(operation: TasksOperation, batchId: string, signal: AbortSignal) {
      if (operation === "retry") {
        await api.post(taskBatchPath(batchId, "/retry"), { additional_attempts: 2 }, { signal });
        return;
      }
      if (operation === "cancel" || operation === "rerun") {
        await api.post(taskBatchPath(batchId, `/${operation}`), {}, { signal });
        return;
      }
      throw new TypeError("invalid_tasks_operation");
    },
  });
}
