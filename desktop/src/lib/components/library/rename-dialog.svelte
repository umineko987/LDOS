<script lang="ts">
  import { untrack } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { LibraryAsset } from "#lib/api/queries/library.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { stemOf, stemProblem, type StemProblem } from "#lib/domain/library.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 改文件名：只改主名，扩展名不变；同名 TXT 由后端一起改。
  let {
    open = $bindable(false),
    asset,
    onsubmit,
  }: { open?: boolean; asset: LibraryAsset | null; onsubmit: (asset: LibraryAsset, stem: string) => Promise<void> } = $props();

  let stem = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  const extension = $derived(asset?.extension ?? "");
  const current = $derived(asset ? stemOf(asset.name, extension) : "");
  const problem = $derived(asset ? stemProblem(stem, current, extension) : "empty");

  const PROBLEMS: Record<Exclude<StemProblem, "empty" | "unchanged">, () => string> = {
    invalid: m.library_rename_invalid,
    extension: m.library_rename_extension,
    too_long: m.library_rename_too_long,
  };
  const hint = $derived(problem && problem !== "empty" && problem !== "unchanged" ? PROBLEMS[problem]() : null);

  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      stem = current;
      error = null;
    });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!asset || problem || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit(asset, stem.trim());
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "library-rename" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    data-testid="library-rename-dialog"
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      input?.focus();
      input?.select();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>{m.library_rename_title()}</Dialog.Title>
      <Dialog.Description>{m.library_rename_hint()}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-1.5" id="library-rename-form" onsubmit={submit}>
      <Label for="library-rename">{m.library_rename_label()}</Label>
      <div class="flex items-center gap-1.5">
        <Input id="library-rename" bind:ref={input} bind:value={stem} autocomplete="off" spellcheck="false" class="flex-1" />
        {#if extension}<span class="flex-none font-mono text-xs text-fg3">{extension}</span>{/if}
      </div>
      {#if hint}<p class="text-xs text-warn">{hint}</p>{/if}
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    </form>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" type="submit" form="library-rename-form" disabled={problem !== null || submitting}>
        {m.library_rename_submit()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
