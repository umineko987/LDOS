<script lang="ts">
  import { onMount } from "svelte";

  import { ApiError, createApiClient, type ApiClient } from "./core/api/client";
  import { localizeUi } from "./shell/localizeUi";
  import { createPersistenceAdapter } from "./core/persistence/adapter";
  import { createPersistenceService } from "./core/persistence/service";
  import { createPlatformAdapter } from "./core/platform/adapter";
  import { createPollingService } from "./core/polling/service";
  import { sanitizeHealthSnapshot, type BackendStatus } from "./core/runtime/sanitize";
  import { createShellPollingLifecycleSource } from "./core/state/projections";
  import { createShellStore } from "./core/state/shell";
  import Desktop from "./shell/Desktop.svelte";

  type BootstrapPhase = "starting" | "ready" | "failed";

  const platform = createPlatformAdapter();
  const persistence = createPersistenceService(createPersistenceAdapter());
  const shell = createShellStore({ persistence });
  const polling = createPollingService({ lifecycleSource: createShellPollingLifecycleSource(shell) });
  let phase = $state<BootstrapPhase>("starting");
  let message = $state("正在启动本地服务");
  let backendVersion = $state<string | null>(null);
  let api = $state<ApiClient | null>(null);

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
        connected = false;
        api = null;
        controller?.abort();
        return;
      }
      if (status.state !== "ready") {
        phase = "failed";
        message = status.message;
        connected = false;
        api = null;
        controller?.abort();
        return;
      }
      if (connected || connecting) return;

      connecting = true;
      controller = new AbortController();
      try {
        const runtime = await platform.getRuntimeMetadata();
        const client = createApiClient(runtime);
        const health = sanitizeHealthSnapshot(
          await client.get("/healthz", { signal: controller.signal }),
        );
        if (!active) return;
        if (!health.ok) {
          phase = "failed";
          message = "本地服务健康检查失败";
          connected = false;
          api = null;
          return;
        }
        backendVersion = runtime.backendVersion;
        api = client;
        connected = true;
        phase = "ready";
        message = "本地服务已就绪";
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        phase = "failed";
        message = error instanceof ApiError ? error.message : "无法读取本地服务状态";
        connected = false;
        api = null;
      } finally {
        connecting = false;
      }
    };

    polling.start({
      key: "platform.backend-status",
      intervalMs: 500,
      critical: true,
      task: () => platform.getBackendStatus(),
      onResult: (status) => { void connect(status); },
    });
    return () => {
      active = false;
      controller?.abort();
      polling.destroy();
      shell.destroy();
    };
  });
</script>

<svelte:head>
  <meta name="theme-color" content="#060a13" />
</svelte:head>

{#if phase === "ready" && api}
  <Desktop {shell} {persistence} {polling} {api} />
{:else}
  <main use:localizeUi class="startup-gate" data-startup-phase={phase} aria-labelledby="startup-title" aria-live="polite">
    <section>
      <p>LDOS</p>
      <h1 id="startup-title">{phase === "failed" ? "本地服务暂时不可用" : "正在准备工作台"}</h1>
      <p class="startup-gate__status">{message}</p>
      {#if backendVersion}<small>Backend {backendVersion}</small>{/if}
    </section>
  </main>
{/if}
