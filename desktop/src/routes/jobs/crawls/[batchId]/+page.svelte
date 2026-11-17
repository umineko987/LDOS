<script lang="ts">
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import { createQuery, keepPreviousData, useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import { toast } from "svelte-sonner";

  import { page } from "$app/state";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    CRAWL_TASK_PAGE,
    crawlBatchQuery,
    crawlKeys,
    crawlTasksQuery,
    isTerminalBatchStatus,
    isTerminalTaskStatus,
    runCrawlOperation,
    validBatchId,
    type CrawlOperation,
  } from "#lib/api/queries/crawls.ts";
  import { statusLabel, statusTone, TONE_TEXT } from "#lib/components/jobs/labels.ts";
  import { stepSelection } from "#lib/components/jobs/selection.ts";
  import StatusIcon from "#lib/components/jobs/status-icon.svelte";
  import TaskLog from "#lib/components/jobs/task-log.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { formatTimestamp } from "#lib/domain/elapsed.ts";
  import { useEvent } from "#lib/events/context.svelte.ts";
  import { isActiveJob, jobProgress } from "#lib/events/jobs.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { throttle } from "#lib/events/throttle.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 采集批次详情：摘要、来源 / 地址、去重审核、分页的任务列表和选中任务的日志。
  // 事件触发限频刷新；查询同时定时核对，直到批次和任务行都读到最终状态。
  const REFRESH_MS = 1_500;

  const api = useApi();
  const jobs = useJobs();
  const queryClient = useQueryClient();

  const batchId = $derived(page.params.batchId ?? "");
  const valid = $derived(validBatchId(batchId) !== null);
  const job = $derived(jobs.get(`crawl:${batchId}`));

  let offset = $state(0);
  let selected = $state<string | null>(null);
  let pending = $state<CrawlOperation | null>(null);

  // 在批次之间跳转时页面组件会复用：换批次就回到第一页、清掉选中。
  $effect.pre(() => {
    void batchId;
    offset = 0;
    selected = null;
  });

  const batch = createQuery(() => ({
    ...crawlBatchQuery(api, batchId),
    enabled: valid,
  }));
  const tasks = createQuery(() => ({
    ...crawlTasksQuery(api, batchId, offset, batch.data?.status),
    enabled: valid,
    placeholderData: keepPreviousData,
  }));

  const refresh = throttle(() => {
    void queryClient.invalidateQueries({ queryKey: crawlKeys.detail(batchId) });
    void queryClient.invalidateQueries({ queryKey: crawlKeys.tasks(batchId) });
  }, REFRESH_MS);
  useEvent("job.updated", ({ job: updated }) => {
    if (updated.id === `crawl:${batchId}`) refresh();
  });
  onDestroy(() => refresh.cancel());

  const summary = $derived(batch.data);
  const status = $derived(summary?.status ?? job?.status ?? "");
  const terminal = $derived(summary ? isTerminalBatchStatus(summary.status) : false);
  const progress = $derived.by(() => {
    if (summary && summary.taskCount > 0) return (summary.succeeded + summary.failed + summary.cancelled) / summary.taskCount;
    return job && isActiveJob(job) && !terminal ? jobProgress(job) : null;
  });
  const can = $derived({
    cancel: !pending && !!summary && !terminal && !summary.cancelRequested && summary.status !== "cancelling",
    retry: !pending && !!summary?.resumable && terminal,
    rerun: !pending && !!summary && terminal,
  });

  const taskItems = $derived(tasks.data?.items ?? []);
  const selectedTask = $derived(taskItems.find((task) => task.id === selected) ?? null);

  const DONE: Record<CrawlOperation, () => string> = {
    cancel: m.crawl_done_cancel,
    retry: m.crawl_done_retry,
    rerun: m.crawl_done_rerun,
  };

  async function operate(operation: CrawlOperation) {
    pending = operation;
    try {
      await runCrawlOperation(api, batchId, operation);
      toast.success(DONE[operation]());
    } catch (error) {
      toast.error(m.crawl_action_failed({ reason: apiErrorMessage(error) }));
    } finally {
      pending = null;
      void queryClient.invalidateQueries({ queryKey: crawlKeys.detail(batchId) });
      void queryClient.invalidateQueries({ queryKey: crawlKeys.tasks(batchId) });
      void queryClient.invalidateQueries({ queryKey: crawlKeys.lists() });
    }
  }

  function step(delta: 1 | -1) {
    selected = stepSelection(
      taskItems.map((task) => task.id),
      selected,
      delta,
    );
    if (selected) document.querySelector(`[data-task-row="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function turn(delta: 1 | -1) {
    offset = Math.max(0, offset + delta * CRAWL_TASK_PAGE);
    selected = null;
  }

  useBindings("page", () => [
    { id: "crawl.task.next", keys: ["j", "arrowdown"], label: m.jobs_key_next, group: m.nav_jobs, run: () => step(1) },
    { id: "crawl.task.previous", keys: ["k", "arrowup"], label: m.jobs_key_previous, group: m.nav_jobs, run: () => step(-1) },
  ]);
  useEscape("selection", () => {
    if (selected === null) return false;
    selected = null;
    return true;
  });

  const subtitle = $derived.by(() => {
    if (!summary) return undefined;
    const created = formatTimestamp(summary.createdAt, i18n.current);
    return created ? m.crawl_created({ time: created }) : undefined;
  });
</script>

<PageHeader title={m.page_crawl_batch({ batch: batchId })} {subtitle}>
  {#snippet actions()}
    {#if summary}
      <Button variant="destructive" size="sm" disabled={!can.cancel} onclick={() => operate("cancel")} data-testid="crawl-cancel">
        {m.crawl_action_cancel()}
      </Button>
      <Button variant="outline" size="sm" disabled={!can.retry} onclick={() => operate("retry")} data-testid="crawl-retry">
        {m.crawl_action_retry()}
      </Button>
      <Button variant="outline" size="sm" disabled={!can.rerun} onclick={() => operate("rerun")} data-testid="crawl-rerun">
        {m.crawl_action_rerun()}
      </Button>
    {/if}
  {/snippet}
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-4" data-testid="crawl-batch" data-status={status}>
  {#if !valid}
    <p class="text-sm text-danger" role="alert">{m.crawl_invalid_id()}</p>
  {:else if batch.error}
    <p class="text-sm text-danger" role="alert" data-testid="crawl-error">{m.crawl_load_failed({ reason: apiErrorMessage(batch.error) })}</p>
  {:else if summary}
    <section class="flex max-w-[980px] flex-col gap-2.5" aria-label={m.crawl_summary()} data-testid="crawl-summary">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
        <span class="flex items-center gap-2">
          <StatusIcon status={summary.status} />
          <span class={TONE_TEXT[statusTone(summary.status)]} data-testid="crawl-status">{statusLabel(summary.status)}</span>
          {#if summary.cancelRequested && summary.status !== "cancelled"}<span class="text-xs text-warn">{m.crawl_cancel_requested()}</span>{/if}
        </span>
        <span class="text-fg2">{m.crawl_stat_tasks()} <b class="font-medium text-fg tabular-nums">{summary.taskCount}</b></span>
        <span class="text-fg2">{m.crawl_stat_succeeded()} <b class="font-medium text-ok tabular-nums">{summary.succeeded}</b></span>
        <span class="text-fg2">{m.crawl_stat_failed()} <b class={cn("font-medium tabular-nums", summary.failed ? "text-danger" : "text-fg")}>{summary.failed}</b></span>
        {#if summary.cancelled}<span class="text-fg2">{m.crawl_stat_cancelled()} <b class="font-medium text-fg tabular-nums">{summary.cancelled}</b></span>{/if}
        <span class="text-fg2">{m.crawl_stat_skipped()} <b class="font-medium text-fg tabular-nums">{summary.preDedupSkipped}</b></span>
      </div>
      {#if progress !== null && !terminal}
        <Progress value={progress * 100} max={100} class="max-w-[480px]" aria-label={m.crawl_summary()} />
      {/if}
      {#if job?.message && isActiveJob(job)}<p class="text-xs text-fg2" data-testid="crawl-message">{job.message}</p>{/if}
      {#if summary.current && !terminal}
        <p class="text-xs text-fg3" data-testid="crawl-current">
          {m.crawl_current({ site: summary.current.site, order: summary.current.addressOrder + 1 })}
        </p>
      {/if}
    </section>

    {#if summary.sources.length}
      <section aria-labelledby="crawl-sources" class="flex max-w-[980px] flex-col gap-1.5">
        <h2 id="crawl-sources" class="text-sm font-semibold">{m.crawl_sources()}</h2>
        {#each summary.sources as source (source.order)}
          <div class="flex flex-col" data-source={source.order}>
            <div class="flex items-center gap-2 pb-1 text-xs">
              <span class="font-medium text-fg">{source.site}</span>
              <span class={TONE_TEXT[statusTone(source.status)]}>{statusLabel(source.status)}</span>
            </div>
            <ul class="flex flex-col border-t border-line">
              {#each source.addresses as address (address.id)}
                <li
                  class="grid min-h-row grid-cols-[14px_minmax(0,1fr)_88px_120px] items-center gap-x-3 border-b border-line py-1.5"
                  data-address={address.id}
                  data-status={address.status}
                >
                  <StatusIcon status={address.status} />
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate text-xs text-fg" title={address.label}>{address.label || address.id}</span>
                    {#if address.planningError}
                      <span class="truncate text-2xs text-danger" title={address.planningError}>{m.crawl_planning_error({ reason: address.planningError })}</span>
                    {/if}
                  </span>
                  <span class={cn("truncate text-2xs", TONE_TEXT[statusTone(address.status)])}>{statusLabel(address.status)}</span>
                  <span class="text-right text-2xs text-fg2 tabular-nums">
                    {m.crawl_address_counts({ succeeded: address.succeeded, planned: address.planned, failed: address.failed })}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
        {#if summary.addressesTruncated}<p class="text-2xs text-fg3">{m.crawl_addresses_truncated()}</p>{/if}
      </section>
    {/if}

    {#if summary.review}
      <section aria-labelledby="crawl-review" class="flex max-w-[980px] flex-col gap-1" data-testid="crawl-review">
        <h2 id="crawl-review" class="text-sm font-semibold">{m.crawl_review()}</h2>
        <p class="text-xs text-fg2">
          <span class={TONE_TEXT[statusTone(summary.review.status)]}>{statusLabel(summary.review.status)}</span>
          · {m.crawl_review_counts({
            decided: summary.review.decidedGroups,
            total: summary.review.totalGroups,
            images: summary.review.totalImages,
          })}
        </p>
      </section>
    {/if}

    <section aria-labelledby="crawl-tasks" class="flex flex-col gap-2" data-testid="crawl-tasks">
      <div class="flex items-center gap-3">
        <h2 id="crawl-tasks" class="text-sm font-semibold">{m.crawl_tasks()}</h2>
        {#if taskItems.length}
          <span class="text-2xs text-fg3 tabular-nums">{m.crawl_tasks_range({ from: offset + 1, to: offset + taskItems.length })}</span>
        {/if}
        <span class="text-2xs text-fg3">{m.crawl_tasks_keys()}</span>
        <div class="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={offset === 0} onclick={() => turn(-1)} aria-label={m.crawl_tasks_previous()}>
            <ChevronLeftIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={!tasks.data?.hasMore} onclick={() => turn(1)} aria-label={m.crawl_tasks_next()}>
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <div class="grid h-[min(560px,70vh)] grid-cols-[minmax(0,1fr)_minmax(300px,45%)] gap-5">
        <div class="flex min-h-0 flex-col">
          {#if tasks.error}
            <p class="text-sm text-danger" role="alert">{m.jobs_load_failed({ reason: apiErrorMessage(tasks.error) })}</p>
          {:else if tasks.data && taskItems.length === 0}
            <p class="py-4 text-sm text-fg3">{m.crawl_tasks_empty()}</p>
          {:else}
            <ul class="flex min-h-0 flex-col overflow-y-auto border-t border-line">
              {#each taskItems as task (task.id)}
                <li>
                  <button
                    type="button"
                    aria-pressed={selected === task.id}
                    data-task-row={task.id}
                    data-status={task.status}
                    class="grid min-h-row w-full grid-cols-[14px_48px_72px_minmax(0,1fr)_56px] items-center gap-x-3 border-b border-line px-1 py-1.5 text-left transition-colors duration-(--t-color) hover:bg-bg1 aria-pressed:bg-bg2"
                    onclick={() => (selected = task.id)}
                  >
                    <StatusIcon status={task.status} />
                    <span class="text-2xs text-fg3 tabular-nums">#{task.sequence}</span>
                    <span class="truncate text-xs text-fg2">{task.site}</span>
                    <span class="flex min-w-0 items-center gap-2">
                      <span class={cn("flex-none text-xs", TONE_TEXT[statusTone(task.status)])}>{statusLabel(task.status)}</span>
                      {#if task.errorClass}<span class="truncate font-mono text-2xs text-danger">{task.errorClass}</span>{/if}
                    </span>
                    <span class="text-right text-2xs text-fg3 tabular-nums">{m.jobs_attempts({ count: task.attempts, max: task.maxAttempts })}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        {#if selectedTask}
          {#key selectedTask.id}
            <TaskLog taskId={selectedTask.id} active={!isTerminalTaskStatus(selectedTask.status)} class="h-full" />
          {/key}
        {:else}
          <p class="pt-1 text-xs text-fg3">{m.crawl_task_none()}</p>
        {/if}
      </div>
    </section>
  {/if}
</div>
