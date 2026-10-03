<script lang="ts">
  import { onMount, tick } from "svelte";

  import Crawl from "../apps/crawl/Crawl.svelte";
  import Tasks from "../apps/tasks/Tasks.svelte";
  import Gallery from "../apps/gallery/Gallery.svelte";
  import Review from "../apps/review/Review.svelte";
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

  async function focusPage(appId: ApplicationId | null): Promise<void> {
    await tick();
    if (!appId || shell.getState().focusedAppId !== appId || aboutOpen) return;
    desktop?.querySelector<HTMLElement>(`[data-app-page][data-app-id="${appId}"]`)?.focus({ preventScroll: true });
  }

  function handleRoute(change: RouteChange): void {
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

  function navigate(appId: ApplicationId): void {
    if (appId !== snapshot.focusedAppId) router?.navigate(appId);
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
    router = createHashRouter(handleRoute);
    router.start();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      router?.stop();
      router = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (previousMotion === undefined) delete document.documentElement.dataset.motion;
      else document.documentElement.dataset.motion = previousMotion;
    };
  });
</script>

<div use:localizeUi class="workbench" data-desktop data-workbench data-scene={preferences.wallpaperColor} bind:this={desktop}>
  <Wallpaper scene={preferences.wallpaperColor} />
  <button type="button" class="skip-link" data-skip-link inert={aboutOpen} onclick={() => void focusPage(snapshot.focusedAppId)}>跳到当前应用</button>

  <aside class="workbench-sidebar" inert={aboutOpen}>
    <strong class="workbench-brand">LDOS</strong>
    <nav class="workbench-nav" aria-label="主导航">
      {#each primaryPages as item}
        <button type="button" data-nav-app={item.id} aria-current={snapshot.focusedAppId === item.id ? "page" : undefined} onclick={() => navigate(item.id)}>
          <Icon name={getApplicationDefinition(item.id).icon} size={20} /><span>{item.label}</span>
        </button>
      {/each}
    </nav>
    <div class="workbench-sidebar-bottom">
      <button type="button" class="workbench-settings" data-nav-settings aria-current={inSettings ? "true" : undefined} onclick={() => navigate(lastSettingsPage)}>
        <Icon name="sliders" size={20} /><span>设置</span>
      </button>
      <div class="workbench-utilities">
        <button type="button" data-language-toggle aria-label={$language === "zh" ? "切换到英文" : "Switch to Chinese"} onclick={() => toggleLanguage($language)}>{$language === "zh" ? "EN" : "ZH"}</button>
        <button type="button" data-about-trigger aria-label="关于 LDOS" onclick={() => { aboutOpen = true; }}>关于</button>
      </div>
    </div>
  </aside>

  <main class="workbench-main" inert={aboutOpen}>
    {#if inSettings}
      <nav class="workbench-settings-nav" aria-label="设置导航">
        {#each settingsPages as item}
          <button type="button" data-nav-app={item.id} aria-current={snapshot.focusedAppId === item.id ? "page" : undefined} onclick={() => navigate(item.id)}>{item.label}</button>
        {/each}
      </nav>
    {/if}
    <div class="workbench-workspace" data-workspace>
      {#each snapshot.openedAppIds as appId (appId)}
        <section class="workbench-page" data-app-page data-app-id={appId} hidden={snapshot.focusedAppId !== appId} inert={snapshot.focusedAppId !== appId} tabindex="-1" aria-label={getApplicationDefinition(appId).title}>
          {#if appId === "crawl"}
            <Crawl {api} {persistence} onNavigate={navigate} />
          {:else if appId === "tasks"}
            <Tasks {api} {polling} {persistence} onNavigate={navigate} />
          {:else if appId === "gallery"}
            <Gallery {api} active={snapshot.focusedAppId === "gallery"} onReviewCreated={openCreatedReview} />
          {:else if appId === "review"}
            <Review {api} {polling} {persistence} active={snapshot.focusedAppId === "review"} reviewId={requestedReviewId} onNavigate={navigate} registerUnsavedChanges={(reader, discard, prepare) => shell.registerUnsavedChanges("review", reader, discard, prepare)} />
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
            <FilterPresets {api} active={snapshot.focusedAppId === "filter-presets"} registerUnsavedChanges={(reader, discard) => shell.registerUnsavedChanges("filter-presets", reader, discard)} />
          {/if}
        </section>
      {/each}
    </div>
  </main>
  <About open={aboutOpen} onClose={() => { aboutOpen = false; }} />
</div>
