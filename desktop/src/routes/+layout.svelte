<script lang="ts">
  import "../app.css";

  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { onMount } from "svelte";

  import { createQueryClient } from "#lib/api/query-client.ts";
  import { INITIAL_BOOT, startBootGate, type BootGate, type BootSnapshot } from "#lib/boot/gate.ts";
  import SettingsCommands from "#lib/components/settings/settings-commands.svelte";
  import BootScreen from "#lib/components/shell/boot-screen.svelte";
  import Shell from "#lib/components/shell/shell.svelte";
  import { i18n, syncDocumentLang } from "#lib/i18n/locale.svelte.ts";
  import { setKeymap } from "#lib/keys/context.ts";
  import { createKeymap } from "#lib/keys/keymap.ts";
  import { createPlatformAdapter } from "#lib/platform/adapter.ts";
  import { setPlatform } from "#lib/platform/context.ts";
  import { prefs } from "#lib/prefs/prefs.svelte.ts";

  // 根布局：启动门 → QueryClient → 外壳。语言切换时整棵树按 {#key} 重建，文案随之刷新。
  let { children } = $props();

  syncDocumentLang(i18n.current);
  prefs.sync();

  const platform = setPlatform(createPlatformAdapter());
  const keymap = setKeymap(createKeymap());
  const queryClient = createQueryClient();

  let boot = $state<BootSnapshot>(INITIAL_BOOT);
  let gate: BootGate | null = null;

  onMount(() => {
    gate = startBootGate({ platform, onChange: (next) => (boot = next) });
    return () => gate?.stop();
  });
</script>

<svelte:window onkeydown={(event) => keymap.handle(event)} />

{#key i18n.current}
  <div data-app-ready class="contents">
    {#if boot.phase === "ready" && boot.api}
      <QueryClientProvider client={queryClient}>
        {#key boot.api}
          <Shell api={boot.api}><SettingsCommands />{@render children()}</Shell>
        {/key}
      </QueryClientProvider>
    {:else}
      <BootScreen snapshot={boot} onretry={() => gate?.retry()} />
    {/if}
  </div>
{/key}
