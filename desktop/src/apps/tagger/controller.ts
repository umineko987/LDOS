/** 打标面板的纯状态逻辑（组件负责 Svelte 状态与轮询生命周期）。 */

import type { TaggerStatus, TaggerRunSummary } from "./model";

const STAGE_ORDER = { hashing: 0, inferring: 1, selecting: 2 } as const;
const STAGE_WEIGHT = 0.95 / 3;

export function stageProgress(status: TaggerStatus | null): number {
  if (!status || !status.total) return 0;
  const base = status.phase === "tagging" ? 0.05 : 0;
  const stageIndex = status.stage in STAGE_ORDER
    ? STAGE_ORDER[status.stage as keyof typeof STAGE_ORDER]
    : 0;
  return Math.min(1, base + stageIndex * STAGE_WEIGHT + (status.done / status.total) * STAGE_WEIGHT);
}

export function downloadProgress(status: TaggerStatus | null): { model: string; file: string; done: number; total: number } | null {
  const entries = Object.entries(status?.download ?? {});
  if (!entries.length) return null;
  const [model, entry] = entries[0];
  return { model, file: entry.file, done: entry.done, total: entry.total };
}

export function lastSummary(status: TaggerStatus | null): TaggerRunSummary | null {
  return status?.lastResult ?? null;
}

export function isRunning(status: TaggerStatus | null): boolean {
  return status?.phase === "preparing" || status?.phase === "tagging";
}

/** 勾选模型（保持顺序：首位即主模型）。 */
export function toggleModel(selected: readonly string[], key: string): readonly string[] {
  return selected.includes(key)
    ? selected.filter((item) => item !== key)
    : [...selected, key];
}

/** 开始打标前的本地校验，返回错误文案（空串 = 通过）。 */
export function validateStart(selected: readonly string[], inputs: string): string {
  if (!inputs.split(/\r?\n/u).some((line) => line.trim())) {
    return "请先填写要打标的图片目录或文件路径。";
  }
  if (!selected.length) return "请至少勾选一个模型。";
  return "";
}
