<script lang="ts">
  import { onMount } from "svelte";

  import type { ApplicationId } from "../core/applications/definitions";
  import { isDockHidden, type ShellStore } from "../core/state/shell";
  import { clampWindowRect, sameWindowRect } from "../core/windowing/geometry";
  import AppWindow from "./AppWindow.svelte";

  interface Props {
    shell: ShellStore;
    onFocus: (appId: ApplicationId) => void;
    onMinimize: (appId: ApplicationId) => void;
    onToggleMaximized: (appId: ApplicationId) => void;
    onClose: (appId: ApplicationId) => void;
  }

  let { shell, onFocus, onMinimize, onToggleMaximized, onClose }: Props = $props();
  let layer = $state<HTMLDivElement>();
  const snapshot = $derived($shell);
  const visibleWindows = $derived(snapshot.windows.filter(({ state: windowState }) => windowState !== "minimized"));
  const workspace = $derived(isDockHidden(snapshot) ? "maximized" : "normal");

  function repairGeometry(): void {
    if (!layer) return;
    const viewport = { width: layer.clientWidth, height: layer.clientHeight };
    if (viewport.width < 32 || viewport.height < 32) return;
    for (const record of shell.getState().windows) {
      if (record.state !== "normal") continue;
      const rect = clampWindowRect(record.rect, viewport);
      if (!sameWindowRect(record.rect, rect)) shell.commitWindowRect(record.appId, rect);
    }
  }

  $effect(() => {
    snapshot.windows;
    queueMicrotask(repairGeometry);
  });

  onMount(() => {
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(repairGeometry) : null;
    if (layer) observer?.observe(layer);
    window.addEventListener("resize", repairGeometry);
    repairGeometry();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", repairGeometry);
    };
  });
</script>

<div class="window-layer" data-window-layer data-window-workspace={workspace} bind:this={layer}>
  {#each visibleWindows as record (record.appId)}
    <AppWindow
      {record}
      focused={record.appId === snapshot.focusedAppId}
      {onFocus}
      {onMinimize}
      {onToggleMaximized}
      {onClose}
    />
  {/each}
</div>
