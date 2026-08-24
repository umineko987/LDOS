<script lang="ts">
  import { tick } from "svelte";

  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../core/a11y/focus";
  import type { ShellStore } from "../core/state/shell";

  let { shell }: { shell: ShellStore } = $props();
  let dialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;
  const snapshot = $derived($shell);

  function focusable(): HTMLElement[] {
    return [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function finish(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    shell.resolveConfirmation(confirmed);
    void tick().then(() => restoreFocus(target));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
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
    if (!snapshot.confirmation) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
      restoreFocus(focusable()[0] ?? dialog);
    });
  });
</script>

{#if snapshot.confirmation}
  <dialog
    class="shell-dialog"
    data-shell-dialog
    aria-modal="true"
    aria-labelledby="shell-dialog-title"
    aria-describedby="shell-dialog-description shell-dialog-warning"
    bind:this={dialog}
    oncancel={(event) => { event.preventDefault(); finish(false); }}
    onkeydown={onKeydown}
    onclick={(event) => { if (event.target === event.currentTarget) finish(false); }}
  >
    <section class="shell-dialog__panel">
      <h2 id="shell-dialog-title">{snapshot.confirmation.title}</h2>
      <p id="shell-dialog-description">{snapshot.confirmation.message}</p>
      <p id="shell-dialog-warning" class="shell-dialog__warning"><strong>警告：</strong>未保存的更改不会保留。</p>
      <div class="shell-dialog__actions">
        <button type="button" onclick={() => finish(false)}>取消</button>
        <button type="button" class="dangerous" onclick={() => finish(true)}>{snapshot.confirmation.confirmLabel}</button>
      </div>
    </section>
  </dialog>
{/if}
