<script lang="ts">
  import XIcon from "@lucide/svelte/icons/x";

  import { resolve } from "$app/paths";
  import type { DatasetCrawl, DatasetRoot } from "#lib/api/queries/datasets.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 采集段顶部的来源条：每个根目录一枚药丸（来源徽标 · 名称 · 张数 · 移除），
  // 后面是还没挂上的在线采集批次（点进任务页看进度）。
  let {
    roots,
    crawls,
    onremove,
  }: {
    roots: readonly DatasetRoot[];
    crawls: readonly DatasetCrawl[];
    onremove: (root: DatasetRoot) => void;
  } = $props();

  const ORIGINS = {
    import: m.collect_origin_import,
    library: m.collect_origin_library,
    crawl: m.collect_origin_crawl,
  } as const;

  const pending = $derived(crawls.filter((crawl) => crawl.state !== "attached"));
</script>

<ul class="flex flex-wrap items-center gap-1.5" aria-label={m.collect_roots()} data-testid="collect-roots">
  {#each roots as root (root.root_id)}
    <li
      class={cn(
        "flex h-7 items-center gap-1.5 rounded-full border border-line2 bg-bg1 pr-1 pl-2.5 text-xs",
        !root.available && "border-dashed text-fg3",
      )}
      data-root={root.root_id}
      data-origin={root.origin}
      title={root.relative_path ? `${root.source_display_name} / ${root.relative_path}` : root.source_display_name}
    >
      <span class="rounded-sm bg-bg3 px-1 text-2xs text-fg2" data-testid="root-origin">{ORIGINS[root.origin]()}</span>
      <span class="max-w-[220px] truncate text-fg">{root.name || root.source_display_name}</span>
      <span class="text-2xs text-fg3 tabular-nums">{root.recursive_asset_count}</span>
      {#if !root.available}<span class="text-2xs text-warn">{m.collect_root_unavailable()}</span>{/if}
      <button
        type="button"
        class="flex size-5 items-center justify-center rounded-full text-fg3 transition-colors hover:bg-bg3 hover:text-fg"
        aria-label={m.collect_root_remove({ name: root.name || root.source_display_name })}
        onclick={() => onremove(root)}
      >
        <XIcon class="size-3" />
      </button>
    </li>
  {/each}
  {#each pending as crawl (crawl.batch_id)}
    <li>
      <a
        href={resolve("/jobs/crawls/[batchId]", { batchId: crawl.batch_id })}
        class={cn(
          "flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line2 px-2.5 text-xs text-fg2 transition-colors hover:text-fg",
          crawl.state === "failed" && "text-danger",
        )}
        data-crawl={crawl.batch_id}
        data-state={crawl.state}
      >
        <span class="rounded-sm bg-bg3 px-1 text-2xs">{ORIGINS.crawl()}</span>
        {crawl.state === "failed"
          ? m.collect_crawl_failed({ code: crawl.error_code || crawl.batch_status || "" })
          : m.collect_crawl_pending({ status: crawl.batch_status ?? "" })}
      </a>
    </li>
  {/each}
</ul>
