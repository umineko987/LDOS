<!--
  全屏图片查看器（从旧版图库查看器移植手感：滚轮以指针为中心缩放、拖动平移、双击复位、F 隐藏工具栏）。

    <Viewer items={viewerItems} bind:index bind:open origin={(item) => thumbnailOf(item.id)}>
      {#snippet actions(item)}<Button size="sm">排除</Button>{/snippet}
      {#snippet aside(item)}…右侧面板…{/snippet}
    </Viewer>

  - `items`：ViewerItem 列表（id、name、src 原图、thumb 缩略图、可选宽高和一行 meta）。
  - `index`（可绑定）：当前项；`open`（可绑定）：是否打开。关闭时调 `onclose(index)`，页面可以把网格焦点移到这里。
  - `origin(item, index)`：返回网格里对应的缩略图元素，打开时从它的位置飞入（只动 transform；减少动效时不做）。
  - `actions` / `aside`：工具栏右侧的额外按钮、右侧面板，参数是当前项和下标。
  - `hasMore` / `onendreached`：翻到最后几张时请求下一页。

  按键（overlay 层）：←/→ 或 H/L 翻页，Space 关闭，F 隐藏/显示工具栏，0 复位缩放，Esc 关闭（bits-ui 处理）。
-->
<script lang="ts">
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import Maximize2Icon from "@lucide/svelte/icons/maximize-2";
  import XIcon from "@lucide/svelte/icons/x";
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { tick, untrack, type Snippet } from "svelte";

  import { Button } from "#lib/components/ui/button/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import {
    clampPan,
    containedRect,
    dragPan,
    flightTransform,
    RESET,
    stepIndex,
    stripWindow,
    wheelZoom,
    type PanState,
    type Size,
    type ViewerItem,
  } from "./viewer-model.ts";

  let {
    items,
    index = $bindable(0),
    open = $bindable(false),
    origin,
    actions,
    aside,
    hasMore = false,
    onendreached,
    onclose,
  }: {
    items: readonly ViewerItem[];
    index?: number;
    open?: boolean;
    origin?: (item: ViewerItem, index: number) => HTMLElement | null;
    actions?: Snippet<[ViewerItem, number]>;
    aside?: Snippet<[ViewerItem, number]>;
    hasMore?: boolean;
    onendreached?: () => void;
    onclose?: (index: number) => void;
  } = $props();

  const current = $derived(items[index] ?? null);
  const strip = $derived(stripWindow(index, items.length));

  let stage = $state<HTMLDivElement | null>(null);
  let flight = $state<HTMLDivElement | null>(null);
  let pan = $state<PanState>(RESET);
  let natural = $state<Size | null>(null);
  let loaded = $state(false);
  let failed = $state(false);
  let chrome = $state(true);
  let drag: { start: PanState; x: number; y: number; pointer: number } | null = null;
  let dragging = $state(false);

  const viewport = (): Size => ({ width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 });

  // 换图：复位缩放和加载状态。
  $effect(() => {
    void current?.id;
    untrack(() => {
      pan = RESET;
      loaded = false;
      failed = false;
      natural = current?.width && current?.height ? { width: current.width, height: current.height } : null;
    });
  });

  // 翻到最后几张时要下一页。
  $effect(() => {
    if (open && hasMore && items.length > 0 && index >= items.length - 3) untrack(() => onendreached?.());
  });

  // 邻近两张预取原图。
  $effect(() => {
    if (!open) return;
    for (const offset of [1, -1, 2]) {
      const neighbor = items[index + offset];
      if (!neighbor) continue;
      // 和页面上的图片同一种 CORS 模式，预取的结果才能被复用。
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = neighbor.src;
    }
  });

  function reducedMotion() {
    return (
      document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  // 打开时从缩略图位置飞入：只动 transform，220ms，可被任何输入打断。
  async function flyIn() {
    const item = current;
    const source = item && origin?.(item, index);
    await tick();
    if (!source || !flight || !stage || reducedMotion()) return;
    const from = source.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const image = source instanceof HTMLImageElement ? source : source.querySelector("img");
    const size =
      natural ?? (image?.naturalWidth ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    const to = size ? containedRect(box, size) : null;
    const transform = to ? flightTransform(from, to) : null;
    if (!transform) return;
    const animation = flight.animate([{ transform }, { transform: "none" }], {
      duration: 220,
      easing: "cubic-bezier(.16,1,.3,1)",
    });
    const stop = () => animation.cancel();
    window.addEventListener("pointerdown", stop, { once: true, capture: true });
    void animation.finished.then(
      () => window.removeEventListener("pointerdown", stop, true),
      () => window.removeEventListener("pointerdown", stop, true),
    );
  }

  function go(delta: number) {
    const next = stepIndex(index, delta, items.length);
    if (next >= 0) index = next;
  }

  function closed() {
    stopDrag();
    onclose?.(index);
  }

  /** 自己关（按键、按钮）时 bits-ui 不调 onOpenChange，这里补上关闭回调。 */
  function close() {
    open = false;
    closed();
  }

  function onwheel(event: WheelEvent) {
    event.preventDefault();
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const pointer = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
    pan = wheelZoom(pan, event.deltaY, pointer, natural, viewport());
  }

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0 || pan.scale <= 1) return;
    drag = { start: pan, x: event.clientX, y: event.clientY, pointer: event.pointerId };
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onpointermove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return;
    // 主键已经松开（pointerup 被系统手势吞掉）：结束拖动。
    if ((event.buttons & 1) === 0) return stopDrag();
    pan = dragPan(drag.start, event.clientX - drag.x, event.clientY - drag.y, natural, viewport());
  }

  function stopDrag() {
    drag = null;
    dragging = false;
  }

  function onload(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    loaded = true;
    if (image.naturalWidth && image.naturalHeight) {
      natural = { width: image.naturalWidth, height: image.naturalHeight };
      pan = clampPan(pan, natural, viewport());
    }
  }

  const group = m.keys_group_viewer;
  useOverlay(() => open, {
    id: "viewer",
    bindings: [
      { id: "viewer.prev", keys: ["arrowleft", "h"], label: m.viewer_key_prev, group, run: () => go(-1) },
      { id: "viewer.next", keys: ["arrowright", "l"], label: m.viewer_key_next, group, run: () => go(1) },
      { id: "viewer.close", keys: "space", label: m.viewer_key_close, group, run: close },
      {
        id: "viewer.chrome",
        keys: "f",
        label: m.viewer_key_chrome,
        group,
        run: () => {
          chrome = !chrome;
        },
      },
      {
        id: "viewer.reset",
        keys: "0",
        label: m.viewer_key_reset,
        group,
        run: () => {
          pan = RESET;
        },
      },
    ],
  });
</script>

<DialogPrimitive.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) closed();
  }}
>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Content
      data-testid="viewer"
      data-index={index}
      class="fixed inset-0 z-50 flex flex-col bg-bg0 outline-none duration-(--t-over) ease-ldos data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      onOpenAutoFocus={(event) => {
        // 焦点放在画布上：Space、Enter 不会误触工具栏按钮。
        event.preventDefault();
        stage?.focus();
        void flyIn();
      }}
    >
      {#if chrome}
        <header class="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
          <DialogPrimitive.Title class="min-w-0 truncate text-sm font-medium">
            {current?.name ?? m.viewer_title()}
          </DialogPrimitive.Title>
          <span class="flex-none text-2xs text-fg3 tabular-nums" data-testid="viewer-position">
            {m.viewer_position({ index: index + 1, total: items.length })}{hasMore ? "+" : ""}
          </span>
          {#if current?.meta}<span class="truncate text-2xs text-fg3">{current.meta}</span>{/if}
          <div class="ml-auto flex flex-none items-center gap-2">
            {#if current && actions}{@render actions(current, index)}{/if}
            <Button variant="ghost" size="sm" onclick={() => (chrome = false)}>
              <Maximize2Icon />{m.viewer_focus_mode()} <Kbd>F</Kbd>
            </Button>
            <DialogPrimitive.Close>
              {#snippet child({ props })}
                <Button variant="secondary" size="sm" {...props}><XIcon />{m.common_close()} <Kbd>Esc</Kbd></Button>
              {/snippet}
            </DialogPrimitive.Close>
          </div>
        </header>
      {:else}
        <DialogPrimitive.Title class="sr-only">{current?.name ?? m.viewer_title()}</DialogPrimitive.Title>
      {/if}

      <div class="flex min-h-0 flex-1">
        <div
          bind:this={stage}
          role="group"
          tabindex="-1"
          aria-label={m.viewer_stage()}
          data-testid="viewer-stage"
          data-scale={pan.scale}
          class={cn(
            "relative min-w-0 flex-1 touch-none overflow-hidden outline-none select-none",
            pan.scale > 1 && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
          {onwheel}
          {onpointerdown}
          {onpointermove}
          onpointerup={stopDrag}
          onpointercancel={stopDrag}
          ondblclick={() => (pan = RESET)}
        >
          <div bind:this={flight} class="absolute inset-0">
            <div
              class="absolute inset-0 will-change-transform"
              style:transform="translate({pan.x}px, {pan.y}px) scale({pan.scale})"
            >
              {#if current && !failed}
                {#if current.thumb && !loaded}
                  <img crossorigin="anonymous" src={current.thumb} alt="" draggable="false" class="absolute inset-0 size-full object-contain" />
                {/if}
                {#key current.id}
                  <img
                    crossorigin="anonymous"
                    src={current.src}
                    alt={current.name}
                    draggable="false"
                    class="absolute inset-0 size-full object-contain transition-opacity duration-(--t-color)"
                    style:opacity={loaded ? 1 : 0}
                    {onload}
                    onerror={() => (failed = true)}
                  />
                {/key}
              {/if}
            </div>
          </div>
          {#if current && failed}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-fg3" role="alert">
              <ImageOffIcon class="size-6" />
              <span class="text-sm">{m.viewer_failed({ name: current.name })}</span>
            </div>
          {/if}
          {#if pan.scale > 1}
            <span class="absolute right-3 bottom-3 rounded-sm bg-bg1 px-1.5 py-0.5 text-2xs text-fg2 tabular-nums" aria-live="polite">
              {Math.round(pan.scale * 100)}%
            </span>
          {/if}
          {#if !chrome}
            <Button variant="secondary" size="sm" class="absolute top-3 right-3" onclick={() => (chrome = true)}>
              {m.viewer_show_chrome()} <Kbd>F</Kbd>
            </Button>
          {/if}
        </div>
        {#if chrome && current && aside}
          <aside class="w-[320px] flex-none overflow-y-auto border-l border-line bg-bg1">{@render aside(current, index)}</aside>
        {/if}
      </div>

      {#if chrome}
        <nav class="flex h-[76px] flex-none items-center gap-2 border-t border-line px-3" aria-label={m.viewer_strip()}>
          <Button variant="ghost" size="icon" aria-label={m.viewer_prev()} disabled={index <= 0} onclick={() => go(-1)}>
            <ChevronLeftIcon />
          </Button>
          <div class="flex min-w-0 flex-1 justify-center gap-1.5 overflow-hidden">
            {#each items.slice(strip[0], strip[1]) as item, offset (item.id)}
              {@const position = strip[0] + offset}
              <button
                type="button"
                aria-label={item.name}
                aria-current={position === index ? "true" : undefined}
                class={cn(
                  "h-14 w-11 flex-none overflow-hidden rounded-sm border bg-bg2",
                  position === index ? "border-fg2" : "border-transparent opacity-60 hover:opacity-100",
                )}
                onclick={() => (index = position)}
              >
                {#if item.thumb}
                  <img crossorigin="anonymous" src={item.thumb} alt="" loading="lazy" draggable="false" class="size-full object-cover" />
                {/if}
              </button>
            {/each}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.viewer_next()}
            disabled={index >= items.length - 1}
            onclick={() => go(1)}
          >
            <ChevronRightIcon />
          </Button>
        </nav>
      {/if}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
