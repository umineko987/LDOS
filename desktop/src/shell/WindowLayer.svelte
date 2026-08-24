<script lang="ts">
  import { onMount } from "svelte";

  import type { ApplicationId } from "../core/applications/definitions";
  import type { ApiClient } from "../core/api/client";
  import type { PersistenceService } from "../core/persistence/service";
  import type { PollingService } from "../core/polling/service";
  import { isDockHidden, type ShellStore } from "../core/state/shell";
  import {
    clampWindowRect,
    keyboardResizeWindowRect,
    sameWindowRect,
    type ResizeDirection,
    type WindowViewport,
  } from "../core/windowing/geometry";
  import {
    createWindowInteractionEngine,
    type WindowInteractionEngine,
    type WindowInteractionMode,
  } from "../core/windowing/interaction";
  import AppWindow from "./AppWindow.svelte";

  interface Props {
    shell: ShellStore;
    api: ApiClient;
    polling: PollingService;
    persistence: PersistenceService;
    onNavigate: (appId: ApplicationId) => void;
    onFocus: (appId: ApplicationId) => void;
    onMinimize: (appId: ApplicationId) => void;
    onToggleMaximized: (appId: ApplicationId) => void;
    onClose: (appId: ApplicationId) => void;
  }

  let {
    shell,
    api,
    polling,
    persistence,
    onNavigate,
    onFocus,
    onMinimize,
    onToggleMaximized,
    onClose,
  }: Props = $props();
  let layer = $state<HTMLDivElement>();
  let interaction: WindowInteractionEngine | null = null;
  const snapshot = $derived($shell);
  const visibleWindows = $derived(snapshot.windows.filter(({ state: windowState }) => windowState !== "minimized"));
  const workspace = $derived(isDockHidden(snapshot) ? "maximized" : "normal");

  function currentViewport(): WindowViewport | null {
    if (!layer || layer.clientWidth < 32 || layer.clientHeight < 32) return null;
    return Object.freeze({ width: layer.clientWidth, height: layer.clientHeight });
  }

  function repairGeometry(): void {
    if (interaction?.isActive()) return;
    const viewport = currentViewport();
    if (!viewport) return;
    for (const record of shell.getState().windows) {
      if (record.state !== "normal") continue;
      const rect = clampWindowRect(record.rect, viewport);
      if (!sameWindowRect(record.rect, rect)) shell.commitWindowRect(record.appId, rect);
    }
  }

  function beginInteraction(appId: ApplicationId, mode: WindowInteractionMode, event: PointerEvent): void {
    const record = shell.getState().windows.find((windowRecord) => windowRecord.appId === appId);
    const viewport = currentViewport();
    const handle = event.currentTarget as HTMLElement | null;
    const element = handle?.closest<HTMLElement>("[data-app-window]") ?? null;
    if (!record || record.state !== "normal" || !viewport || !handle || !element) return;
    onFocus(appId);
    interaction?.begin({ appId, mode, rect: record.rect, viewport, element, handle, event });
  }

  function keyboardResize(appId: ApplicationId, direction: ResizeDirection, event: KeyboardEvent): void {
    const record = shell.getState().windows.find((windowRecord) => windowRecord.appId === appId);
    const viewport = currentViewport();
    if (!record || record.state !== "normal" || !viewport) return;
    const rect = keyboardResizeWindowRect(record.rect, direction, event.key, viewport);
    if (!rect) return;
    event.preventDefault();
    onFocus(appId);
    shell.commitWindowRect(appId, rect);
  }

  $effect(() => {
    snapshot.windows;
    queueMicrotask(repairGeometry);
  });

  onMount(() => {
    interaction = createWindowInteractionEngine({
      events: window,
      frames: {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (frameId) => window.cancelAnimationFrame(frameId),
      },
      commit: (appId, rect) => { shell.commitWindowRect(appId, rect); },
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(repairGeometry) : null;
    if (layer) observer?.observe(layer);
    window.addEventListener("resize", repairGeometry);
    repairGeometry();
    return () => {
      interaction?.destroy();
      interaction = null;
      observer?.disconnect();
      window.removeEventListener("resize", repairGeometry);
    };
  });
</script>

<div class="window-layer" data-window-layer data-window-workspace={workspace} bind:this={layer}>
  {#each visibleWindows as record (record.appId)}
    <AppWindow
      {record}
      {api}
      {polling}
      {persistence}
      shellUnsaved={(appId, reader, discard) => shell.registerUnsavedChanges(appId, reader, discard)}
      {onNavigate}
      focused={record.appId === snapshot.focusedAppId}
      {onFocus}
      {onMinimize}
      {onToggleMaximized}
      {onClose}
      onBeginInteraction={beginInteraction}
      onKeyboardResize={keyboardResize}
    />
  {/each}
</div>
