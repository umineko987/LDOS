<script lang="ts">
  import { onMount, tick } from "svelte";

  import { selectionTrack } from "../core/motion/selectionTrack";
  import Crawl from "../apps/crawl/Crawl.svelte";
  import Tasks from "../apps/tasks/Tasks.svelte";
  import Gallery from "../apps/gallery/Gallery.svelte";
  import type { GallerySelection, PickGalleryAssets } from "../apps/gallery/picker";
  import Review from "../apps/review/Review.svelte";
  import Tagger from "../apps/tagger/Tagger.svelte";
  import Proxy from "../apps/proxy/Proxy.svelte";
  import Vault from "../apps/vault/Vault.svelte";
  import Policy from "../apps/policy/Policy.svelte";
  import Diagnostics from "../apps/diagnostics/Diagnostics.svelte";
  import Personalization from "../apps/personalization/Personalization.svelte";
  import FilterPresets from "../apps/filter-presets/FilterPresets.svelte";
  import { getApplicationDefinition, type ApplicationId } from "../core/applications/definitions";
  import type { ApiClient } from "../core/api/client";
  import { language, toggleLanguage } from "../core/i18n";
  import type { PersistenceService } from "../core/persistence/service";
  import type { PollingService } from "../core/polling/service";
  import { createHashRouter, type HashRouter, type RouteChange } from "../core/routing/hash";
  import type { ShellStore } from "../core/state/shell";
  import { localizeUi } from "./localizeUi";
  import About from "./About.svelte";
  import Icon from "./Icon.svelte";
  import Wallpaper from "./Wallpaper.svelte";

  let { shell, persistence, polling, api }: {
    shell: ShellStore;
    persistence: PersistenceService;
    polling: PollingService;
    api: ApiClient;
  } = $props();

  const primaryPages = [
    { id: "crawl", label: "采集" },
    { id: "tasks", label: "批次" },
    { id: "gallery", label: "图库" },
    { id: "review", label: "去重" },
    { id: "tagger", label: "打标" },
  ] as const;
  const settingsPages = [
    { id: "proxy", label: "代理" },
    { id: "vault", label: "授权" },
    { id: "policy", label: "站点" },
    { id: "diagnostics", label: "诊断" },
    { id: "personalization", label: "外观" },
    { id: "filter-presets", label: "筛选预设" },
  ] as const;
  let desktop = $state<HTMLElement>();
  let aboutOpen = $state(false);
  let lastSettingsPage = $state<ApplicationId>("proxy");
  let router: HashRouter | null = null;
  const preferences = $derived(persistence.readUiPreferences());
  const snapshot = $derived($shell);
  const inSettings = $derived(settingsPages.some(({ id }) => id === snapshot.focusedAppId));


  type PickerSession = {
    origin: string;
    assetIds: readonly string[];
    directoryIds?: readonly string[];
    appId: ApplicationId;
    focus: HTMLElement | null;
    dialogs: HTMLDialogElement[];
    resolve: (ids: GallerySelection | null) => void;
    unsubscribe: () => void;
  };
  let picker = $state.raw<PickerSession | null>(null);
  let restoringPicker = false;
  let destroyed = false;

  const pickAssets: PickGalleryAssets = ({ origin, assetIds, directoryIds, signal }) => {
    const appId = shell.getState().focusedAppId;
    if (picker || restoringPicker || destroyed || signal.aborted || !appId) return Promise.resolve(null);
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogs = [...desktop?.querySelectorAll<HTMLDialogElement>('[data-app-page] dialog[open]') ?? []];
    // Suspend presentation only: native cancel would discard Gallery's processing draft.
    for (const dialog of dialogs) dialog.close();
    return new Promise((resolve) => {
      const cancel = () => finishPicker(session, null);
      const session: PickerSession = { origin, assetIds: [...assetIds], directoryIds: directoryIds ? [...directoryIds] : undefined, appId, focus, dialogs, resolve,
        unsubscribe: () => signal.removeEventListener("abort", cancel) };
      picker = session;
      signal.addEventListener("abort", cancel, { once: true });
      void tick().then(() => {
        if (picker === session) desktop?.querySelector<HTMLElement>('[data-gallery-picker-heading]')?.focus({ preventScroll: true });
      });
    });
  };

  function finishPicker(session: PickerSession, ids: GallerySelection | null): void {
    if (picker !== session) return;
    session.unsubscribe(); picker = null; restoringPicker = true;
    session.resolve(ids);
    void tick().then(() => {
      if (destroyed || picker || shell.getState().focusedAppId !== session.appId) return;
      for (const dialog of session.dialogs) if (dialog.isConnected && !dialog.open) dialog.showModal();
      if (session.focus?.isConnected) session.focus.focus({ preventScroll: true });
    }).finally(() => { restoringPicker = false; });
  }
  async function focusPage(appId: ApplicationId | null): Promise<void> {
    await tick();
    if (!appId || shell.getState().focusedAppId !== appId || aboutOpen) return;
    desktop?.querySelector<HTMLElement>(`[data-app-page][data-app-id="${appId}"]`)?.focus({ preventScroll: true });
  }

  function handleRoute(change: RouteChange): void {
    if (picker) {
      const session = picker;
      finishPicker(session, null);
      router?.restore(session.appId);
      return;
    }
    if (change.appId === null) {
      router?.navigate("crawl", { replace: true });
      return;
    }
    if (shell.getState().focusedAppId !== change.appId) {
      // Native modal dialogs stay in the top layer even when their page is hidden.
      for (const dialog of desktop?.querySelectorAll<HTMLDialogElement>("[data-app-page] dialog[open]") ?? []) {
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
        dialog.close();
      }
      aboutOpen = false;
    }
    const changed = shell.openApplication(change.appId);
    if (settingsPages.some(({ id }) => id === change.appId)) lastSettingsPage = change.appId;
    if (changed) void focusPage(change.appId);
  }

  let sidebarCollapsed = $state(false);
  let sidebarEl = $state<HTMLElement>();
  let navDot = $state<HTMLElement>();
  let navDotPlaced = false;
  let lastNavDotLanguage: string | null = null;
  let lastNavDotSidebarCollapsed: boolean | null = null;

  function placeNavDot(animate: boolean): void {
    const anchor = sidebarCollapsed
      ? sidebarEl?.querySelector<HTMLElement>("button[aria-current] svg")
      : sidebarEl?.querySelector<HTMLElement>("button[aria-current] > span:last-child");
    if (!sidebarEl || !navDot || !anchor) return;
    const sidebarRect = sidebarEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const size = navDot.offsetWidth;
    const x = anchorRect.right - sidebarRect.left + (sidebarCollapsed ? 4 : 10);
    const y = anchorRect.top - sidebarRect.top + anchorRect.height / 2 - size / 2;
    navDot.style.transition = animate ? "" : "none";
    navDot.style.transform = `translate(${x}px, ${y}px)`;
    if (!animate) {
      void navDot.offsetHeight;
      navDot.style.transition = "";
    }
    navDot.style.visibility = "visible";
    navDotPlaced = true;
  }

  $effect(() => {
    void snapshot.focusedAppId;
    const sidebarChanged = lastNavDotSidebarCollapsed !== null && lastNavDotSidebarCollapsed !== sidebarCollapsed;
    lastNavDotSidebarCollapsed = sidebarCollapsed;
    const languageChanged = lastNavDotLanguage !== null && $language !== lastNavDotLanguage;
    lastNavDotLanguage = $language;
    if (languageChanged || sidebarChanged) {
      // localizeUi rewrites label text synchronously on store change; measure without sliding.
      placeNavDot(false);
      return;
    }
    placeNavDot(navDotPlaced);
  });
  function navigate(appId: ApplicationId): void {
    if (!picker && !restoringPicker && appId !== snapshot.focusedAppId) router?.navigate(appId);
  }

  let requestedReviewId = $state("");
  function openCreatedReview(reviewId: string): void {
    requestedReviewId = reviewId;
    navigate("review");
  }
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!shell.hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  onMount(() => {
    const previousMotion = document.documentElement.dataset.motion;
    document.documentElement.dataset.motion = preferences.animations;
    const repositionNavDot = () => placeNavDot(false);
    window.addEventListener("resize", repositionNavDot);
    router = createHashRouter(handleRoute);
    router.start();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      destroyed = true;
      if (picker) finishPicker(picker, null);
      window.removeEventListener("resize", repositionNavDot);
      router?.stop();
      router = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (previousMotion === undefined) delete document.documentElement.dataset.motion;
      else document.documentElement.dataset.motion = previousMotion;
    };
  });
</script>

<div use:localizeUi class="workbench" data-desktop data-workbench data-scene={preferences.wallpaperColor} data-sidebar-collapsed={sidebarCollapsed ? "true" : undefined} bind:this={desktop}>
  <Wallpaper scene={preferences.wallpaperColor} />
  <button type="button" class="skip-link" data-skip-link inert={aboutOpen || !!picker} onclick={() => void focusPage(snapshot.focusedAppId)}>跳到当前应用</button>

  <aside class="workbench-sidebar" inert={aboutOpen || !!picker} bind:this={sidebarEl} {@attach selectionTrack}>
    <div class="workbench-brand-row">
      <strong class="workbench-brand">LDOS</strong>
      <button
        type="button"
        class="workbench-sidebar-toggle"
        aria-expanded={sidebarCollapsed ? "false" : "true"}
        aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        onclick={() => { sidebarCollapsed = !sidebarCollapsed; }}
      >
        <Icon name={sidebarCollapsed ? "chevron-right" : "chevron-left"} size={16} />
      </button>
    </div>
    <nav class="workbench-nav" aria-label="主导航">
      {#each primaryPages as item}
        <button type="button" data-nav-app={item.id} title={sidebarCollapsed ? item.label : undefined} aria-current={snapshot.focusedAppId === item.id ? "page" : undefined} onclick={() => navigate(item.id)}>
          <Icon name={getApplicationDefinition(item.id).icon} size={20} /><span>{item.label}</span>
        </button>
      {/each}
    </nav>
    <span class="workbench-nav-dot" data-nav-dot aria-hidden="true" bind:this={navDot}></span>
    <div class="workbench-sidebar-bottom">
      <button type="button" class="workbench-settings" data-nav-settings title={sidebarCollapsed ? "设置" : undefined} aria-current={inSettings ? "true" : undefined} onclick={() => navigate(lastSettingsPage)}>
        <Icon name="sliders" size={20} /><span>设置</span>
      </button>
      <div class="workbench-utilities">
        <button type="button" data-language-toggle aria-label={$language === "zh" ? "切换到英文" : "Switch to Chinese"} onclick={() => toggleLanguage($language)}>{$language === "zh" ? "EN" : "ZH"}</button>
        <button type="button" data-about-trigger aria-label="关于 LDOS" onclick={() => { aboutOpen = true; }}>关于</button>
      </div>
    </div>
  </aside>

  <main class="workbench-main" inert={aboutOpen}>
    {#if inSettings && !picker}
      <nav class="workbench-settings-nav" aria-label="设置导航" {@attach selectionTrack}>
        {#each settingsPages as item}
          <button type="button" data-nav-app={item.id} aria-current={snapshot.focusedAppId === item.id ? "page" : undefined} onclick={() => navigate(item.id)}>{item.label}</button>
        {/each}
      </nav>
    {/if}
    <div class="workbench-workspace" data-workspace>
      {#each snapshot.openedAppIds as appId (appId)}
        <section class="workbench-page" data-app-page data-app-id={appId} hidden={!!picker || snapshot.focusedAppId !== appId} inert={!!picker || snapshot.focusedAppId !== appId} tabindex="-1" aria-label={getApplicationDefinition(appId).title}>
          {#if appId === "crawl"}
            <Crawl {api} {persistence} onNavigate={navigate} />
          {:else if appId === "tasks"}
            <Tasks {api} {polling} {persistence} onNavigate={navigate} />
          {:else if appId === "gallery"}
            <Gallery {api} onPickAssets={pickAssets} suspended={!!picker} active={!picker && snapshot.focusedAppId === "gallery"} onReviewCreated={openCreatedReview} onManagePresets={() => navigate("filter-presets")} />
          {:else if appId === "review"}
            <Review {api} {polling} active={!picker && snapshot.focusedAppId === "review"} reviewId={requestedReviewId} onNavigate={navigate} registerUnsavedChanges={(reader, discard, prepare) => shell.registerUnsavedChanges("review", reader, discard, prepare)} />
          {:else if appId === "tagger"}
            <Tagger {api} {polling} onPickAssets={pickAssets} active={!picker && snapshot.focusedAppId === "tagger"} />
          {:else if appId === "proxy"}
            <Proxy {api} {polling} />
          {:else if appId === "vault"}
            <Vault {api} {polling} registerUnsavedChanges={(reader, discard) => shell.registerUnsavedChanges("vault", reader, discard)} />
          {:else if appId === "policy"}
            <Policy {api} registerUnsavedChanges={(reader, discard) => shell.registerUnsavedChanges("policy", reader, discard)} />
          {:else if appId === "diagnostics"}
            <Diagnostics {api} {polling} onNavigate={navigate} />
          {:else if appId === "personalization"}
            <Personalization {persistence} registerUnsavedChanges={(reader, discard) => shell.registerUnsavedChanges("personalization", reader, discard)} />
          {:else if appId === "filter-presets"}
            <FilterPresets {api} onPickAssets={pickAssets} active={!picker && snapshot.focusedAppId === "filter-presets"} registerUnsavedChanges={(reader, discard) => shell.registerUnsavedChanges("filter-presets", reader, discard)} />
          {/if}
        </section>
      {/each}
      {#if picker}
        {@const session = picker}
        <section class="workbench-page" data-gallery-picker aria-label={session.directoryIds ? "图库图片与目录选取" : "角色参考图选取"}>
          <Gallery {api} picker={{ origin: session.origin, assetIds: session.assetIds, directoryIds: session.directoryIds, onFinish: (ids) => finishPicker(session, ids) }} />
        </section>
      {/if}
    </div>
  </main>
  <About open={aboutOpen} onClose={() => { aboutOpen = false; }} />
</div>
