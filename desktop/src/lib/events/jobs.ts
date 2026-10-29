// 实时任务表：/jobs 快照打底，SSE `job.updated` 逐条合并。纯逻辑，响应式包装在 jobs.svelte.ts。

import { isTerminalStatus, type Job } from "#lib/api/queries/jobs.ts";

/** 和后端 JobRegistry 一致：活动任务常驻，终态任务只留最近这么多条。 */
export const MAX_FINISHED_JOBS = 200;

/** 一条任务从未结束变成结束（或第一次出现就已结束）。快照替换不产生转变。 */
export interface JobTransition {
  readonly job: Job;
  readonly previous: Job | undefined;
}

export function isActiveJob(job: Job): boolean {
  return !isTerminalStatus(job.status);
}

/** 活动任务在前（按开始时间新→旧），终态任务在后（按结束时间新→旧）。 */
export function compareJobs(a: Job, b: Job): number {
  const activeA = isActiveJob(a);
  const activeB = isActiveJob(b);
  if (activeA !== activeB) return activeA ? -1 : 1;
  const timeA = activeA ? a.started_at : (a.finished_at ?? a.updated_at);
  const timeB = activeB ? b.started_at : (b.finished_at ?? b.updated_at);
  return timeB - timeA || a.id.localeCompare(b.id);
}

export class JobTable {
  readonly #jobs = new Map<string, Job>();

  get size(): number {
    return this.#jobs.size;
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /** 快照是权威的：整表替换。 */
  replace(items: readonly Job[]): void {
    this.#jobs.clear();
    for (const job of items) this.#jobs.set(job.id, job);
    this.#prune();
  }

  /** 合并一条更新；比已有版本旧的更新被忽略。返回结束转变，没有则返回 null。 */
  apply(job: Job): JobTransition | null {
    const previous = this.#jobs.get(job.id);
    if (previous && job.updated_at < previous.updated_at) return null;
    this.#jobs.set(job.id, job);
    if (isTerminalStatus(job.status)) this.#prune();
    const finished = isTerminalStatus(job.status) && (!previous || !isTerminalStatus(previous.status));
    return finished ? { job, previous } : null;
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort(compareJobs);
  }

  #prune(): void {
    const finished = [...this.#jobs.values()].filter((job) => !isActiveJob(job)).sort(compareJobs);
    for (const job of finished.slice(MAX_FINISHED_JOBS)) this.#jobs.delete(job.id);
  }
}

const segment = (value: string) => encodeURIComponent(value);

const DATASET_STAGE: Readonly<Record<string, string>> = {
  "tagger.tag": "tag",
  "tagger.prepare": "tag",
  "captions.write": "review",
  "captions.undo": "review",
  "atlas.run": "atlas",
  "dataset.export": "export",
};

const REVIEW_STAGES: ReadonlySet<string> = new Set(["clean", "dedup"]);

/**
 * 活动抽屉和 toast 里「打开」的目标路径（不带 `#`）。没有合适页面时返回 null。
 * 按 kind 判断：captions.* 的 ref 里也有 batch_id，但那是 caption 批次，不是采集批次。
 */
export function jobLink(job: Job): string | null {
  const { ref } = job;
  const dataset = ref.dataset_id;
  if (job.kind === "crawl.batch") return ref.batch_id ? `/jobs/crawls/${segment(ref.batch_id)}` : "/jobs";
  if (job.kind === "dedup.review") {
    if (dataset && ref.stage && REVIEW_STAGES.has(ref.stage)) return `/datasets/${segment(dataset)}/${ref.stage}`;
    return null;
  }
  if (job.kind === "gallery.scan") return ref.source_id ? `/library/${segment(ref.source_id)}` : "/library";
  if (job.kind === "models.install") return "/settings/models";
  if (job.kind === "tagger.prepare" && !dataset) return "/settings/models";
  const stage = Object.hasOwn(DATASET_STAGE, job.kind) ? DATASET_STAGE[job.kind] : undefined;
  if (dataset && stage) return `/datasets/${segment(dataset)}/${stage}`;
  if (dataset) return `/datasets/${segment(dataset)}/collect`;
  return null;
}

/** 进度比例 0..1；不知道总量时返回 null（界面显示不定进度）。 */
export function jobProgress(job: Job): number | null {
  if (job.total === null || job.total === undefined || job.total <= 0) return null;
  return Math.min(1, Math.max(0, (job.current ?? 0) / job.total));
}

/** 已运行的秒数：活动任务到 `now`，终态任务到结束时间。 */
export function jobElapsed(job: Job, nowSeconds: number): number {
  const end = isActiveJob(job) ? nowSeconds : (job.finished_at ?? job.updated_at);
  return Math.max(0, end - job.started_at);
}
