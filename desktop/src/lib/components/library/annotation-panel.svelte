<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { ApiError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { libraryAnnotationQuery, libraryKeys, saveAnnotation, type LibraryAnnotation } from "#lib/api/queries/library.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 查看器右侧的同名 TXT：读出来可以直接改，Ctrl+Enter 或「保存」写回（带版本检查，别处改过时提示并重读）。
  let { assetId }: { assetId: string } = $props();

  const api = useApi();
  const client = useQueryClient();

  const annotation = createQuery(() => libraryAnnotationQuery(api, assetId));
  let draft = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  type TxtState = LibraryAnnotation["txt_state"];
  const READ_ONLY: ReadonlySet<TxtState> = new Set(["invalid_encoding", "pair_conflict", "io_error"]);
  const STATES: Partial<Record<TxtState, () => string>> = {
    missing: m.library_txt_missing,
    blank: m.library_txt_blank,
    invalid_encoding: m.library_txt_invalid_encoding,
    pair_conflict: m.library_txt_pair_conflict,
    io_error: m.library_txt_io_error,
  };

  const base = $derived(annotation.data);
  const readOnly = $derived(base ? READ_ONLY.has(base.txt_state) : true);
  const dirty = $derived(base !== undefined && draft !== (base.content ?? ""));

  // 内容变了（换图、保存后、重读）才覆盖草稿；结构共享让内容相同的重读保持同一个对象。
  $effect.pre(() => {
    const value = base;
    untrack(() => {
      draft = value?.content ?? "";
      error = null;
    });
  });

  async function save() {
    if (!base || !dirty || readOnly || saving) return;
    saving = true;
    error = null;
    try {
      const next = await saveAnnotation(api, assetId, {
        content: draft,
        expected_disk_version: base.disk_version,
        expected_txt_version: base.txt_version,
      });
      client.setQueryData(libraryKeys.annotation(assetId), next);
      toast.success(m.library_txt_saved());
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        error = m.library_txt_conflict();
        void annotation.refetch();
      } else {
        error = apiErrorMessage(failure);
      }
    } finally {
      saving = false;
    }
  }
</script>

<section class="flex flex-col gap-2 p-4" data-testid="library-annotation" aria-labelledby="library-annotation-title">
  <h2 id="library-annotation-title" class="text-xs font-medium text-fg2">{m.library_txt_title()}</h2>
  {#if annotation.isPending}
    <p class="text-xs text-fg3" role="status">{m.library_loading()}</p>
  {:else if annotation.isError}
    <p class="text-xs text-danger" role="alert">{apiErrorMessage(annotation.error)}</p>
  {:else if base}
    {#if STATES[base.txt_state]}<p class="text-2xs text-fg3" data-txt-state={base.txt_state}>{STATES[base.txt_state]!()}</p>{/if}
    <Textarea
      bind:value={draft}
      class="min-h-40 font-mono text-xs"
      aria-label={m.library_txt_title()}
      disabled={readOnly}
      spellcheck="false"
      onkeydown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void save();
        }
      }}
    />
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={save} disabled={!dirty || readOnly || saving} data-testid="library-annotation-save">
        {m.library_txt_save()} <Kbd>Ctrl+↵</Kbd>
      </Button>
      {#if dirty}
        <Button variant="ghost" size="sm" onclick={() => (draft = base.content ?? "")}>{m.library_txt_revert()}</Button>
      {/if}
    </div>
  {/if}
</section>
