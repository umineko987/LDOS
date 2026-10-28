/** 打标应用的领域类型与后端返回消毒。 */

export type TaggerPhase = "idle" | "preparing" | "tagging" | "failed";
export type TaggerStage = "hashing" | "inferring" | "selecting" | "";

const PHASE_SET = new Set<TaggerPhase>(["idle", "preparing", "tagging", "failed"]);
const STAGE_SET = new Set<TaggerStage>(["hashing", "inferring", "selecting", ""]);

export interface TaggerCatalogEntry {
  readonly key: string;
  readonly repo: string;
  readonly revision: string;
  readonly adapter: string;
  readonly gated: boolean;
  readonly license: string;
  readonly defaultThresholds: Readonly<Record<string, number>>;
  readonly installed: boolean;
}

export interface TaggerDownloadEntry {
  readonly file: string;
  readonly done: number;
  readonly total: number;
}

export interface TaggerModelResult {
  readonly inferred: number;
  readonly cacheHits: number;
}

export interface TaggerRunSummary {
  readonly total: number;
  readonly perModel: Readonly<Record<string, TaggerModelResult>>;
  readonly decodeErrors: readonly string[];
  readonly captionsWritten: number;
  readonly captionsSkipped: number;
}

export interface TaggerStatus {
  readonly phase: TaggerPhase;
  readonly stage: TaggerStage;
  readonly done: number;
  readonly total: number;
  readonly message: string;
  readonly download: Readonly<Record<string, TaggerDownloadEntry>>;
  readonly lastResult: TaggerRunSummary | null;
  readonly enabled: boolean;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(code);
  }
  return value as Record<string, unknown>;
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function countOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function sanitizeThresholds(value: unknown): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  const record = requireRecord(value, "invalid_tagger_thresholds");
  for (const [category, threshold] of Object.entries(record)) {
    if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
      result[category] = threshold;
    }
  }
  return result;
}

export function sanitizeCatalog(value: unknown): readonly TaggerCatalogEntry[] {
  if (!Array.isArray(value)) throw new TypeError("invalid_tagger_catalog");
  return value.map((entry) => {
    const record = requireRecord(entry, "invalid_tagger_catalog_entry");
    const key = stringOr(record.key);
    const repo = stringOr(record.repo);
    if (!key || !repo) throw new TypeError("invalid_tagger_catalog_entry");
    return {
      key,
      repo,
      revision: stringOr(record.revision),
      adapter: stringOr(record.adapter),
      gated: record.gated === true,
      license: stringOr(record.license),
      defaultThresholds: sanitizeThresholds(record.default_thresholds ?? {}),
      installed: record.installed === true,
    };
  });
}

function sanitizeDownload(value: unknown): Readonly<Record<string, TaggerDownloadEntry>> {
  const result: Record<string, TaggerDownloadEntry> = {};
  if (value === undefined || value === null) return result;
  const record = requireRecord(value, "invalid_tagger_download");
  for (const [model, entry] of Object.entries(record)) {
    const item = requireRecord(entry, "invalid_tagger_download_entry");
    result[model] = {
      file: stringOr(item.file),
      done: countOr(item.done),
      total: countOr(item.total),
    };
  }
  return result;
}

function sanitizeRunSummary(value: unknown): TaggerRunSummary | null {
  if (typeof value !== "object" || value === null || !("total" in value)) return null;
  const record = requireRecord(value, "invalid_tagger_summary");
  const perModel: Record<string, TaggerModelResult> = {};
  const rawPerModel = requireRecord(record.per_model ?? {}, "invalid_tagger_summary_models");
  for (const [model, entry] of Object.entries(rawPerModel)) {
    const item = requireRecord(entry, "invalid_tagger_summary_model");
    perModel[model] = { inferred: countOr(item.inferred), cacheHits: countOr(item.cache_hits) };
  }
  const decodeErrors = Array.isArray(record.decode_errors)
    ? record.decode_errors.filter((item): item is string => typeof item === "string")
    : [];
  return {
    total: countOr(record.total),
    perModel,
    decodeErrors,
    captionsWritten: countOr(record.captions_written),
    captionsSkipped: countOr(record.captions_skipped),
  };
}

export function sanitizeStatus(value: unknown): TaggerStatus {
  const record = requireRecord(value, "invalid_tagger_status");
  const rawPhase = stringOr(record.phase, "failed");
  const rawStage = stringOr(record.stage, "");
  const phase: TaggerPhase = PHASE_SET.has(rawPhase as TaggerPhase) ? (rawPhase as TaggerPhase) : "failed";
  const stage: TaggerStage = STAGE_SET.has(rawStage as TaggerStage) ? (rawStage as TaggerStage) : "";
  return {
    phase,
    stage,
    done: countOr(record.done),
    total: countOr(record.total),
    message: stringOr(record.message),
    download: sanitizeDownload(record.download),
    lastResult: sanitizeRunSummary(record.last_result),
    enabled: record.enabled !== false,
  };
}

export const TAGGER_CATEGORIES = ["general", "character", "copyright", "quality", "meta", "rating", "style"] as const;
export type TaggerCategory = (typeof TAGGER_CATEGORIES)[number];

export const TAGGER_THRESHOLD_LABELS: Record<TaggerCategory, string> = {
  general: "一般标签阈值",
  character: "角色阈值",
  copyright: "版权 / 作品阈值",
  quality: "质量标签阈值",
  meta: "元信息阈值",
  rating: "内容分级阈值",
  style: "风格阈值",
};
/** 阈值输入：空串 = 不覆盖（用模型默认）。 */
export function normalizeThreshold(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 0.99) throw new TypeError("invalid_tagger_threshold");
  return parsed;
}

/** 文本格式化（供进度条与下载展示复用）。 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
