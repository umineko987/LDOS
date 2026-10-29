<script lang="ts">
  import StatusDot from "#lib/components/status-dot.svelte";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { progressRatio, statusTone, type ModelItem } from "#lib/domain/models.ts";
  import { cn } from "#lib/utils.ts";

  import { STATUS_LABELS } from "./labels.ts";

  // 一个模型的状态：安装中显示进度条（总量未知时只显示文字），其余是状态点 + 文字。
  let { item, class: className }: { item: ModelItem; class?: string } = $props();

  const ratio = $derived(item.status === "installing" ? progressRatio(item.progress) : null);
</script>

<div class={cn("flex min-w-0 flex-col gap-1", className)} data-model-status={item.status}>
  <div class="flex items-center gap-2">
    <StatusDot status={statusTone(item.status)} />
    <span class="truncate text-xs text-fg2">{STATUS_LABELS[item.status]()}</span>
    {#if ratio !== null}<span class="text-2xs text-fg3 tabular-nums">{Math.round(ratio * 100)}%</span>{/if}
  </div>
  {#if ratio !== null}
    <Progress value={ratio * 100} max={100} aria-label={STATUS_LABELS.installing()} class="w-full max-w-[140px]" />
  {/if}
  {#if item.message && (item.status === "installing" || item.status === "failed")}
    <span class="truncate text-2xs text-fg3" title={item.message}>{item.message}</span>
  {/if}
</div>
