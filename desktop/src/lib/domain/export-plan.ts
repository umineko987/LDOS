// 导出页的表单与展示逻辑：默认值、校验、请求体、计划树、进度。纯函数，页面只管渲染。
//
// 文件夹名的规则和后端 gdl_backend/dataset_export.py 一致（kohya 是 `{repeats}_{触发词}`，
// flat 是数据集名），这里只用来在预览之前给一个即时提示；以计划预览里后端算出的名字为准。

import type { DatasetExport, ExportLayout, ExportOptions, ExportPlan, ExportRename, ExportRequest } from "#lib/api/queries/exports.ts";
import type { Job } from "#lib/api/queries/jobs.ts";

export const EXPORT_REPEATS_MIN = 1;
export const EXPORT_REPEATS_MAX = 10_000;
export const EXPORT_REPEATS_DEFAULT = 10;

export interface ExportForm {
  /** 导出到哪个目录（绝对路径）；数据集文件夹建在它下面。 */
  readonly target: string;
  readonly layout: ExportLayout;
  readonly repeats: number;
  readonly trigger: string;
  /** 自定义文件夹名；空 = 按规则生成。 */
  readonly folder: string;
  readonly rename: ExportRename;
  readonly captions: boolean;
  readonly pinTrigger: boolean;
  /** 逗号或换行分隔的标签。 */
  readonly blacklist: string;
  readonly underscores: boolean;
}

/**
 * 默认值：沿用上一次导出的选项（目录、布局、转换），触发词取数据集当前的。
 * 上一次的文件夹名是后端算出来的（kohya 带了 repeats 前缀），不能原样填回去，所以不沿用。
 */
export function exportFormDefaults(triggerWord: string, last?: ExportOptions | null): ExportForm {
  return {
    target: last?.target_path ?? "",
    layout: last?.layout ?? "kohya",
    repeats: last?.repeats ?? EXPORT_REPEATS_DEFAULT,
    trigger: triggerWord.trim() || (last?.trigger_word ?? ""),
    folder: "",
    rename: last?.rename ?? "none",
    captions: last?.include_captions ?? true,
    pinTrigger: last?.pin_trigger ?? true,
    blacklist: (last?.tag_blacklist ?? []).join(", "),
    underscores: last?.underscore_to_space ?? false,
  };
}

/** 逗号 / 换行分隔的标签列表：去空白、去空项、按小写去重，保留第一次出现的写法。 */
export function parseTagList(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(/[,\n\r]/)) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** POSIX `/…`、Windows `C:\…` / `C:/…`、UNC `\\server\…`。 */
export function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

export type ExportFormIssue = "target_required" | "target_not_absolute" | "trigger_required" | "repeats_invalid";

/** 提交前能在本地看出来的问题；没有问题返回 null。其余（目录不存在、重名）交给计划预览。 */
export function exportFormIssue(form: ExportForm): ExportFormIssue | null {
  const target = form.target.trim();
  if (!target) return "target_required";
  if (!isAbsolutePath(target)) return "target_not_absolute";
  if (form.layout === "kohya") {
    if (!Number.isInteger(form.repeats) || form.repeats < EXPORT_REPEATS_MIN || form.repeats > EXPORT_REPEATS_MAX) return "repeats_invalid";
    if (!form.trigger.trim() && !form.folder.trim()) return "trigger_required";
  }
  return null;
}

export function exportRequest(form: ExportForm): Omit<ExportRequest, "dry_run"> {
  const folder = form.folder.trim();
  return {
    target_path: form.target.trim(),
    layout: form.layout,
    // flat 不用 repeats，但后端照样校验范围：发一个合法值。
    repeats: form.layout === "kohya" ? form.repeats : EXPORT_REPEATS_DEFAULT,
    trigger_word: form.trigger.trim(),
    folder_name: folder || null,
    rename: form.rename,
    include_captions: form.captions,
    pin_trigger: form.pinTrigger,
    tag_blacklist: parseTagList(form.blacklist),
    underscore_to_space: form.underscores,
  };
}

const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, n) => [`com${n + 1}`, `lpt${n + 1}`]).flat()]);

function stripDotsAndSpaces(text: string): string {
  return text.replace(/^[ .]+|[ .]+$/g, "");
}

/** 和后端 safe_folder_name 一致：去掉非法字符、首尾空白与点，避开 Windows 保留名。 */
export function safeFolderName(name: string): string {
  let cleaned = stripDotsAndSpaces(name.replace(FORBIDDEN_NAME_CHARS, "_").split(/\s+/).filter(Boolean).join(" "));
  cleaned = stripDotsAndSpaces(cleaned.slice(0, 120));
  if (!cleaned) return "dataset";
  if (WINDOWS_RESERVED.has(cleaned.split(".", 1)[0]!.toLowerCase())) cleaned += "_";
  return cleaned;
}

/** 预览之前的文件夹名提示；kohya 缺触发词时返回 null。 */
export function folderHint(form: ExportForm, datasetName: string): string | null {
  const folder = form.folder.trim();
  if (form.layout === "kohya") {
    const name = folder || (form.trigger.trim() ? safeFolderName(form.trigger.trim()) : "");
    return name ? `${form.repeats}_${name}` : null;
  }
  return folder || safeFolderName(datasetName);
}

export type PlanRow =
  | { readonly kind: "folder"; readonly key: string; readonly path: string }
  | { readonly kind: "image"; readonly key: string; readonly path: string; readonly source: string; readonly size: number; readonly renamed: boolean }
  | { readonly kind: "caption"; readonly key: string; readonly path: string; readonly preview: string };

/** 计划树：输出文件夹一行，每张图一行，有标注时紧跟一行 .txt。后端最多给 100 项，`more` 是没列出的张数。 */
export function planRows(plan: ExportPlan): { rows: PlanRow[]; more: number } {
  const rows: PlanRow[] = [{ kind: "folder", key: "folder", path: `${plan.folder_name}/` }];
  for (const item of plan.items) {
    rows.push({
      kind: "image",
      key: `image:${item.asset_id}`,
      path: item.output_relative_path,
      source: item.name,
      size: item.size_bytes,
      renamed: item.output_relative_path !== item.name,
    });
    if (item.caption_output_relative_path) {
      rows.push({ kind: "caption", key: `caption:${item.asset_id}`, path: item.caption_output_relative_path, preview: item.caption_preview });
    }
  }
  return { rows, more: Math.max(0, plan.image_count - plan.items.length) };
}

/** 第一条非空的标注样例，展示标注转换的效果。 */
export function captionSample(plan: ExportPlan): string | null {
  return plan.items.find((item) => item.caption_output_relative_path && item.caption_preview)?.caption_preview ?? null;
}

export interface ExportProgress {
  readonly done: number;
  readonly total: number;
  /** 0..1；总数未知时 null。 */
  readonly fraction: number | null;
}

/** 进度：活动任务优先看实时任务表（SSE 逐文件更新），否则看导出记录里落盘的计数。 */
export function exportProgress(record: DatasetExport, job?: Job | null): ExportProgress {
  const live = job && typeof job.total === "number" && job.total > 0;
  const done = live ? (job.current ?? 0) : record.staged_items;
  const total = live ? job.total! : record.total_items;
  if (record.status === "succeeded") return { done: total, total, fraction: 1 };
  return { done, total, fraction: total > 0 ? Math.min(1, Math.max(0, done / total)) : null };
}
