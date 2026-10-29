// 模型表的纯逻辑：安装集合、许可、进度合并、展示用的换算。界面和 ModelGate 共用。

import type { components } from "#lib/api/schema.d.ts";
import type { ComponentStatus } from "#lib/api/queries/system.ts";
import type { Job } from "#lib/events/bus.ts";

export type ModelItem = components["schemas"]["ModelItem"];
export type ModelStatus = ModelItem["status"];
export type ModelUse = ModelItem["used_by"][number];

const TERMINAL_JOB: ReadonlySet<Job["status"]> = new Set(["succeeded", "failed", "cancelled"]);

/** 可以点「安装」的状态。安装中、已安装、功能未启用的都不行。 */
export function canInstall(item: ModelItem): boolean {
  return item.status === "missing" || item.status === "failed" || item.status === "needs_license";
}

export function byKey(items: readonly ModelItem[]): Map<string, ModelItem> {
  return new Map(items.map((item) => [item.key, item]));
}

/** 还没装好的 key（未登记的 key 也算缺，按原样返回，交给后端报错）。 */
export function missingKeys(items: readonly ModelItem[], keys: readonly string[]): string[] {
  const index = byKey(items);
  return [...new Set(keys)].filter((key) => index.get(key)?.status !== "installed");
}

/** 这次安装实际会动到的 key：请求的 key 加上同包一起装的（SSCD 与 DINOv2），保持顺序、去重。 */
export function installSet(items: readonly ModelItem[], keys: readonly string[]): string[] {
  const index = byKey(items);
  const result = new Set<string>();
  for (const key of keys) {
    result.add(key);
    for (const other of index.get(key)?.installs_with ?? []) result.add(other);
  }
  return [...result];
}

/** 安装这些 key 前需要用户同意自定义许可的条目（gated 且尚未安装）。 */
export function licenseItems(items: readonly ModelItem[], keys: readonly string[]): ModelItem[] {
  const index = byKey(items);
  return [...new Set(keys)]
    .map((key) => index.get(key))
    .filter((item): item is ModelItem => item !== undefined && item.gated && item.status !== "installed");
}

export function isTerminalJob(job: Pick<Job, "status">): boolean {
  return TERMINAL_JOB.has(job.status);
}

export interface JobMerge {
  readonly items: ModelItem[];
  /** 有条目对应这个 job。 */
  readonly matched: boolean;
  /** job 已结束：调用方应重拉 /models 拿到最终状态。 */
  readonly finished: boolean;
}

/** 把一条 job.updated 合进模型表：安装中的条目跟着 job 更新进度。 */
export function mergeJob(items: readonly ModelItem[], job: Job): JobMerge {
  let matched = false;
  const next = items.map((item) => {
    if (item.job_id !== job.id) return item;
    matched = true;
    if (isTerminalJob(job)) return item;
    const total = job.total ?? item.progress?.total ?? 0;
    const current = job.current ?? item.progress?.current ?? 0;
    return { ...item, status: "installing" as const, message: job.message || item.message, progress: { current, total } };
  });
  return { items: matched ? next : [...items], matched, finished: matched && isTerminalJob(job) };
}

/** 0..1；总量未知时返回 null（显示不定进度）。 */
export function progressRatio(progress: ModelItem["progress"]): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.current / progress.total));
}

export function anyInstalling(items: readonly ModelItem[]): boolean {
  return items.some((item) => item.status === "installing");
}

export function statusTone(status: ModelStatus): ComponentStatus {
  switch (status) {
    case "installed":
      return "ok";
    case "failed":
      return "error";
    case "installing":
    case "needs_license":
      return "warning";
    default:
      return "disabled";
  }
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1024 进制，保留到一位小数；null 返回 null（打标模型没有登记大小）。 */
export function formatBytes(bytes: number | null, locale: string): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}
