// 数据集导出桌面模型（G6-1）：后端投影的严格清洗与展示映射。
// 合同来源：
// - desktop/tests/g0-gallery-export-target.test.ts（G0 红线合同）
// - gallery-dl-backend/gdl_backend/dataset_export.py（状态机）
// - gallery-dl-backend/gdl_backend/api_routes/dataset_exports.py（投影）

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** 后端 12 态导出状态机（与 dataset_export.py 一致）。 */
export const EXPORT_JOB_STATES = [
  "draft",
  "preflighting",
  "blocked",
  "ready",
  "staging",
  "paused",
  "failed",
  "staged",
  "committing",
  "completed",
  "discarded",
  "recovery_required",
] as const;

export type ExportJobState = (typeof EXPORT_JOB_STATES)[number];

/** 终态：任务生命周期结束（completed 不可再转移）。 */
export const EXPORT_TERMINAL_STATES: readonly ExportJobState[] = ["completed", "discarded", "failed"];

/** 稳定阻断码（预检 §3.9 + 磁盘空间）。 */
export const EXPORT_BLOCKER_CODES = [
  "txt_missing",
  "txt_empty",
  "txt_invalid_encoding",
  "export_target_conflict",
  "export_disk_space_insufficient",
  "dedup_not_applied",
  "source_not_found",
  "source_offline",
] as const;

export type ExportBlockerCode = (typeof EXPORT_BLOCKER_CODES)[number];

export interface ExportBlocker {
  readonly code: ExportBlockerCode;
  readonly count: number;
}

export interface ExportJobSummary {
  readonly export_id: string;
  readonly status: ExportJobState;
  readonly sample_count: number;
  readonly staged_sample_count: number;
  readonly committed_sample_count: number;
  readonly image_bytes: number;
  readonly txt_bytes: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly error_class: string | null;
  readonly started_at: number | null;
  readonly finished_at: number | null;
}

export interface ExportSourceSelection {
  readonly source_id: string;
  readonly directory_id: string;
  readonly include_descendants: boolean;
  readonly output_alias: string;
}

export interface ExportJobDetail extends ExportJobSummary {
  readonly sources: readonly ExportSourceSelection[];
  readonly blockers: readonly ExportBlocker[];
}

function strictRecord(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid_${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`invalid_${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || !allowed.has(key)) throw new TypeError(`invalid_${label}`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`invalid_${label}`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function idText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > 128) throw new TypeError(`invalid_${label}`);
  return value;
}

function enumFrom<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new TypeError(`invalid_${label}`);
  return value as T;
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

function epochValue(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`invalid_${label}`);
  return value;
}

function nullableIdText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return idText(value, label);
}

function nullableEpoch(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

const JOB_SUMMARY_KEYS = new Set([
  "export_id",
  "status",
  "sample_count",
  "staged_sample_count",
  "committed_sample_count",
  "image_bytes",
  "txt_bytes",
  "error_class",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
]);

export function sanitizeExportJobSummary(raw: unknown): ExportJobSummary {
  const value = strictRecord(raw, JOB_SUMMARY_KEYS, "export_job_summary");
  return Object.freeze({
    export_id: idText(value.export_id, "export_id"),
    status: enumFrom(value.status, EXPORT_JOB_STATES, "export_status"),
    sample_count: nonNegativeInt(value.sample_count, "export_sample_count"),
    staged_sample_count: nonNegativeInt(value.staged_sample_count, "export_staged_count"),
    committed_sample_count: nonNegativeInt(value.committed_sample_count, "export_committed_count"),
    image_bytes: nonNegativeInt(value.image_bytes, "export_image_bytes"),
    txt_bytes: nonNegativeInt(value.txt_bytes, "export_txt_bytes"),
    error_class: nullableIdText(value.error_class, "export_error_class"),
    created_at: epochValue(value.created_at, "export_created_at", 0),
    updated_at: epochValue(value.updated_at, "export_updated_at", 0),
    started_at: nullableEpoch(value.started_at, "export_started_at"),
    finished_at: nullableEpoch(value.finished_at, "export_finished_at"),
  });
}

const BLOCKER_KEYS = new Set(["code", "count"]);

export function sanitizeExportBlocker(raw: unknown): ExportBlocker {
  const value = strictRecord(raw, BLOCKER_KEYS, "export_blocker");
  return Object.freeze({
    code: enumFrom(value.code, EXPORT_BLOCKER_CODES, "export_blocker_code"),
    count: nonNegativeInt(value.count, "export_blocker_count"),
  });
}

const SOURCE_KEYS = new Set([
  "source_id",
  "directory_id",
  "include_descendants",
  "output_alias",
]);

export function sanitizeExportSourceSelection(raw: unknown): ExportSourceSelection {
  const value = strictRecord(raw, SOURCE_KEYS, "export_source_selection");
  return Object.freeze({
    source_id: idText(value.source_id, "export_source_id"),
    directory_id: idText(value.directory_id, "export_directory_id"),
    include_descendants: booleanValue(value.include_descendants, "export_include_descendants"),
    output_alias: idText(value.output_alias, "export_output_alias"),
  });
}

const JOB_DETAIL_KEYS = new Set([...JOB_SUMMARY_KEYS, "sources", "blockers"]);

export function sanitizeExportJobDetail(raw: unknown): ExportJobDetail {
  const value = strictRecord(raw, JOB_DETAIL_KEYS, "export_job_detail");
  if (!Array.isArray(value.sources) || !Array.isArray(value.blockers)) {
    throw new TypeError("invalid_export_job_detail");
  }
  const { sources, blockers, ...summaryRaw } = value;
  return Object.freeze({
    ...sanitizeExportJobSummary(summaryRaw),
    sources: Object.freeze(sources.map(sanitizeExportSourceSelection)),
    blockers: Object.freeze(blockers.map(sanitizeExportBlocker)),
  });
}

/** 状态中文标签（展示层）。 */
export const EXPORT_STATE_LABELS: Readonly<Record<ExportJobState, string>> = Object.freeze({
  draft: "草稿",
  preflighting: "预检中",
  blocked: "已阻断",
  ready: "就绪",
  staging: "暂存中",
  paused: "已暂停",
  failed: "失败",
  staged: "已暂存",
  committing: "提交中",
  completed: "已完成",
  discarded: "已丢弃",
  recovery_required: "待恢复",
});

export const EXPORT_BLOCKER_LABELS: Readonly<Record<ExportBlockerCode, string>> = Object.freeze({
  txt_missing: "缺少同名 TXT",
  txt_empty: "TXT 内容空白",
  txt_invalid_encoding: "TXT 编码异常",
  export_target_conflict: "目标已有同名文件",
  export_disk_space_insufficient: "磁盘空间不足",
  dedup_not_applied: "去重结果尚未应用",
  source_not_found: "来源不存在",
  source_offline: "来源不可用",
});

/** 输出别名规则：非空、无路径分隔符、非保留名（记忆 #44 稳定来源别名目录）。 */
export function validateExportAlias(alias: string): boolean {
  if (!alias.length || alias.length > 64) return false;
  if (/[/\\]/.test(alias)) return false;
  if (alias === "." || alias === ".." || alias === ".imageweave") return false;
  if (/[\u0000-\u001f\u007f]/.test(alias)) return false;
  return true;
}

/** 字节数人类可读格式。 */
export function formatExportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
