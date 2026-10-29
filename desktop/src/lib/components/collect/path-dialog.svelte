<script lang="ts">
  import { untrack } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 浏览器模式没有系统目录选择器：手动输入文件夹的绝对路径。
  let { open = $bindable(false), onsubmit }: { open?: boolean; onsubmit: (path: string) => Promise<void> } = $props();

  let path = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);
  const trimmed = $derived(path.trim());

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      path = "";
      error = null;
    });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!trimmed || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit(trimmed);
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "collect-path" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="collect-path-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.collect_path_title()}</Dialog.Title>
      <Dialog.Description>{m.collect_path_hint()}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-1.5" id="collect-path-form" onsubmit={submit}>
      <Label for="collect-path">{m.collect_path_label()}</Label>
      <Input
        id="collect-path"
        bind:value={path}
        autocomplete="off"
        spellcheck="false"
        class="font-mono"
        placeholder={m.collect_path_placeholder()}
      />
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    </form>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" type="submit" form="collect-path-form" disabled={!trimmed || submitting}>
        {m.collect_path_submit()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
