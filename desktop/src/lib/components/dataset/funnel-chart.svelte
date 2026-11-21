<script lang="ts">
  import type { OutputBar } from "#lib/domain/funnel.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 首页卡片上的迷你漏斗：五根竖条，高度是这一段输出占成员总数的比例。
  // 只用 transform: scaleY 画高度；需重跑的段用提示色。
  let { bars, height = 34 }: { bars: readonly OutputBar[]; height?: number } = $props();

  const LABELS = {
    collect: m.stage_collect,
    clean: m.stage_clean,
    dedup: m.stage_dedup,
    tag: m.stage_tag,
    export: m.stage_export,
  } as const;

  const summary = $derived(bars.map((bar) => `${LABELS[bar.stage]()} ${bar.output}`).join("，"));
</script>

<div class="flex items-end gap-1" style:height="{height}px" role="img" aria-label={summary} data-testid="funnel-chart">
  {#each bars as bar (bar.stage)}
    <span class="relative block h-full w-2.5 overflow-hidden rounded-[2px] bg-bg2" title="{LABELS[bar.stage]()} {bar.output}">
      <span
        class="absolute inset-0 block origin-bottom transition-transform duration-(--t-move) ease-ldos {bar.stale
          ? 'bg-warn/60'
          : bar.stage === 'export'
            ? 'bg-fg2'
            : 'bg-line3'}"
        style:transform="scaleY({bar.ratio})"
        data-stage={bar.stage}
        data-output={bar.output}
      ></span>
    </span>
  {/each}
</div>
