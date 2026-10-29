<script lang="ts">
  import type { Job } from "#lib/api/queries/jobs.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { formatAgo, formatElapsed, formatTimestamp } from "#lib/domain/elapsed.ts";
  import { isActiveJob, jobElapsed, jobLink, jobProgress } from "#lib/events/jobs.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import { kindLabel, statusLabel, statusTone, TONE_TEXT } from "./labels.ts";
  import StatusIcon from "./status-icon.svelte";

  // 一行任务：状态、标题、运行时长（终态显示多久前结束）、进度、消息和「打开」。
  // 活动抽屉和任务页共用；`onnavigate` 让抽屉在跳转时自己关掉。
  let { job, now, onnavigate, class: className }: { job: Job; now: number; onnavigate?: () => void; class?: string } = $props();

  const active = $derived(isActiveJob(job));
  const link = $derived(jobLink(job));
  const progress = $derived(jobProgress(job));
  const elapsed = $derived(formatElapsed(jobElapsed(job, now)));
  const ended = $derived(job.finished_at ?? job.updated_at);
  const time = $derived(active ? elapsed : formatAgo(now - ended, i18n.current, m.jobs_just_now()));
  const timeTitle = $derived(active ? formatTimestamp(job.started_at, i18n.current) : `${formatTimestamp(ended, i18n.current)} · ${m.jobs_duration({ time: elapsed })}`);
</script>

<li class={cn("flex flex-col gap-1 border-b border-line py-2.5", className)} data-job={job.id} data-kind={job.kind} data-status={job.status}>
  <div class="flex min-w-0 items-center gap-2">
    <StatusIcon status={job.status} />
    <span class="min-w-0 flex-1 truncate text-sm text-fg" title={job.title}>{job.title}</span>
    <span class="flex-none text-2xs text-fg3 tabular-nums" title={timeTitle} data-testid="job-time">{time}</span>
    {#if link}
      <a
        href={`#${link}`}
        class="flex-none rounded-sm text-xs text-fg2 transition-colors duration-(--t-color) hover:text-fg"
        onclick={() => onnavigate?.()}
        data-testid="job-open">{m.activity_open()}</a
      >
    {/if}
  </div>
  <div class="flex min-w-0 items-center gap-1.5 pl-[22px] text-2xs text-fg3">
    <span class="truncate">{kindLabel(job.kind)}</span>
    <span aria-hidden="true">·</span>
    <span class={cn("flex-none", TONE_TEXT[statusTone(job.status)])} data-testid="job-status">{statusLabel(job.status)}</span>
    {#if job.total !== null && job.total !== undefined && job.total > 0}
      <span class="ml-auto flex-none tabular-nums" data-testid="job-count">{job.current ?? 0}/{job.total}</span>
    {/if}
  </div>
  {#if active && progress !== null}
    <Progress value={progress * 100} max={100} class="ml-[22px] w-auto" aria-label={job.title} />
  {/if}
  {#if job.message}
    <p class={cn("line-clamp-2 pl-[22px] text-xs break-words", job.status === "failed" ? "text-danger" : "text-fg2")} data-testid="job-message">
      {job.message}
    </p>
  {/if}
</li>
