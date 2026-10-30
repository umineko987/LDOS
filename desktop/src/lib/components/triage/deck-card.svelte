<script lang="ts">
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import type { Snippet } from "svelte";

  import type { TriageGroupStatus } from "#lib/keys/triage.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 分诊卡组里的一张：上面是图，左上角是数字键和“保留 / 将移除”，下面是说明。
  // 要移除的图变暗；焦点那张画金色焦点环。点一下切换保留（和按数字键一样）。
  let {
    index,
    src,
    alt,
    kept,
    status,
    focused,
    suggested = false,
    failed = false,
    fit = "cover",
    width,
    height,
    transform,
    zoomable = false,
    onclick,
    chips,
    meta,
  }: {
    index: number;
    src: string | null;
    alt: string;
    kept: boolean;
    /** 这一组的定夺状态：已定夺且没改过时显示“已保留 / 已移除”。 */
    status: TriageGroupStatus;
    focused: boolean;
    suggested?: boolean;
    /** 上次定夺时这张没能移动。 */
    failed?: boolean;
    fit?: "cover" | "contain";
    /** 图片区域的像素尺寸；不给时按 3:4 撑满列宽。 */
    width?: number;
    height?: number;
    /** 同步缩放的 CSS transform。 */
    transform?: string;
    /** 图片区域接收同步缩放（标上 data-zoom-tile，卡组按它算锚点）。 */
    zoomable?: boolean;
    onclick: () => void;
    chips?: Snippet;
    meta?: Snippet;
  } = $props();

  const verdict = $derived(
    status === "decided" ? (kept ? m.triage_chip_kept() : m.triage_chip_removed()) : kept ? m.triage_chip_keep() : m.triage_chip_drop(),
  );
</script>

<button
  type="button"
  class={cn(
    "flex min-w-0 flex-col overflow-hidden rounded-lg border bg-bg1 text-left transition-colors duration-(--t-color)",
    focused ? "border-line3 outline-[1.5px] outline-offset-2 outline-gold outline-solid" : "border-line hover:border-line2",
  )}
  style:width={width ? `${width}px` : undefined}
  aria-pressed={kept}
  aria-label={`${index + 1}. ${alt} · ${verdict}`}
  data-testid="deck-card"
  data-index={index}
  data-kept={kept || undefined}
  data-focused={focused || undefined}
  {onclick}
>
  <div
    class={cn("relative overflow-hidden bg-bg2", !width && "aspect-[3/4]")}
    style:height={height ? `${height}px` : undefined}
    data-zoom-tile={zoomable || undefined}
  >
    {#if src}
      <img
        crossorigin="anonymous"
        {src}
        {alt}
        draggable="false"
        loading="lazy"
        class={cn(
          "absolute inset-0 size-full transition-opacity duration-(--t-color) select-none",
          fit === "cover" ? "object-cover" : "object-contain",
          !kept && "opacity-30",
        )}
        style:transform
      />
    {:else}
      <ImageOffIcon class="absolute top-1/2 left-1/2 size-6 -translate-1/2 text-fg3" />
    {/if}
    <div class="absolute top-2 left-2 flex items-center gap-1.5">
      {#if index < 9}
        <kbd class="rounded-[4px] border border-line2 bg-bg0/85 px-1.5 font-mono text-2xs text-fg2">{index + 1}</kbd>
      {/if}
      <span
        class={cn("rounded-[4px] bg-bg0/85 px-1.5 text-2xs", kept ? "text-fg" : "text-danger")}
        data-testid="deck-card-verdict"
      >
        {verdict}
      </span>
      {#if suggested}
        <span class="rounded-[4px] bg-bg0/85 px-1.5 text-2xs text-fg2">{m.triage_chip_suggested()}</span>
      {/if}
      {#if failed}
        <span class="rounded-[4px] bg-bg0/85 px-1.5 text-2xs text-warn">{m.triage_chip_failed()}</span>
      {/if}
    </div>
  </div>
  <div class="flex min-w-0 flex-col gap-1 px-3 py-2 text-xs">
    {#if chips}<div class="flex flex-wrap gap-1">{@render chips()}</div>{/if}
    {@render meta?.()}
    <span class="truncate font-mono text-2xs text-fg3" title={alt}>{alt}</span>
  </div>
</button>
