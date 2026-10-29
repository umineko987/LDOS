// 来源扫描的实时状态：任务 `scan:{source_id}` 来自 SSE 的 job.updated（外壳的 LiveJobs 表）。
// 点「扫描」到任务出现之间有一小段空档，用本地的 started 集合补上。

import { useQueryClient } from "@tanstack/svelte-query";
import { SvelteSet } from "svelte/reactivity";

import { invalidateLibrary } from "#lib/api/queries/library.ts";
import type { Job } from "#lib/api/queries/jobs.ts";
import { scanJobId } from "#lib/domain/library.ts";
import { useEvent } from "#lib/events/context.svelte.ts";
import { isActiveJob } from "#lib/events/jobs.ts";
import { useJobs } from "#lib/events/jobs.svelte.ts";

export interface ScanTracker {
  /** 这个来源有扫描在跑（任务未结束，或刚点了扫描、任务还没推过来）。 */
  running(sourceId: string): boolean;
  /** 进行中的扫描任务（有的话），进度在 `current` / `total` / `message`。 */
  job(sourceId: string): Job | undefined;
  /** 点了扫描、接口已接受：任务推过来之前也显示为扫描中。 */
  started(sourceId: string): void;
}

/** 扫描任务结束时让图库查询全部失效（来源计数、目录内容都可能变了）。 */
export function useScans(): ScanTracker {
  const client = useQueryClient();
  const jobs = useJobs();
  const pending = new SvelteSet<string>();

  useEvent("job.updated", ({ job }) => {
    if (!job.id.startsWith("scan:")) return;
    // 任务推过来以后以它的状态为准。
    pending.delete(job.id.slice("scan:".length));
    if (!isActiveJob(job)) void invalidateLibrary(client);
  });

  return {
    running(sourceId) {
      const job = jobs.get(scanJobId(sourceId));
      return pending.has(sourceId) || (job !== undefined && isActiveJob(job));
    },
    // 结束的任务还留在表里一阵；再次扫描时不能拿它的进度。
    job(sourceId) {
      const job = jobs.get(scanJobId(sourceId));
      return job && isActiveJob(job) ? job : undefined;
    },
    started(sourceId) {
      pending.add(sourceId);
    },
  };
}
