<script lang="ts" module>
  export interface ConfirmRequest {
    readonly title: string;
    readonly body: string;
    readonly action: string;
    readonly run: () => void;
  }
</script>

<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 删除类操作的确认框。request 不为 null 时打开；确认后先关闭再执行。
  let { request = $bindable(null) }: { request: ConfirmRequest | null } = $props();

  useOverlay(() => request !== null, { id: "network.confirm" });

  function confirm() {
    const current = request;
    request = null;
    current?.run();
  }
</script>

<Dialog.Root
  open={request !== null}
  onOpenChange={(open) => {
    if (!open) request = null;
  }}
>
  <Dialog.Content data-testid="network-confirm" showCloseButton={false}>
    <Dialog.Header>
      <Dialog.Title>{request?.title}</Dialog.Title>
      <Dialog.Description>{request?.body}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (request = null)}>{m.settings_cancel()}</Button>
      <Button variant="destructive" onclick={confirm} data-testid="network-confirm-action">{request?.action}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
