<script lang="ts">
  import CrawlBatches from "#lib/components/jobs/crawl-batches.svelte";
  import DownloadTasks from "#lib/components/jobs/download-tasks.svelte";
  import JobRow from "#lib/components/jobs/job-row.svelte";
  import { useNow } from "#lib/components/jobs/now.svelte.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 任务页：实时任务（外壳的任务表）、采集批次历史、下载任务历史。
  type Tab = "live" | "crawls" | "tasks";

  const jobs = useJobs();
  const now = useNow();
  let tab = $state<Tab>("live");

  const TABS: readonly { value: Tab; label: string }[] = [
    { value: "live", label: m.jobs_tab_live() },
    { value: "crawls", label: m.jobs_tab_crawls() },
    { value: "tasks", label: m.jobs_tab_tasks() },
  ];
</script>

<PageHeader title={m.nav_jobs()} subtitle={jobs.active.length ? m.activity_running({ count: jobs.active.length }) : undefined}>
  <Segmented label={m.jobs_tabs()} value={tab} options={TABS} onchange={(next) => (tab = next)} size="sm" class="mt-3 self-start" data-testid="jobs-tabs" />
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col px-7 py-4" data-testid="jobs-page" data-tab={tab}>
  {#if tab === "live"}
    {#if jobs.items.length === 0}
      <div class="flex flex-col gap-1.5 py-6">
        <p class="text-sm text-fg2">{m.activity_empty()}</p>
        <p class="text-xs text-fg3">{m.jobs_live_hint()}</p>
      </div>
    {:else}
      <ul class="flex min-h-0 max-w-[880px] flex-col overflow-y-auto" data-testid="jobs-live">
        {#each jobs.items as job (job.id)}
          <JobRow {job} now={now.seconds} class="px-1" />
        {/each}
      </ul>
    {/if}
  {:else if tab === "crawls"}
    <CrawlBatches now={now.seconds} />
  {:else}
    <DownloadTasks now={now.seconds} />
  {/if}
</div>
