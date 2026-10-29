<script lang="ts">
  import { untrack } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 手动输入文件夹路径：浏览器模式下导入新来源（可以顺带起名），或给离线来源重新关联根目录。
  let {
    open = $bindable(false),
    mode,
    sourceName = "",
    onsubmit,
  }: {
    open?: boolean;
    mode: "import" | "relink";
    /** relink 时显示在标题里。 */
    sourceName?: string;
    onsubmit: (path: string, displayName: string | null) => Promise<void>;
  } = $props();

  let path = $state("");
  let name = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);
  const trimmed = $derived(path.trim());

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      path = "";
      name = "";
      error = null;
    });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!trimmed || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit(trimmed, mode === "import" ? name.trim() || null : null);
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "library-path" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="library-path-dialog">
    <Dialog.Header>
      <Dialog.Title>{mode === "import" ? m.library_import_title() : m.library_relink_title({ name: sourceName })}</Dialog.Title>
      <Dialog.Description>{mode === "import" ? m.library_import_hint() : m.library_relink_hint()}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" id="library-path-form" onsubmit={submit}>
      <div class="flex flex-col gap-1.5">
        <Label for="library-path">{m.library_path_label()}</Label>
        <Input
          id="library-path"
          bind:value={path}
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
          placeholder={m.library_path_placeholder()}
        />
      </div>
      {#if mode === "import"}
        <div class="flex flex-col gap-1.5">
          <Label for="library-name">{m.library_import_name()}</Label>
          <Input id="library-name" bind:value={name} autocomplete="off" placeholder={m.library_import_name_placeholder()} />
        </div>
      {/if}
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    </form>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" type="submit" form="library-path-form" disabled={!trimmed || submitting}>
        {mode === "import" ? m.library_import_submit() : m.library_relink_submit()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
