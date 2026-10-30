<script lang="ts">
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import type { Snippet } from "svelte";

  import { cn } from "#lib/utils.ts";

  // 缩略图格子的默认内容：铺满的图、四角徽标、可选的印章（例如“已排除”）。
  // 外框、选中底色和焦点环由 VirtualGrid 画，这里只管格子里面。
  let {
    src,
    alt,
    dimmed = false,
    stamp,
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
    class: className,
  }: {
    /** 缩略图地址；null 时显示占位图标。 */
    src: string | null;
    alt: string;
    /** 变暗（被排除、被去重淘汰）。 */
    dimmed?: boolean;
    /** 居中的状态印章文字。 */
    stamp?: string;
    topLeft?: Snippet;
    topRight?: Snippet;
    bottomLeft?: Snippet;
    bottomRight?: Snippet;
    class?: string;
  } = $props();

  let failed = $state(false);
  $effect(() => {
    void src;
    failed = false;
  });
</script>

<div class={cn("relative size-full", className)}>
  {#if src && !failed}
    <img
      crossorigin="anonymous"
      {src}
      {alt}
      loading="lazy"
      decoding="async"
      draggable="false"
      class="size-full object-cover transition-opacity duration-(--t-color) {dimmed ? 'opacity-30' : ''}"
      onerror={() => (failed = true)}
    />
  {:else}
    <div class="flex size-full items-center justify-center text-fg3" role="img" aria-label={alt}>
      <ImageOffIcon class="size-5" />
    </div>
  {/if}
  {#if stamp}
    <span
      class="absolute top-1/2 left-1/2 -translate-1/2 rounded-sm border border-danger/60 bg-bg0/80 px-1.5 py-px text-2xs font-medium tracking-wider text-danger"
      data-stamp
    >
      {stamp}
    </span>
  {/if}
  {#if topLeft}<div class="absolute top-1 left-1 flex gap-1">{@render topLeft()}</div>{/if}
  {#if topRight}<div class="absolute top-1 right-1 flex gap-1">{@render topRight()}</div>{/if}
  {#if bottomLeft}<div class="absolute bottom-1 left-1 flex gap-1">{@render bottomLeft()}</div>{/if}
  {#if bottomRight}<div class="absolute right-1 bottom-1 flex gap-1">{@render bottomRight()}</div>{/if}
</div>
