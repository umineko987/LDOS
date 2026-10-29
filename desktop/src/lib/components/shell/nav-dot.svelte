<script lang="ts">
  // 选中指示：容器里只有一个金色圆点，在 `[data-active] [data-dot-anchor]` 之间平移。
  // 只动 transform，时长 --t-move（180ms），缓动没有回弹；首次定位和容器尺寸变化时不做动画。
  // 放在 position: relative 的容器里，作为它的直接子元素。

  import { untrack } from "svelte";

  let { active, class: className = "" }: { active: unknown; class?: string } = $props();

  let dot: HTMLSpanElement;
  let position = $state<{ x: number; y: number } | null>(null);
  let animate = $state(false);

  function measure(): { x: number; y: number } | null {
    const container = dot.parentElement;
    const anchor = container?.querySelector<HTMLElement>("[data-active] [data-dot-anchor]");
    if (!container || !anchor) return null;
    const box = container.getBoundingClientRect();
    const target = anchor.getBoundingClientRect();
    return {
      x: Math.round(target.left - box.left + container.scrollLeft),
      y: Math.round(target.top - box.top + container.scrollTop + (target.height - 7) / 2),
    };
  }

  $effect(() => {
    void active;
    const next = measure();
    // 不能把 position 读成依赖：写回它会让这个 effect 反复执行。
    animate = untrack(() => position) !== null && next !== null;
    position = next;
  });

  $effect(() => {
    const container = dot.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      animate = false;
      position = measure();
    });
    observer.observe(container);
    return () => observer.disconnect();
  });
</script>

<span
  bind:this={dot}
  aria-hidden="true"
  data-testid="nav-dot"
  data-visible={position !== null}
  class="pointer-events-none absolute top-0 left-0 size-[7px] rounded-full bg-gold {animate
    ? 'transition-transform duration-(--t-move) ease-ldos'
    : ''} {className}"
  style:opacity={position ? 1 : 0}
  style:transform={position ? `translate(${position.x}px, ${position.y}px)` : undefined}
></span>
