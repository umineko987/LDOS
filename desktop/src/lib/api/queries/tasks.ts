// 下载任务（gallery-dl 子进程）：任务列表、单个任务的日志尾部和事件时间线。
// 日志在后端写入时已脱敏（redact_text），这里只去掉控制字符并限制条数。

import { queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { boundedCount, isPlainRecord, ownValue } from "../sanitize.ts";
import { safeId, safeStatus, timestamp } from "./crawls.ts";
import { plainText } from "./jobs.ts";
import { ContractError } from "./system.ts";

export const TASK_LIST_LIMIT = 100;
export const TASK_LOG_TAIL = 300;

export type TaskFilter = "all" | "running" | "failed";

export const taskKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskKeys.all, "list"] as const,
  list: (filter: TaskFilter) => [...taskKeys.lists(), filter] as const,
  logs: (taskId: string) => [...taskKeys.all, "logs", taskId] as const,
  events: (taskId: string) => [...taskKeys.all, "events", taskId] as const,
};

export interface DownloadTask {
  readonly id: string;
  readonly site: string;
  readonly status: string;
  /** 只保留主机和路径，查询串里可能有令牌。 */
  readonly target: string;
  readonly createdAt: number | null;
  readonly finishedAt: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly errorClass: string;
  readonly lastError: string;
}

export interface TaskLogLine {
  readonly id: number;
  readonly ts: number | null;
  readonly stream: "stdout" | "stderr" | "backend";
  readonly line: string;
}

export interface TaskEvent {
  readonly id: number;
  readonly ts: number | null;
  readonly type: string;
}

const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/** `https://host/path?token=…` → `host/path`。不是 http(s) 地址时返回空串。 */
export function displayTarget(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return plainText(`${url.host}${url.pathname === "/" ? "" : decodeSafely(url.pathname)}`, 200);
  } catch {
    return "";
  }
}

function decodeSafely(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function items(value: unknown, code: string, maximum: number): Record<string, unknown>[] {
  if (!isPlainRecord(value)) throw new ContractError(code);
  const raw = ownValue(value, "items");
  return Array.isArray(raw) ? raw.slice(0, maximum).filter(isPlainRecord) : [];
}

export function sanitizeTaskList(value: unknown): DownloadTask[] {
  const result: DownloadTask[] = [];
  for (const item of items(value, "invalid_task_list", 500)) {
    const id = safeId(ownValue(item, "id"));
    if (!id) continue;
    result.push(
      Object.freeze({
        id,
        site: plainText(ownValue(item, "site"), 128),
        status: safeStatus(ownValue(item, "status")),
        target: displayTarget(ownValue(item, "url")),
        createdAt: timestamp(ownValue(item, "created_at")),
        finishedAt: timestamp(ownValue(item, "finished_at")),
        attempts: boundedCount(ownValue(item, "attempt_count"), 1_000),
        maxAttempts: boundedCount(ownValue(item, "max_attempts"), 1_000),
        artifactCount: boundedCount(ownValue(item, "artifact_count")),
        artifactBytes: boundedCount(ownValue(item, "artifact_bytes"), Number.MAX_SAFE_INTEGER),
        errorClass: plainText(ownValue(item, "last_error_class"), 80),
        lastError: plainText(ownValue(item, "last_error"), 500),
      }),
    );
  }
  return result;
}

/** 日志行保留缩进（只把制表符换成空格），去掉其余控制字符。 */
function logText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 2_000);
}

export function sanitizeTaskLogs(value: unknown): TaskLogLine[] {
  return items(value, "invalid_task_logs", TASK_LOG_TAIL).map((item) => {
    const stream = ownValue(item, "stream");
    return Object.freeze({
      id: boundedCount(ownValue(item, "id"), Number.MAX_SAFE_INTEGER),
      ts: timestamp(ownValue(item, "ts")),
      stream: stream === "stderr" || stream === "backend" ? stream : "stdout",
      line: logText(ownValue(item, "line")),
    });
  });
}

export function sanitizeTaskEvents(value: unknown): TaskEvent[] {
  const result: TaskEvent[] = [];
  for (const item of items(value, "invalid_task_events", 500)) {
    const type = ownValue(item, "event_type");
    if (typeof type !== "string" || !EVENT_TYPE.test(type)) continue;
    result.push(
      Object.freeze({
        id: boundedCount(ownValue(item, "id"), Number.MAX_SAFE_INTEGER),
        ts: timestamp(ownValue(item, "ts")),
        type,
      }),
    );
  }
  return result;
}

const FILTER_STATUS: Readonly<Record<TaskFilter, string | undefined>> = {
  all: undefined,
  running: "running",
  failed: "failed",
};

export function tasksQuery(api: Api, filter: TaskFilter) {
  return queryOptions({
    queryKey: taskKeys.list(filter),
    queryFn: async ({ signal }) =>
      sanitizeTaskList(
        await data(
          api.client.GET("/api/v1/tasks", {
            params: { query: { limit: TASK_LIST_LIMIT, status: FILTER_STATUS[filter] } },
            signal,
          }),
        ),
      ),
  });
}

export function taskLogsQuery(api: Api, taskId: string) {
  return queryOptions({
    queryKey: taskKeys.logs(taskId),
    queryFn: async ({ signal }) =>
      sanitizeTaskLogs(
        await data(
          api.client.GET("/api/v1/tasks/{task_id}/logs", {
            params: { path: { task_id: taskId }, query: { tail: TASK_LOG_TAIL } },
            signal,
          }),
        ),
      ),
  });
}

export function taskEventsQuery(api: Api, taskId: string) {
  return queryOptions({
    queryKey: taskKeys.events(taskId),
    queryFn: async ({ signal }) =>
      sanitizeTaskEvents(
        await data(api.client.GET("/api/v1/tasks/{task_id}/events", { params: { path: { task_id: taskId } }, signal })),
      ),
  });
}
