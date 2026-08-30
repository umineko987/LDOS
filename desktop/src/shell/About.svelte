<script lang="ts">
  import { tick } from "svelte";

  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../core/a11y/focus";

  let { open, onClose }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  let panel = $state<HTMLElement>();
  let returnFocus: FocusTarget | null = null;

  function focusable(): HTMLElement[] {
    return [...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function close(): void {
    const target = returnFocus;
    onClose();
    returnFocus = null;
    queueMicrotask(() => restoreFocus(target));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = trappedTabIndex(current, items.length, event.shiftKey);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    }
  }

  $effect(() => {
    if (!open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => restoreFocus(focusable()[0] ?? panel));
  });
</script>

{#if open}
  <div class="application-center-host about-host" data-about-host>
    <button
      type="button"
      class="application-center__backdrop"
      data-about-backdrop
      tabindex="-1"
      aria-label="关闭关于 LDOS"
      onclick={close}
    ></button>
    <div
      class="application-center about-dialog"
      data-about-dialog
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      aria-describedby="about-full-name about-tagline"
      tabindex="-1"
      bind:this={panel}
      onkeydown={onKeydown}
    >
      <header class="application-center__header">
        <p>关于</p>
        <button type="button" aria-label="关闭关于 LDOS" onclick={close}>关闭</button>
      </header>
      <div class="about-dialog__body">
        <div class="about-dialog__identity">
          <span class="about-dialog__mark" aria-hidden="true">LD</span>
          <div>
            <h2 id="about-title">LDOS</h2>
            <p id="about-full-name">LoRA Dataset Operating System</p>
          </div>
        </div>
        <p id="about-tagline" class="about-dialog__tagline" lang="en">The operating workspace for LoRA datasets.</p>
        <p class="about-dialog__summary">面向 LoRA 数据集采集、整理与去重审核的一站式桌面工作流。</p>
      </div>
    </div>
  </div>
{/if}
