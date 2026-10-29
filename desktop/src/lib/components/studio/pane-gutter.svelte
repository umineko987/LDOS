<script lang="ts">
  import { clampPane, type PaneLimits } from "#lib/domain/studio.ts";
  import { cn } from "#lib/utils.ts";

  // 两栏之间的拖动条：按住拖动改相邻那一栏的宽度（像素），聚焦后 ←/→ 每次 16px，Home/End 到两头。
  // `side` 是被调的那一栏在拖动条的哪一边：左栏往右拖变宽，右栏往左拖变宽。
  let {
    width = $bindable(),
    limits,
    side,
    label,
  }: {
    width: number;
    limits: PaneLimits;
    side: "left" | "right";
    label: string;
  } = $props();

  const STEP = 16;
  let dragging = $state(false);
  let origin = 0;
  let start = 0;

  const direction = $derived(side === "left" ? 1 : -1);

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
    origin = event.clientX;
    start = width;
    event.preventDefault();
  }

  function move(event: PointerEvent) {
    if (!dragging) return;
    width = clampPane(start + (event.clientX - origin) * direction, limits);
  }

  function up(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  function key(event: KeyboardEvent) {
    const delta = { ArrowLeft: -STEP, ArrowRight: STEP }[event.key];
    if (delta !== undefined) width = clampPane(width + delta * direction, limits);
    else if (event.key === "Home") width = limits.min;
    else if (event.key === "End") width = limits.max;
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
</script>

<!-- 可聚焦的 separator 在 ARIA 里是可交互的控件（窗口分隔条），Svelte 的检查不认。 -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={width}
  aria-valuemin={limits.min}
  aria-valuemax={limits.max}
  class={cn(
    "group relative z-10 -mx-1 w-2 flex-none cursor-col-resize touch-none outline-none",
    "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-line after:transition-colors after:duration-(--t-color)",
    "hover:after:bg-line3 focus-visible:after:bg-gold",
    dragging && "after:bg-line3",
  )}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
></div>
