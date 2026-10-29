<script lang="ts">
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";

  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { ModelInstaller } from "./installer.svelte.ts";

  // 受限模型的许可确认。installer.license 不为 null 时打开；同意后带 accept_license 重新安装。
  let { installer }: { installer: ModelInstaller } = $props();

  const request = $derived(installer.license);
  useOverlay(() => request !== null, { id: "models.license" });
</script>

<Dialog.Root
  open={request !== null}
  onOpenChange={(open) => {
    if (!open) installer.dismissLicense();
  }}
>
  <Dialog.Content data-testid="model-license-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.models_license_title()}</Dialog.Title>
      <Dialog.Description>{m.models_license_body()}</Dialog.Description>
    </Dialog.Header>
    <ul class="flex flex-col border-t border-line">
      {#each request?.items ?? [] as item (item.key)}
        <li class="flex min-h-row items-center gap-3 border-b border-line py-1.5" data-license-model={item.key}>
          <span class="min-w-0 flex-1 truncate text-sm text-fg">{item.display_name}</span>
          <span class="text-xs text-fg2">{item.license ?? m.models_license_unknown()}</span>
          <a
            href={item.source_url}
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-xs text-fg2 underline-offset-4 hover:text-fg hover:underline"
          >
            {m.models_license_view()}
            <ExternalLinkIcon class="size-3" />
          </a>
        </li>
      {/each}
    </ul>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => installer.dismissLicense()}>{m.settings_cancel()}</Button>
      <Button variant="primary" onclick={() => installer.acceptLicense()} data-testid="model-license-accept">
        {m.models_license_accept()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
