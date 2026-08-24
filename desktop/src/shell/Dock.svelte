<script lang="ts">
  import { onMount, tick } from "svelte";

  import { nextDirectionalIndex, restoreFocus } from "../core/a11y/focus";
  import { deriveDockProjection, type DockItemProjection } from "../core/state/projections";
  import { isDockHidden, type ShellStore } from "../core/state/shell";
  import Icon from "./Icon.svelte";

  let { shell, onActivate }: {
    shell: ShellStore;
    onActivate: (item: DockItemProjection) => void;
  } = $props();

  let dock = $state<HTMLElement>();
  const snapshot = $derived($shell);
  const hidden = $derived(isDockHidden(snapshot));
  const model = $derived(deriveDockProjection(snapshot));

  function primaryButtons(): HTMLElement[] {
    return [...(dock?.querySelectorAll<HTMLElement>("[data-dock-primary] [data-dock-focusable]") ?? [])];
  }

  function onPrimaryKeydown(event: KeyboardEvent): void {
    const buttons = primaryButtons();
    const current = buttons.indexOf(event.currentTarget as HTMLElement);
    const next = nextDirectionalIndex(current, buttons.length, event.key);
    if (next === null || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    restoreFocus(buttons[next]);
  }

  async function toggleOverflow(): Promise<void> {
    const open = !shell.getState().dockOverflowOpen;
    shell.setDockOverflow(open);
    if (!open) return;
    await tick();
    restoreFocus(dock?.querySelector<HTMLElement>("[data-dock-overflow] [data-dock-item]"));
  }

  function closeOverflow(returnFocus = false): void {
    if (!shell.getState().dockOverflowOpen) return;
    shell.setDockOverflow(false);
    if (returnFocus) {
      queueMicrotask(() => restoreFocus(dock?.querySelector<HTMLElement>("[data-dock-overflow-button]")));
    }
  }

  function onOverflowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeOverflow(true);
      return;
    }
    const buttons = [...(dock?.querySelectorAll<HTMLElement>("[data-dock-overflow] [data-dock-item]") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const next = nextDirectionalIndex(current, buttons.length, event.key);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(buttons[next]);
    }
  }

  function activate(item: DockItemProjection): void {
    closeOverflow();
    onActivate(item);
  }

  onMount(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (snapshot.dockOverflowOpen && event.target instanceof Node && dock && !dock.contains(event.target)) {
        closeOverflow();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  });
</script>

{#if !hidden}
  <nav class="dock" data-dock aria-label="ImageWeave Dock" bind:this={dock}>
    <div class="dock__surface">
      <div class="dock__primary" data-dock-primary aria-label="常用和运行中的应用">
        {#each model.visible as item (item.key)}
          <button
            type="button"
            class="dock__item"
            data-dock-focusable
            data-dock-item={item.key}
            data-dock-state={item.state}
            aria-label={item.ariaLabel}
            aria-pressed={item.state === "focused"}
            title={item.ariaLabel}
            onclick={() => activate(item)}
            onkeydown={onPrimaryKeydown}
          >
            <span class="dock__icon" aria-hidden="true"><Icon name={item.icon} size={25} /></span>
            <span class="dock__label">{item.title}</span>
            <span class="dock__state" aria-hidden="true">{item.stateLabel}</span>
          </button>
        {/each}
      </div>
      {#if model.overflow.length > 0}
        <button
          type="button"
          class="dock__overflow-button"
          data-dock-focusable
          data-dock-overflow-button
          aria-label="更多 Dock 应用"
          aria-haspopup="true"
          aria-expanded={snapshot.dockOverflowOpen}
          aria-controls="dock-overflow"
          onclick={() => void toggleOverflow()}
          onkeydown={onPrimaryKeydown}
        >更多</button>
      {/if}
      {#if snapshot.dockOverflowOpen && model.overflow.length > 0}
        <div class="dock__overflow" id="dock-overflow" data-dock-overflow role="toolbar" aria-label="更多 Dock 应用" aria-orientation="vertical" tabindex="-1" onkeydown={onOverflowKeydown}>
          {#each model.overflow as item (item.key)}
            <button
              type="button"
              class="dock__overflow-item"
              data-dock-item={item.key}
              data-dock-state={item.state}
              aria-label={item.ariaLabel}
              aria-pressed={item.state === "focused"}
              onclick={() => activate(item)}
            >
              <span aria-hidden="true"><Icon name={item.icon} size={21} /></span>
              <strong>{item.title}</strong>
              <small>{item.stateLabel}</small>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </nav>
{/if}
