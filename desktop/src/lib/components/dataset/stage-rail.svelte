<script lang="ts">
  import { resolve } from "$app/paths";
  import NavDot from "#lib/components/shell/nav-dot.svelte";
  import type { RailStage, RailStatus } from "#lib/domain/funnel.ts";
  import type { Stage } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 阶段轨道：六段 采集 → 导出，每段显示这段的输出（= 下一段的输入）、去掉的张数和状态；
  // 地图是旁边的辅助入口。金色圆点在当前段之间平移（NavDot：只动 transform，180ms）。
  let { id, current, stages }: { id: string; current: Stage | null; stages: readonly RailStage[] } = $props();

  const LABELS: Record<Stage, () => string> = {
    collect: m.stage_collect,
    clean: m.stage_clean,
    dedup: m.stage_dedup,
    tag: m.stage_tag,
    review: m.stage_review,
    export: m.stage_export,
    atlas: m.stage_atlas,
  };

  const STATUS: Record<RailStatus, { mark: string; label: () => string; tone: string }> = {
    idle: { mark: "–", label: m.dataset_status_idle, tone: "text-fg3" },
    running: { mark: "●", label: m.dataset_status_running, tone: "text-fg" },
    done: { mark: "✓", label: m.dataset_status_done, tone: "text-ok" },
    stale: { mark: "◌", label: m.dataset_status_stale, tone: "text-warn" },
    failed: { mark: "✕", label: m.dataset_status_failed, tone: "text-danger" },
  };
</script>

<nav aria-label={m.nav_stages()} class="relative mt-3 flex items-stretch" data-testid="stage-rail">
  {#each stages as item, index (item.stage)}
    {@const status = STATUS[item.status]}
    <a
      href={resolve(`/datasets/[id]/${item.stage}`, { id })}
      data-active={current === item.stage || undefined}
      aria-current={current === item.stage ? "page" : undefined}
      data-stage={item.stage}
      data-status={item.status}
      class="group flex min-w-[108px] flex-col gap-0.5 border-b-2 border-transparent px-3 pt-1 pb-2.5 text-fg2 transition-colors duration-(--t-color) hover:text-fg data-active:text-fg"
    >
      <span class="flex h-5 items-center text-xs">
        {#if index > 0}<span aria-hidden="true" class="mr-1.5 text-fg3">→</span>{/if}
        {LABELS[item.stage]()}<span data-dot-anchor class="ml-[5px] inline-block h-[7px] w-0"></span>
      </span>
      <span class="flex items-baseline gap-1.5">
        <span data-count class="text-[15px] leading-5 font-medium text-fg tabular-nums">{item.output}</span>
        {#if item.removed > 0}
          <span data-removed class="text-2xs text-fg3 tabular-nums">−{item.removed}</span>
        {/if}
      </span>
      <span class={cn("flex items-center gap-1 text-2xs", status.tone)}>
        <span aria-hidden="true">{status.mark}</span>{status.label()}
      </span>
      <span aria-hidden="true" class="mt-1 block h-0.5 w-[72px] overflow-hidden rounded-full bg-line">
        <span
          class="block h-full w-full origin-left bg-line3 transition-transform duration-(--t-move) ease-ldos"
          style:transform="scaleX({item.ratio})"
        ></span>
      </span>
    </a>
  {/each}
  <a
    href={resolve("/datasets/[id]/atlas", { id })}
    data-active={current === "atlas" || undefined}
    aria-current={current === "atlas" ? "page" : undefined}
    data-stage="atlas"
    class="ml-auto flex h-9 items-center self-start px-3 pt-1 text-xs text-fg3 transition-colors duration-(--t-color) hover:text-fg data-active:text-fg"
  >
    {LABELS.atlas()}<span data-dot-anchor class="ml-[5px] inline-block h-[7px] w-0"></span>
  </a>
  <NavDot active={current} />
</nav>
