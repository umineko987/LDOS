<script lang="ts">
  import { onMount, tick } from "svelte";

  import type { ApplicationId } from "../core/applications/definitions";
  import type { ApiClient } from "../core/api/client";
  import { restoreFocus } from "../core/a11y/focus";
  import type { PersistenceService } from "../core/persistence/service";
  import type { PollingService } from "../core/polling/service";
  import { createHashRouter, type HashRouter, type RouteChange } from "../core/routing/hash";
  import type { DockItemProjection } from "../core/state/projections";
  import type { ShellStore } from "../core/state/shell";
  import About from "./About.svelte";
  import ApplicationCenter from "./ApplicationCenter.svelte";
  import Dialog from "./Dialog.svelte";
  import Dock from "./Dock.svelte";
  import MenuBar from "./MenuBar.svelte";
  import Wallpaper from "./Wallpaper.svelte";
  import WindowLayer from "./WindowLayer.svelte";

  let { shell, persistence, polling, api }: {
    shell: ShellStore;
    persistence: PersistenceService;
    polling: PollingService;
    api: ApiClient;
  } = $props();
  let desktop = $state<HTMLElement>();
  let aboutOpen = $state(false);
  let router: HashRouter | null = null;
  let routeGeneration = 0;
  const preferences = $derived(persistence.readUiPreferences());
  const snapshot = $derived($shell);

  function announce(message: string): void {
    const announcer = desktop?.querySelector<HTMLElement>("[data-route-announcer]");
    if (announcer) announcer.textContent = message;
  }

  async function focusWindowBody(appId: ApplicationId | null): Promise<boolean> {
    if (appId === null) return false;
    await tick();
    const body = desktop?.querySelector<HTMLElement>(`[data-app-window][data-app-id="${appId}"] [data-window-body]`);
    body?.focus({ preventScroll: true });
    return Boolean(body);
  }

  async function handleRoute(change: RouteChange): Promise<void> {
    const generation = ++routeGeneration;
    const current = shell.getState().focusedAppId;
    if (change.appId === null) {
      if (current && !change.skipUnsaved) {
        const minimized = await shell.requestMinimize(current);
        if (generation !== routeGeneration) return;
        if (!minimized) {
          router?.restore(current);
          announce("无法离开当前窗口；请先处理未保存内容。");
          return;
        }
      }
      announce(change.malformed ? "无法识别该地址，已返回 LDOS 桌面。" : "已返回 LDOS 桌面。");
      return;
    }

    if (current && current !== change.appId && !change.skipUnsaved) {
      const allowed = await shell.requestLeave(current);
      if (generation !== routeGeneration) return;
      if (!allowed) {
        router?.restore(current);
        announce("无法切换应用；请先处理未保存内容。");
        return;
      }
    }
    shell.openApplication(change.appId);
    announce(`已打开${shell.getState().windows.at(-1)?.appId === change.appId ? "应用" : "窗口"}。`);
    await focusWindowBody(change.appId);
  }

  function navigate(appId: ApplicationId): void {
    if (router) router.navigate(appId);
    else {
      shell.openApplication(appId);
      void focusWindowBody(appId);
    }
  }

  function focusWindow(appId: ApplicationId): void {
    shell.focusApplication(appId);
    router?.restore(appId);
  }

  async function focusDock(appId: ApplicationId | null): Promise<void> {
    await tick();
    const key = appId === null ? "application-center" : `app:${appId}`;
    const item = desktop?.querySelector<HTMLElement>(`[data-dock-item="${key}"]`);
    const fallback = desktop?.querySelector<HTMLElement>("[data-dock-overflow-button]");
    (item ?? fallback)?.focus({ preventScroll: true });
  }

  function focusBeforeWindowHide(): void {
    restoreFocus(desktop?.querySelector<HTMLElement>('[data-menu-trigger="file"]'));
  }

  async function minimizeWindow(appId: ApplicationId): Promise<void> {
    if (!await shell.requestMinimize(appId, focusBeforeWindowHide)) return;
    const focused = shell.getState().focusedAppId;
    router?.restore(focused);
    await focusDock(appId);
  }

  async function closeWindow(appId: ApplicationId): Promise<void> {
    if (!await shell.requestClose(appId, focusBeforeWindowHide)) return;
    const focused = shell.getState().focusedAppId;
    router?.restore(focused);
    if (!await focusWindowBody(focused)) await focusDock(null);
  }

  function toggleMaximized(appId: ApplicationId): void {
    shell.toggleMaximized(appId);
    void focusWindowBody(appId);
  }

  function onDockActivate(item: DockItemProjection): void {
    if (item.activation === "open-center") {
      shell.setApplicationCenter(true);
      return;
    }
    if (item.appId === null) return;
    if (item.activation === "minimize") void minimizeWindow(item.appId);
    else navigate(item.appId);
  }

  function onWindowCommand(command: "minimize" | "focus" | "restore", appId: ApplicationId): void {
    if (command === "minimize") void minimizeWindow(appId);
    else navigate(appId);
  }

  onMount(() => {
    const previousMotion = document.documentElement.dataset.motion;
    document.documentElement.dataset.motion = preferences.animations;
    router = createHashRouter((change) => { void handleRoute(change); });
    router.start();
    return () => {
      routeGeneration += 1;
      router?.stop();
      router = null;
      if (previousMotion === undefined) delete document.documentElement.dataset.motion;
      else document.documentElement.dataset.motion = previousMotion;
    };
  });
</script>

<main
  class="desktop"
  data-desktop
  data-product-contract="nocturne-glass-desktop"
  data-scene={preferences.wallpaperColor}
  bind:this={desktop}
>
  <button
    type="button"
    class="skip-link"
    data-skip-link
    onclick={() => void focusWindowBody(snapshot.focusedAppId)}
  >跳到当前应用</button>

  <Wallpaper scene={preferences.wallpaperColor} />
  <MenuBar
    {shell}
    onOpenApplicationCenter={() => shell.setApplicationCenter(true)}
    onOpenAbout={() => { aboutOpen = true; }}
    onNavigate={navigate}
    {onWindowCommand}
  />
  <WindowLayer
    {shell}
    {api}
    {polling}
    {persistence}
    onNavigate={navigate}
    onFocus={focusWindow}
    onMinimize={(appId) => void minimizeWindow(appId)}
    onToggleMaximized={toggleMaximized}
    onClose={(appId) => void closeWindow(appId)}
  />
  <About open={aboutOpen} onClose={() => { aboutOpen = false; }} />
  <ApplicationCenter {shell} onLaunch={navigate} />
  <Dock {shell} onActivate={onDockActivate} />
  <Dialog {shell} />

  <p class="visually-hidden" data-route-announcer aria-live="polite" aria-atomic="true"></p>
</main>

<section class="desktop-size-blocker" role="alert" aria-labelledby="desktop-size-title">
  <div>
    <h1 id="desktop-size-title">请使用更大的桌面窗口</h1>
    <p>LDOS 需要至少 1180 × 720 CSS 像素。请扩大窗口后继续。</p>
  </div>
</section>
