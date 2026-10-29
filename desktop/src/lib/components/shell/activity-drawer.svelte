<script lang="ts">
  import { resolve } from "$app/paths";
  import type { ComponentStatus } from "#lib/api/queries/system.ts";
  import JobRow from "#lib/components/jobs/job-row.svelte";
  import { useNow } from "#lib/components/jobs/now.svelte.ts";
  import StatusDot from "#lib/components/status-dot.svelte";
  import * as Sheet from "#lib/components/ui/sheet/index.ts";
  import { isActiveJob } from "#lib/events/jobs.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import type { ConnectionState } from "#lib/events/sse.ts";
  import { m } from "#lib/paraglide/messages.js";

  // Ctrl+J：活动抽屉。实时任务表来自外壳（快照 + SSE 的 job.updated），这里只负责显示。
  let { open = $bindable(false) }: { open?: boolean } = $props();

  const RECENT_LIMIT = 30;

  const jobs = useJobs();
  const now = useNow(() => open);
  const recent = $derived(jobs.items.filter((job) => !isActiveJob(job)).slice(0, RECENT_LIMIT));

  const CONNECTION: Record<ConnectionState, { status: ComponentStatus; label: () => string }> = {
    connecting: { status: "disabled", label: m.activity_connection_connecting },
    open: { status: "ok", label: m.activity_connection_open },
    retrying: { status: "warning", label: m.activity_connection_retrying },
    closed: { status: "disabled", label: m.activity_connection_closed },
  };
  const connection = $derived(CONNECTION[jobs.connection]);

  const close = () => (open = false);
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" data-testid="activity-drawer">
    <Sheet.Header class="flex-row items-center gap-3 border-b border-line py-3.5 pr-12 pl-[18px]">
      <Sheet.Title>{m.shell_activity()}</Sheet.Title>
      <span class="ml-auto flex items-center gap-1.5 text-2xs text-fg3" data-testid="activity-connection" data-state={jobs.connection}>
        <StatusDot status={connection.status} />
        {connection.label()}
      </span>
    </Sheet.Header>

    {#if jobs.items.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
        <p class="text-sm text-fg2">{m.activity_empty()}</p>
        <p class="text-xs text-fg3">{m.activity_hint()}</p>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[18px] py-3">
        {#if jobs.active.length}
          <section aria-labelledby="activity-running" data-testid="activity-running">
            <h3 id="activity-running" class="pb-1 text-2xs tracking-[0.04em] text-fg3">
              {m.activity_running({ count: jobs.active.length })}
            </h3>
            <ul class="flex flex-col border-t border-line">
              {#each jobs.active as job (job.id)}
                <JobRow {job} now={now.seconds} onnavigate={close} />
              {/each}
            </ul>
          </section>
        {:else}
          <p class="text-xs text-fg3">{m.activity_empty()}</p>
        {/if}
        {#if recent.length}
          <section aria-labelledby="activity-recent" data-testid="activity-recent">
            <h3 id="activity-recent" class="pb-1 text-2xs tracking-[0.04em] text-fg3">{m.activity_recent()}</h3>
            <ul class="flex flex-col border-t border-line">
              {#each recent as job (job.id)}
                <JobRow {job} now={now.seconds} onnavigate={close} />
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}

    <Sheet.Footer class="border-t border-line px-[18px] py-2.5">
      <a
        href={resolve("/jobs")}
        class="self-start rounded-sm text-xs text-fg2 transition-colors duration-(--t-color) hover:text-fg"
        onclick={close}
        data-testid="activity-history">{m.activity_history()}</a
      >
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
