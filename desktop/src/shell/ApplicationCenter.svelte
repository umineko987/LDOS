<script lang="ts">
  import { tick } from "svelte";

  import type { ApplicationId } from "../core/applications/definitions";
  import { nextDirectionalIndex, restoreFocus, trappedTabIndex, type FocusTarget } from "../core/a11y/focus";
  import { deriveApplicationGroups } from "../core/state/projections";
  import type { ShellStore } from "../core/state/shell";
  import Icon from "./Icon.svelte";

  let { shell, onLaunch }: {
    shell: ShellStore;
    onLaunch: (appId: ApplicationId) => void;
  } = $props();

  let panel = $state<HTMLElement>();
  let returnFocus: FocusTarget | null = null;
  const snapshot = $derived($shell);
  const groups = deriveApplicationGroups();

  function focusable(): HTMLElement[] {
    return [...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function appButtons(): HTMLElement[] {
    return [...(panel?.querySelectorAll<HTMLElement>("[data-application-center-app]") ?? [])];
  }

  function close(restore = true): void {
    shell.setApplicationCenter(false);
    if (restore) queueMicrotask(() => restoreFocus(returnFocus));
    returnFocus = null;
  }

  function launch(appId: ApplicationId): void {
    close(false);
    onLaunch(appId);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      const items = focusable();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = trappedTabIndex(current, items.length, event.shiftKey);
      if (next !== null) {
        event.preventDefault();
        restoreFocus(items[next]);
      }
      return;
    }
    const items = appButtons();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextDirectionalIndex(current, items.length, event.key);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    }
  }

  $effect(() => {
    if (!snapshot.applicationCenterOpen) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => restoreFocus(appButtons()[0] ?? panel));
  });
</script>

{#if snapshot.applicationCenterOpen}
  <div class="application-center-host" data-application-center-host>
    <button
      type="button"
      class="application-center__backdrop"
      data-application-center-backdrop
      aria-label="关闭应用中心"
      onclick={() => close()}
    ></button>
    <div
      class="application-center"
      data-application-center
      role="dialog"
      aria-modal="true"
      aria-labelledby="application-center-title"
      tabindex="-1"
      bind:this={panel}
      onkeydown={onKeydown}
    >
      <header class="application-center__header">
        <div>
          <p>ImageWeave</p>
          <h2 id="application-center-title">应用中心</h2>
        </div>
        <button type="button" aria-label="关闭应用中心" onclick={() => close()}>关闭</button>
      </header>
      <div class="application-center__groups">
        {#each groups as group}
          <section class="application-center__group" aria-labelledby="application-group-{group.id}">
            <h3 id="application-group-{group.id}">{group.title}</h3>
            <ul>
              {#each group.applications as application}
                <li>
                  <button
                    type="button"
                    class="application-center__item"
                    data-application-center-app={application.id}
                    aria-label="{application.title}，{application.availability === 'ready' ? '可用' : '前端预览'}。{application.description}"
                    onclick={() => launch(application.id)}
                  >
                    <span class="application-center__icon" aria-hidden="true"><Icon name={application.icon} /></span>
                    <span class="application-center__copy">
                      <strong>{application.title}</strong>
                      <small>{application.description}</small>
                    </span>
                    <span class="availability" data-availability={application.availability}>
                      {application.availability === "ready" ? "可用" : "前端预览"}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}
