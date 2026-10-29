<script lang="ts">
  import { createQuery, keepPreviousData } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { isTerminalTaskStatus } from "#lib/api/queries/crawls.ts";
  import { tasksQuery, type TaskFilter } from "#lib/api/queries/tasks.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { formatAgo, formatTimestamp } from "#lib/domain/elapsed.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import { statusLabel, statusTone, TONE_TEXT } from "./labels.ts";
  import { stepSelection } from "./selection.ts";
  import StatusIcon from "./status-icon.svelte";
  import TaskLog from "./task-log.svelte";

  // 下载任务（gallery-dl 子进程）列表 + 选中任务的日志。有未结束的任务时定时重拉列表。
  let { now }: { now: number } = $props();

  const POLL_MS = 3_000;

  const api = useApi();
  let filter = $state<TaskFilter>("all");
  let selected = $state<string | null>(null);

  const tasks = createQuery(() => ({
    ...tasksQuery(api, filter),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.some((task) => !isTerminalTaskStatus(task.status)) ? POLL_MS : false),
  }));

  const items = $derived(tasks.data ?? []);
  const selectedTask = $derived(items.find((task) => task.id === selected) ?? null);

  function step(delta: 1 | -1) {
    selected = stepSelection(
      items.map((task) => task.id),
      selected,
      delta,
    );
    if (selected) document.querySelector(`[data-task-row="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  useBindings("page", () => [
    { id: "jobs.task.next", keys: ["j", "arrowdown"], label: m.jobs_key_next, group: m.nav_jobs, run: () => step(1) },
    { id: "jobs.task.previous", keys: ["k", "arrowup"], label: m.jobs_key_previous, group: m.nav_jobs, run: () => step(-1) },
  ]);
  useEscape("selection", () => {
    if (selected === null) return false;
    selected = null;
    return true;
  });

  const FILTERS: readonly { value: TaskFilter; label: string }[] = [
    { value: "all", label: m.jobs_filter_all() },
    { value: "running", label: m.jobs_filter_running() },
    { value: "failed", label: m.jobs_filter_failed() },
  ];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="download-tasks">
  <Segmented label={m.jobs_filter()} value={filter} options={FILTERS} onchange={(next) => (filter = next)} class="self-start" />

  <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,42%)] gap-5">
    <div class="flex min-h-0 flex-col">
      {#if tasks.error}
        <p class="text-sm text-danger" role="alert">{m.jobs_load_failed({ reason: apiErrorMessage(tasks.error) })}</p>
      {:else if tasks.data && items.length === 0}
        <p class="py-6 text-sm text-fg3">{m.jobs_tasks_empty()}</p>
      {:else if tasks.data}
        <ul class="flex min-h-0 flex-col overflow-y-auto border-t border-line">
          {#each items as task (task.id)}
            <li>
              <button
                type="button"
                aria-pressed={selected === task.id}
                data-task-row={task.id}
                data-status={task.status}
                class="grid min-h-row w-full grid-cols-[14px_72px_minmax(0,1fr)_56px_72px] items-center gap-x-3 border-b border-line px-1 py-1.5 text-left transition-colors duration-(--t-color) hover:bg-bg1 aria-pressed:bg-bg2"
                onclick={() => (selected = task.id)}
              >
                <StatusIcon status={task.status} />
                <span class="truncate text-xs text-fg2">{task.site}</span>
                <span class="flex min-w-0 flex-col">
                  <span class="truncate text-xs text-fg" title={task.target}>{task.target || task.id}</span>
                  {#if task.status === "failed" && (task.errorClass || task.lastError)}
                    <span class="truncate text-2xs text-danger" title={task.lastError}>{task.errorClass || task.lastError}</span>
                  {:else}
                    <span class={cn("text-2xs", TONE_TEXT[statusTone(task.status)])}>{statusLabel(task.status)}</span>
                  {/if}
                </span>
                <span class="text-right text-2xs text-fg3 tabular-nums">{m.jobs_attempts({ count: task.attempts, max: task.maxAttempts })}</span>
                <span class="text-right text-2xs text-fg3" title={formatTimestamp(task.createdAt, i18n.current)}>
                  {task.createdAt === null ? "" : formatAgo(now - task.createdAt, i18n.current, m.jobs_just_now())}
                </span>
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
</div>
