<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { taskEventsQuery, taskLogsQuery } from "#lib/api/queries/tasks.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 单个下载任务的日志尾部 / 事件时间线。任务还没结束时定时重拉；
  // 日志贴底时新行到来自动滚到底，用户往上翻了就不打扰。
  let { taskId, active, class: className }: { taskId: string; active: boolean; class?: string } = $props();

  const LOG_POLL_MS = 2_000;
  const EVENT_POLL_MS = 3_000;

  type View = "logs" | "events";

  const api = useApi();
  let view = $state<View>("logs");

  const logs = createQuery(() => ({
    ...taskLogsQuery(api, taskId),
    enabled: view === "logs",
    refetchInterval: active ? LOG_POLL_MS : false,
  }));
  const events = createQuery(() => ({
    ...taskEventsQuery(api, taskId),
    enabled: view === "events",
    refetchInterval: active ? EVENT_POLL_MS : false,
  }));

  const clock = $derived(new Intl.DateTimeFormat(i18n.current, { timeStyle: "medium" }));
  const time = (ts: number | null) => (ts === null ? "" : clock.format(new Date(ts * 1000)));

  const STREAM_TEXT = { stdout: "text-fg", stderr: "text-fg2", backend: "text-fg3" } as const;

  let scroller = $state<HTMLDivElement | null>(null);
  let stick = true;

  function onscroll() {
    if (!scroller) return;
    stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  }

  $effect(() => {
    void logs.data;
    void events.data;
    void view;
    if (scroller && stick) scroller.scrollTop = scroller.scrollHeight;
  });

  const current = $derived(view === "logs" ? logs : events);
</script>

<div class={cn("flex min-h-0 flex-col", className)} data-testid="task-log" data-task={taskId}>
  <div class="flex items-center gap-2 pb-2">
    <Segmented
      label={m.crawl_task_view()}
      value={view}
      options={[
        { value: "logs", label: m.crawl_task_logs() },
        { value: "events", label: m.crawl_task_events() },
      ]}
      onchange={(next) => {
        view = next;
        stick = true;
      }}
    />
    <span class="ml-auto truncate font-mono text-2xs text-fg3" title={taskId}>{taskId}</span>
  </div>
  <div
    bind:this={scroller}
    {onscroll}
    class="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-bg1 px-3 py-2 font-mono text-2xs"
    data-testid="task-log-body"
  >
    {#if current.error}
      <p class="font-sans text-xs text-danger" role="alert">{m.jobs_load_failed({ reason: apiErrorMessage(current.error) })}</p>
    {:else if view === "logs"}
      {#if logs.data && logs.data.length === 0}
        <p class="font-sans text-xs text-fg3">{m.crawl_task_logs_empty()}</p>
      {:else if logs.data}
        {#each logs.data as line (line.id)}
          <div class="flex gap-2 whitespace-pre-wrap break-all" data-stream={line.stream}>
            <span class="flex-none text-fg3 tabular-nums select-none">{time(line.ts)}</span>
            <span class={STREAM_TEXT[line.stream]}>{line.line}</span>
          </div>
        {/each}
      {/if}
    {:else if events.data && events.data.length === 0}
      <p class="font-sans text-xs text-fg3">{m.crawl_task_events_empty()}</p>
    {:else if events.data}
      {#each events.data as event (event.id)}
        <div class="flex gap-2" data-event={event.type}>
          <span class="flex-none text-fg3 tabular-nums">{time(event.ts)}</span>
          <span class="text-fg2">{event.type}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>
