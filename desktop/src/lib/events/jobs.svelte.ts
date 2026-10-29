// 外壳持有的实时任务表（响应式）。活动抽屉、侧栏角标、任务页都读它；
// 页面要看某个任务的进度，用 `useJobs().get(id)` 或筛 `items`，不要另起轮询。

import { createContext } from "svelte";

import type { Job } from "#lib/api/queries/jobs.ts";

import { isActiveJob, JobTable, type JobTransition } from "./jobs.ts";
import type { ConnectionState } from "./sse.ts";

export class LiveJobs {
  readonly #table = new JobTable();
  readonly #silenced = new Set<string>();

  /** 活动任务在前，终态任务按结束时间新→旧。 */
  items = $state.raw<readonly Job[]>([]);
  connection = $state<ConnectionState>("connecting");
  /** 已收到过第一份快照。 */
  loaded = $state(false);
  readonly active = $derived(this.items.filter(isActiveJob));

  get(id: string): Job | undefined {
    return this.items.find((job) => job.id === id);
  }

  replace(items: readonly Job[]): void {
    this.#table.replace(items);
    this.items = this.#table.list();
    this.loaded = true;
  }

  apply(job: Job): JobTransition | null {
    const transition = this.#table.apply(job);
    this.items = this.#table.list();
    return transition;
  }

  /** 页面自己会给反馈（例如带撤销的 toast）时调用：这个任务成功结束时不再弹通用提示。失败仍会提示。 */
  silence(jobId: string): void {
    this.#silenced.add(jobId);
  }

  isSilenced(jobId: string): boolean {
    return this.#silenced.has(jobId);
  }
}

export const [useJobs, setJobs] = createContext<LiveJobs>();
