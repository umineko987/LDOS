// 统一任务（Job）：GET /api/v1/jobs 的快照，以及 SSE `job.updated` 载荷的校验。
// 两条路径进来的 Job 都先过 sanitizeJob，界面只接触消毒后的冻结对象。

import type { Job } from "#lib/events/bus.ts";

import { data, type Api } from "../client.ts";
import { boundedCount, isPlainRecord, ownValue } from "../sanitize.ts";
import { ContractError } from "./system.ts";

export type { Job };

export type JobStatus = Job["status"];

export interface JobSnapshot {
  readonly items: readonly Job[];
  /** SSE 首次连接用它衔接（`?last_event_id=`）；后端没有给出时为空串。 */
  readonly lastEventId: string;
}

const STATUSES: ReadonlySet<string> = new Set<JobStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);
const TERMINAL: ReadonlySet<string> = new Set<JobStatus>(["succeeded", "failed", "cancelled"]);
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const JOB_KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const REF_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_REF_KEYS = 16;
const MAX_JOBS = 1_000;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** 去掉控制字符、压缩空白、截断。后端文案只有中文，原样显示。 */
export function plainText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function countOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : boundedCount(value);
}

function sanitizeRef(value: unknown): Record<string, string> {
  const ref: Record<string, string> = {};
  if (!isPlainRecord(value)) return Object.freeze(ref);
  for (const key of Object.keys(value).slice(0, MAX_REF_KEYS)) {
    const item = ownValue(value, key);
    if (!REF_KEY.test(key) || typeof item !== "string") continue;
    const text = plainText(item, 256);
    if (text) ref[key] = text;
  }
  return Object.freeze(ref);
}

export function sanitizeJob(value: unknown): Job {
  if (!isPlainRecord(value)) throw new ContractError("invalid_job");
  const id = ownValue(value, "id");
  const kind = ownValue(value, "kind");
  const status = ownValue(value, "status");
  const startedAt = seconds(ownValue(value, "started_at"));
  const updatedAt = seconds(ownValue(value, "updated_at"));
  if (typeof id !== "string" || !JOB_ID.test(id)) throw new ContractError("invalid_job");
  if (typeof kind !== "string" || !JOB_KIND.test(kind)) throw new ContractError("invalid_job");
  if (typeof status !== "string" || !STATUSES.has(status)) throw new ContractError("invalid_job");
  if (startedAt === null || updatedAt === null) throw new ContractError("invalid_job");
  const total = countOrNull(ownValue(value, "total"));
  const current = countOrNull(ownValue(value, "current"));
  return Object.freeze({
    id,
    kind,
    title: plainText(ownValue(value, "title"), 200) || kind,
    status: status as JobStatus,
    current: current !== null && total !== null ? Math.min(current, total) : current,
    total,
    message: plainText(ownValue(value, "message"), 500),
    ref: sanitizeRef(ownValue(value, "ref")),
    started_at: startedAt,
    updated_at: updatedAt,
    finished_at: TERMINAL.has(status) ? seconds(ownValue(value, "finished_at")) : null,
  });
}

/** SSE 事件 id（`{epoch}-{seq}`）；不合法时返回空串。 */
export function sanitizeEventId(value: unknown): string {
  return typeof value === "string" && EVENT_ID.test(value) ? value : "";
}

/** 单个坏条目只丢掉它自己，不让整张列表失败。 */
export function sanitizeJobSnapshot(value: unknown): JobSnapshot {
  if (!isPlainRecord(value)) throw new ContractError("invalid_job_list");
  const raw = ownValue(value, "items");
  if (!Array.isArray(raw)) throw new ContractError("invalid_job_list");
  const items: Job[] = [];
  for (const entry of raw.slice(0, MAX_JOBS)) {
    try {
      items.push(sanitizeJob(entry));
    } catch {
      // 跳过不合契约的条目。
    }
  }
  return Object.freeze({ items: Object.freeze(items), lastEventId: sanitizeEventId(ownValue(value, "last_event_id")) });
}

export async function fetchJobSnapshot(api: Api, signal?: AbortSignal): Promise<JobSnapshot> {
  return sanitizeJobSnapshot(await data(api.client.GET("/api/v1/jobs", { signal })));
}
