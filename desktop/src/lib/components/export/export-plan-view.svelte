<script lang="ts">
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import ImageIcon from "@lucide/svelte/icons/image";

  import type { ExportPlan } from "#lib/api/queries/exports.ts";
  import { captionSample, planRows } from "#lib/domain/export-plan.ts";
  import { formatBytes } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 计划预览（dry_run 的结果）：统计、输出位置、不能开始的原因、标注样例、文件树（后端最多列 100 张）。
  let { plan, stale }: { plan: ExportPlan; stale: boolean } = $props();

  const tree = $derived(planRows(plan));
  const sample = $derived(captionSample(plan));
  const size = (bytes: number) => formatBytes(bytes, i18n.current) ?? "";
  const BLOCKERS: Record<string, (args: { count: number }) => string> = {
    source_offline: m.export_blocker_source_offline,
    caption_unreadable: m.export_blocker_caption_unreadable,
  };
</script>

<section class="flex min-h-0 flex-col gap-3" data-testid="export-plan" data-stale={stale || undefined}>
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-sm font-medium">{m.export_plan_title()}</h2>
    <span class="text-xs text-fg2 tabular-nums" data-testid="export-plan-stats">
      {m.export_plan_stats({ images: plan.image_count, captions: plan.caption_count, size: size(plan.total_bytes) })}
    </span>
  </div>
  <p class="truncate font-mono text-2xs text-fg2" title={plan.output_path} data-testid="export-plan-output">{plan.output_path}</p>

  {#if stale}<p class="text-xs text-warn" role="status">{m.export_plan_stale()}</p>{/if}
  {#if plan.target_exists}
    <p class="text-xs text-danger" role="alert" data-testid="export-plan-exists">{m.export_plan_target_exists({ name: plan.folder_name })}</p>
  {/if}
  {#each plan.blockers as blocker (blocker.code)}
    <p class="text-xs text-danger" role="alert" data-testid="export-plan-blocker">
      {(BLOCKERS[blocker.code] ?? m.export_blocker_other)({ count: blocker.count })}
    </p>
  {/each}
  {#if plan.image_count === 0}<p class="text-xs text-warn" role="status">{m.export_plan_empty()}</p>{/if}
  {#if plan.collision_count}<p class="text-xs text-fg2">{m.export_plan_collisions({ count: plan.collision_count })}</p>{/if}

  {#if sample}
    <div class="flex flex-col gap-1">
      <span class="text-2xs text-fg3">{m.export_plan_caption_sample()}</span>
      <p class="rounded-md border border-line bg-bg1 px-3 py-2 font-mono text-2xs leading-4 break-words text-fg2" data-testid="export-plan-caption">{sample}</p>
    </div>
  {/if}

  <ol class="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-bg1 py-1.5 font-mono text-2xs" aria-label={m.export_plan_tree()} data-testid="export-plan-tree">
    {#each tree.rows as row (row.key)}
      <li class="flex h-6 items-center gap-2 px-3 {row.kind === 'folder' ? 'text-fg' : 'pl-7 text-fg2'}">
        {#if row.kind === "folder"}
          <FolderIcon class="size-3.5 flex-none text-fg3" /><span class="truncate">{row.path}</span>
        {:else if row.kind === "image"}
          <ImageIcon class="size-3.5 flex-none text-fg3" />
          <span class="truncate" title={row.renamed ? `${row.source} → ${row.path}` : row.path}>{row.path}</span>
          {#if row.renamed}<span class="truncate text-fg3">← {row.source}</span>{/if}
          <span class="ml-auto flex-none text-fg3 tabular-nums">{size(row.size)}</span>
        {:else}
          <FileTextIcon class="size-3.5 flex-none text-fg3" /><span class="truncate">{row.path}</span>
        {/if}
      </li>
    {/each}
    {#if tree.more}<li class="px-3 pt-1 pl-7 text-fg3">{m.export_plan_more({ count: tree.more })}</li>{/if}
  </ol>
</section>
