<script lang="ts">
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { parseTags, type CaptionBatchResult } from "#lib/api/queries/atlas.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 给地图上选中的图加标签：先预览（dry run）看会改多少张，再写入。写入后的撤销由页面的 Toast 提供。

  interface Props {
    open: boolean;
    count: number;
    preview: (tags: string[]) => Promise<CaptionBatchResult>;
    apply: (tags: string[]) => Promise<void>;
  }

  let { open = $bindable(), count, preview, apply }: Props = $props();

  let text = $state("");
  let result = $state.raw<CaptionBatchResult | null>(null);
  let resultFor = $state("");
  let error = $state<string | null>(null);
  let pending = $state(false);

  const tags = $derived(parseTags(text));
  const key = $derived(tags.join("\n"));
  const fresh = $derived(result !== null && resultFor === key);
  const changes = $derived(result ? result.stats.changed + result.stats.new : 0);

  useOverlay(() => open, { id: "atlas-tag" });

  $effect(() => {
    if (!open) return;
    text = "";
    result = null;
    resultFor = "";
    error = null;
  });

  async function run() {
    if (!tags.length || pending) return;
    pending = true;
    error = null;
    try {
      if (fresh) {
        await apply(tags);
        open = false;
      } else {
        const requested = key;
        result = await preview(tags);
        resultFor = requested;
      }
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      pending = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-testid="atlas-tag-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.atlas_tag_title({ count })}</Dialog.Title>
      <Dialog.Description>{m.atlas_tag_help()}</Dialog.Description>
    </Dialog.Header>
    <form
      class="flex flex-col gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <Input bind:value={text} placeholder={m.atlas_tag_placeholder()} aria-label={m.atlas_tag_label()} data-testid="atlas-tag-input" />
      {#if fresh && result}
        <p class="text-xs text-fg2" data-testid="atlas-tag-preview" data-changes={changes}>
          {m.atlas_tag_stats({ changed: changes, unchanged: result.stats.unchanged })}
          {#if result.stats.skipped}<span class="text-fg3"> · {m.atlas_tag_skipped({ count: result.stats.skipped })}</span>{/if}
          {#if result.stats.conflicts}<span class="text-warn"> · {m.atlas_tag_conflicts({ count: result.stats.conflicts })}</span>{/if}
        </p>
      {/if}
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
      <Dialog.Footer>
        <Button variant="ghost" onclick={() => (open = false)}>{m.atlas_cancel()}</Button>
        {#if fresh}
          <Button type="submit" variant="primary" disabled={pending || changes === 0} data-testid="atlas-tag-apply">
            {m.atlas_tag_apply({ count: changes })}
          </Button>
        {:else}
          <Button type="submit" variant="default" disabled={pending || !tags.length} data-testid="atlas-tag-preview-run">
            {m.atlas_tag_preview()}
          </Button>
        {/if}
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
