// 任务、采集批次和下载任务共用的状态 / 类型文案。后端的状态值多于 JobStatus（批次有 planning、
// completed_with_errors，地址有 planned，去重审核有 waiting_for_crawl、applying），不认识的值原样显示。

import { m } from "#lib/paraglide/messages.js";

/** active 用转圈图标；其余是静态的颜色。都不用金色。 */
export type Tone = "active" | "ok" | "warn" | "danger" | "muted";

const STATUS: Readonly<Record<string, () => string>> = {
  analyzing: m.jobs_status_analyzing,
  applied: m.jobs_status_applied,
  apply_failed: m.jobs_status_apply_failed,
  applying: m.jobs_status_applying,
  auto_applying: m.jobs_status_applying,
  cancelled: m.jobs_status_cancelled,
  cancelling: m.jobs_status_cancelling,
  completed_with_errors: m.jobs_status_completed_with_errors,
  failed: m.jobs_status_failed,
  pending: m.jobs_status_pending,
  planned: m.jobs_status_planned,
  planning: m.jobs_status_planning,
  queued: m.jobs_status_queued,
  ready: m.jobs_status_ready,
  running: m.jobs_status_running,
  starting: m.jobs_status_starting,
  succeeded: m.jobs_status_succeeded,
  waiting_for_crawl: m.jobs_status_waiting_for_crawl,
};

const TONES: Readonly<Record<string, Tone>> = {
  analyzing: "active",
  applied: "ok",
  apply_failed: "danger",
  applying: "active",
  auto_applying: "active",
  cancelled: "muted",
  cancelling: "warn",
  completed_with_errors: "warn",
  failed: "danger",
  pending: "muted",
  planned: "muted",
  planning: "active",
  queued: "muted",
  ready: "ok",
  running: "active",
  starting: "active",
  succeeded: "ok",
  waiting_for_crawl: "muted",
};

const KINDS: Readonly<Record<string, () => string>> = {
  "atlas.run": m.jobs_kind_atlas_run,
  "captions.undo": m.jobs_kind_captions_undo,
  "captions.write": m.jobs_kind_captions_write,
  "crawl.batch": m.jobs_kind_crawl_batch,
  "dataset.export": m.jobs_kind_dataset_export,
  "dedup.review": m.jobs_kind_dedup_review,
  "gallery.export": m.jobs_kind_gallery_export,
  "gallery.scan": m.jobs_kind_gallery_scan,
  "models.install": m.jobs_kind_models_install,
  "tagger.prepare": m.jobs_kind_tagger_prepare,
  "tagger.tag": m.jobs_kind_tagger_tag,
};

export function statusLabel(status: string): string {
  return Object.hasOwn(STATUS, status) ? STATUS[status]!() : status;
}

export function statusTone(status: string): Tone {
  return Object.hasOwn(TONES, status) ? TONES[status]! : "muted";
}

export function kindLabel(kind: string): string {
  return Object.hasOwn(KINDS, kind) ? KINDS[kind]!() : kind;
}

export const TONE_TEXT: Readonly<Record<Tone, string>> = {
  active: "text-fg2",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-fg3",
};
