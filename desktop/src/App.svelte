<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError, createApiClient } from "./core/api/client";
  import { createPlatformAdapter } from "./core/platform/adapter";
  import { sanitizeHealthSnapshot, type BackendStatus } from "./core/runtime/sanitize";

  type BootstrapPhase = "starting" | "ready" | "failed";

  const platform = createPlatformAdapter();
  let phase = $state<BootstrapPhase>("starting");
  let message = $state("正在启动本地服务");
  let backendVersion = $state<string | null>(null);

  onMount(() => {
    let active = true;
    let connecting = false;
    let connected = false;
    let controller: AbortController | null = null;

    const connect = async (status: BackendStatus) => {
      if (!active) return;
      if (status.state === "starting") {
        phase = "starting";
        message = status.message;
        return;
      }
      if (status.state !== "ready") {
        phase = "failed";
        message = status.message;
        connected = false;
        controller?.abort();
        return;
      }
      if (connected || connecting) return;

      connecting = true;
      controller = new AbortController();
      try {
        const runtime = await platform.getRuntimeMetadata();
        const health = sanitizeHealthSnapshot(
          await createApiClient(runtime).get("/healthz", { signal: controller.signal }),
        );
        if (!active) return;
        if (!health.ok) {
          phase = "failed";
          message = "本地服务健康检查失败";
          return;
        }
        backendVersion = runtime.backendVersion;
        connected = true;
        phase = "ready";
        message = "本地服务已就绪";
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        phase = "failed";
        message = error instanceof ApiError ? error.message : "无法读取本地服务状态";
      } finally {
        connecting = false;
      }
    };

    const stopWatching = platform.watchBackendStatus((status) => { void connect(status); });
    return () => {
      active = false;
      controller?.abort();
      stopWatching();
    };
  });
</script>

<svelte:head>
  <meta name="theme-color" content="#090d16" />
</svelte:head>

<main class="bootstrap-desktop" data-product-contract="nocturne-glass-desktop">
  <div class="bootstrap-menu" aria-hidden="true">ImageWeave</div>
  <section class="bootstrap-window" aria-labelledby="bootstrap-title" aria-live="polite">
    <span class="bootstrap-kicker">TAURI · SVELTE</span>
    <h1 id="bootstrap-title">ImageWeave</h1>
    <p class="bootstrap-status" data-phase={phase}>{message}</p>
    {#if backendVersion}
      <small>Backend {backendVersion}</small>
    {/if}
  </section>
  <div class="bootstrap-dock" aria-hidden="true"></div>
</main>
