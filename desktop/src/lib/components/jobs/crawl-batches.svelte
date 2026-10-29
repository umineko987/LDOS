<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";

  import { resolve } from "$app/paths";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { crawlBatchesQuery, crawlKeys, type CrawlBatchSummary } from "#lib/api/queries/crawls.ts";
  import type { Job } from "#lib/api/queries/jobs.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { formatAgo, formatTimestamp } from "#lib/domain/elapsed.ts";
  import { useEvent } from "#lib/events/context.svelte.ts";
  import { isActiveJob, jobProgress } from "#lib/events/jobs.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { throttle } from "#lib/events/throttle.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import { statusLabel, statusTone, TONE_TEXT } from "./labels.ts";
  import StatusIcon from "./status-icon.svelte";

  // 采集批次历史。列表投影只有 id / 状态 / 时间（后端还没给计数），
  // 进行中的批次用实时任务表里的 crawl.batch 进度补上。
  let { now }: { now: number } = $props();

  const REFRESH_MS = 2_000;

  const api = useApi();
  const jobs = useJobs();
  const queryClient = useQueryClient();
  const batches = createQuery(() => crawlBatchesQuery(api));

  const live = $derived(
    new Map(
      jobs.items.filter((job) => job.kind === "crawl.batch" && job.ref.batch_id).map((job) => [job.ref.batch_id!, job] as const),
    ),
  );

  const refresh = throttle(() => void queryClient.invalidateQueries({ queryKey: crawlKeys.lists() }), REFRESH_MS);
  useEvent("job.updated", ({ job }) => {
    if (job.kind === "crawl.batch") refresh();
  });
  onDestroy(() => refresh.cancel());

  function counts(batch: CrawlBatchSummary, job: Job | undefined): string {
    if (job && isActiveJob(job) && job.total) return `${job.current ?? 0}/${job.total}`;
    if (batch.taskCount === null) return "";
    return m.jobs_crawl_counts({ succeeded: batch.succeeded ?? 0, total: batch.taskCount, failed: batch.failed ?? 0 });
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="crawl-batches">
  {#if batches.error}
    <p class="text-sm text-danger" role="alert">{m.jobs_load_failed({ reason: apiErrorMessage(batches.error) })}</p>
  {:else if batches.data && batches.data.length === 0}
    <p class="py-6 text-sm text-fg3">{m.jobs_crawls_empty()}</p>
  {:else if batches.data}
    <div
      class="grid grid-cols-[14px_minmax(0,1fr)_96px_minmax(0,200px)_96px] gap-x-3 border-b border-line pb-1.5 text-2xs text-fg3"
      aria-hidden="true"
    >
      <span></span>
      <span>{m.jobs_col_batch()}</span>
      <span>{m.jobs_col_status()}</span>
      <span>{m.jobs_col_progress()}</span>
      <span class="text-right">{m.jobs_col_created()}</span>
    </div>
    <ul class="flex min-h-0 flex-col overflow-y-auto">
      {#each batches.data as batch (batch.id)}
        {@const job = live.get(batch.id)}
        {@const progress = job && isActiveJob(job) ? jobProgress(job) : null}
        <li data-batch={batch.id} data-status={batch.status}>
          <a
            href={resolve("/jobs/crawls/[batchId]", { batchId: batch.id })}
            class="grid min-h-row grid-cols-[14px_minmax(0,1fr)_96px_minmax(0,200px)_96px] items-center gap-x-3 border-b border-line py-1.5 transition-colors duration-(--t-color) hover:bg-bg1"
          >
            <StatusIcon status={batch.status} />
            <span class="flex min-w-0 flex-col">
              <span class="truncate font-mono text-xs text-fg">{batch.id}</span>
              {#if job?.message}<span class="truncate text-2xs text-fg3">{job.message}</span>{/if}
            </span>
            <span class={cn("truncate text-xs", TONE_TEXT[statusTone(batch.status)])}>{statusLabel(batch.status)}</span>
            <span class="flex min-w-0 items-center gap-2 text-2xs text-fg2 tabular-nums">
              {#if progress !== null}<Progress value={progress * 100} max={100} class="w-16 flex-none" aria-label={batch.id} />{/if}
              <span class="truncate">{counts(batch, job)}</span>
            </span>
            <span class="text-right text-2xs text-fg3" title={formatTimestamp(batch.createdAt, i18n.current)}>
              {batch.createdAt === null ? "" : formatAgo(now - batch.createdAt, i18n.current, m.jobs_just_now())}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
