<script lang="ts">
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";

  import type { Job } from "#lib/api/queries/jobs.ts";
  import { isActiveExport, type DatasetExport, type ExportStatus } from "#lib/api/queries/exports.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { formatTimestamp } from "#lib/domain/elapsed.ts";
  import { exportProgress } from "#lib/domain/export-plan.ts";
  import { formatBytes } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 一次导出：状态、位置、进度（进行中）、失败原因，以及取消 / 续传 / 在文件管理器中打开。
  let {
    record,
    job,
    prominent = false,
    canReveal,
    busy,
    oncancel,
    onresume,
    onreveal,
  }: {
    record: DatasetExport;
    job?: Job | null;
    /** 页面上方“当前导出”的大卡片；历史列表里是紧凑的一行。 */
    prominent?: boolean;
    canReveal: boolean;
    busy: boolean;
    oncancel: (record: DatasetExport) => void;
    onresume: (record: DatasetExport) => void;
    onreveal: (record: DatasetExport) => void;
  } = $props();

  const STATUS: Record<ExportStatus, () => string> = {
    queued: m.export_status_queued,
    running: m.export_status_running,
    succeeded: m.export_status_succeeded,
    failed: m.export_status_failed,
    cancelled: m.export_status_cancelled,
    interrupted: m.export_status_interrupted,
  };
  const ERRORS: Readonly<Record<string, () => string>> = {
    copy_io_error: m.export_error_copy_io,
    export_interrupted: m.export_error_interrupted,
    export_target_exists: m.export_error_target_exists,
    internal_error: m.export_error_internal,
    target_not_writable: m.export_error_not_writable,
  };

  const active = $derived(isActiveExport(record.status));
  const progress = $derived(exportProgress(record, job));
  const reason = $derived(
    record.error_code ? (Object.hasOwn(ERRORS, record.error_code) ? ERRORS[record.error_code]!() : record.error_code) : "",
  );
  const tone = $derived(
    record.status === "failed" ? "text-danger" : record.status === "interrupted" ? "text-warn" : record.status === "succeeded" ? "text-fg" : "text-fg2",
  );
</script>

<article
  class={cn("flex flex-col gap-2", prominent ? "rounded-lg border border-line bg-bg1 px-4 py-3" : "border-b border-line py-2.5 last:border-b-0")}
  data-testid={prominent ? "export-current" : "export-record"}
  data-status={record.status}
  data-export={record.export_id}
>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span class={cn("text-xs", tone)} data-testid="export-status">{STATUS[record.status]()}</span>
    <span class="min-w-0 truncate font-mono text-xs text-fg" title={record.output_path}>{record.folder_name}</span>
    <span class="text-2xs text-fg3 tabular-nums">{formatTimestamp(record.created_at, i18n.current)}</span>
    <span class="grow"></span>
    {#if active}
      <Button variant="ghost" size="xs" disabled={busy} onclick={() => oncancel(record)} data-testid="export-cancel">{m.export_cancel()}</Button>
    {:else if record.resumable}
      <Button variant={prominent ? "primary" : "outline"} size="xs" disabled={busy} onclick={() => onresume(record)} data-testid="export-resume">
        {m.export_resume()}
      </Button>
      <Button variant="ghost" size="xs" disabled={busy} onclick={() => oncancel(record)}>{m.export_discard()}</Button>
    {/if}
    {#if record.status === "succeeded" && canReveal}
      <Button variant={prominent ? "outline" : "ghost"} size="xs" onclick={() => onreveal(record)} data-testid="export-reveal">
        <FolderOpenIcon />{m.export_reveal()}
      </Button>
    {/if}
  </div>
  <p class="truncate font-mono text-2xs text-fg3" title={record.output_path}>{record.output_path}</p>
  {#if active || (prominent && record.status !== "succeeded")}
    <div class="flex items-center gap-3">
      {#if progress.fraction !== null}
        <Progress class="w-56" value={Math.round(progress.fraction * 100)} max={100} data-testid="export-progress" />
      {/if}
      <span class="text-2xs text-fg2 tabular-nums" data-testid="export-progress-count">
        {m.export_progress({ done: progress.done, total: progress.total })}
      </span>
    </div>
  {:else if record.status === "succeeded"}
    <p class="text-2xs text-fg2 tabular-nums">
      {m.export_done_stats({ count: record.total_items, size: formatBytes(record.total_bytes, i18n.current) ?? "" })}
    </p>
  {/if}
  {#if reason}<p class={cn("text-2xs", tone)} data-testid="export-error">{reason}</p>{/if}
  {#if record.status === "interrupted" || (record.resumable && record.status === "failed")}
    <p class="text-2xs text-fg2">{m.export_resume_hint()}</p>
  {/if}
</article>
