<script lang="ts">
  import { bootMessage, bootTitle } from "#lib/boot/messages.ts";
  import type { BootSnapshot } from "#lib/boot/gate.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  let { snapshot, onretry }: { snapshot: BootSnapshot; onretry: () => void } = $props();

  const failed = $derived(snapshot.phase === "failed");
</script>

<main
  class="grid h-screen place-items-center bg-bg0"
  data-testid="boot-screen"
  data-boot-phase={snapshot.phase}
  aria-labelledby="boot-title"
>
  <div class="flex w-[340px] flex-col items-start gap-2">
    <span class="text-2xs tracking-[0.08em] text-fg3">{m.app_name()}</span>
    <h1 id="boot-title" class="text-lg font-semibold">{bootTitle(snapshot)}</h1>
    <p class="text-sm text-fg2" role="status" aria-live="polite">{bootMessage(snapshot)}</p>
    {#if failed}
      <div class="mt-2 flex items-center gap-3">
        <Button variant="outline" size="sm" onclick={onretry}>{m.common_retry()}</Button>
        <span class="text-2xs text-fg3">{m.boot_retrying()}</span>
      </div>
    {:else}
      <div class="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-bg2" aria-hidden="true">
        <div class="boot-progress h-full w-1/3 rounded-full bg-fg3"></div>
      </div>
    {/if}
    {#if snapshot.backendVersion}
      <small class="text-2xs text-fg3">{m.boot_backend_version({ version: snapshot.backendVersion })}</small>
    {/if}
  </div>
</main>
