<script lang="ts">
  import { untrack } from "svelte";

  import type { Api } from "#lib/api/client.ts";
  import type { TriageMember } from "#lib/api/queries/triage.ts";
  import { clampZoom, DECK_GAP, deckLayout, isZoomed, panBy, ZOOM_RESET, zoomAt, zoomTransform, type Zoom } from "#lib/domain/compare-deck.ts";
  import { formatBytes } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import type { TriageGroupStatus } from "#lib/keys/triage.ts";
  import { m } from "#lib/paraglide/messages.js";

  import DeckCard from "./deck-card.svelte";

  // 去重的对比卡组：一组近似重复并排，卡片一样大，滚轮缩放、拖动平移时所有图同步（以焦点那张为准约束）。
  // 双击复原。换组时复原。从 legacy-src/apps/review/engine.ts 移植。
  let {
    api,
    group,
    members,
    keep,
    status,
    focus,
    ontoggle,
  }: {
    api: Api;
    /** 组 id：换组时复原缩放。 */
    group: string;
    members: readonly TriageMember[];
    keep: ReadonlySet<string>;
    status: TriageGroupStatus;
    focus: number;
    ontoggle: (index: number) => void;
  } = $props();

  /** 卡片下方说明条的高度（两行小字 + 内边距）。 */
  const STRIP = 54;
  const DRAG_SLOP = 4;

  let host = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  let zoom = $state.raw<Zoom>(ZOOM_RESET);
  let drag: { pointer: number; x: number; y: number; moved: boolean } | null = null;
  let suppressClick = false;

  $effect.pre(() => {
    void group;
    untrack(() => (zoom = ZOOM_RESET));
  });

  const layout = $derived.by(() => {
    const images = members.map((member) => ({ width: member.width, height: member.height, readable: member.readable }));
    const first = deckLayout(images, width, height - STRIP);
    return first.rows > 1 ? deckLayout(images, width, height - STRIP * first.rows) : first;
  });
  const tile = $derived({ width: layout.tileWidth, height: layout.tileHeight });
  const focused = $derived(members[focus] ?? null);
  const focusImage = $derived(focused && focused.readable && focused.width > 0 ? { width: focused.width, height: focused.height } : null);
  const transform = $derived(isZoomed(zoom) ? zoomTransform(zoom) : undefined);

  const clamp = (next: Zoom) => clampZoom(next, focusImage, tile);

  function tileOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>("[data-zoom-tile]") : null;
  }

  $effect(() => {
    const element = host;
    if (!element) return;
    const onwheel = (event: WheelEvent) => {
      const card = tileOf(event.target);
      if (!card) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 320 : event.deltaY;
      zoom = clamp(zoomAt(zoom, Math.max(-400, Math.min(400, delta)), anchor));
    };
    element.addEventListener("wheel", onwheel, { passive: false });
    return () => element.removeEventListener("wheel", onwheel);
  });

  function onpointerdown(event: PointerEvent) {
    suppressClick = false;
    if (event.button !== 0 || zoom.scale <= 1 || !tileOf(event.target)) return;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }

  function onpointermove(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    // 真的拖起来了才捕获指针：只是点一下时点击照常落到卡片上。
    if (!drag.moved) host?.setPointerCapture?.(event.pointerId);
    drag = { ...drag, x: event.clientX, y: event.clientY, moved: true };
    zoom = clamp(panBy(zoom, { x: dx, y: dy }));
  }

  function onpointerup(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
  }

  function toggle(index: number) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    ontoggle(index);
  }

  export function reset() {
    zoom = ZOOM_RESET;
  }
</script>

<div
  bind:this={host}
  bind:clientWidth={width}
  bind:clientHeight={height}
  class="relative flex min-h-0 flex-1 flex-wrap content-center items-start justify-center overflow-hidden"
  style:gap={`${DECK_GAP}px`}
  role="group"
  aria-label={m.dedup_deck()}
  data-testid="compare-deck"
  data-zoomed={isZoomed(zoom) || undefined}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  ondblclick={reset}
>
  {#if layout.columns > 0}
    {#each members as member, index (member.asset_id)}
      <DeckCard
          {index}
          src={member.readable ? api.resourceUrl(member.image_url) : null}
          alt={member.name}
          kept={keep.has(member.asset_id)}
          {status}
          focused={index === focus}
          suggested={member.recommended}
          failed={member.disposition === "failed"}
          fit="contain"
          width={layout.tileWidth}
          height={layout.tileHeight}
          {transform}
          zoomable
          onclick={() => toggle(index)}
        >
          {#snippet meta()}
            <span class="truncate text-fg2 tabular-nums">
              {member.readable ? `${member.width}×${member.height} · ` : ""}{member.format.toUpperCase()} · {formatBytes(member.size_bytes, i18n.current)}
            </span>
          {/snippet}
        </DeckCard>
    {/each}
  {/if}
</div>
