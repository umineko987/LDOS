<script lang="ts">
  import { untrack } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { CaptionBatchResult, CaptionsFromTaggerRequest } from "#lib/api/queries/captions.ts";
  import TagDiff from "#lib/components/captions/tag-diff.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 打标结果写进 caption 之前的确认：打开时先跑一次 dry-run，按后端的真实结果（含 merge 模式要用的
  // 上次打标记录、版本冲突、不可写的 caption）给出统计和样例，再写入。写入后的撤销由页面的 toast 提供。
  interface Props {
    open: boolean;
    request: CaptionsFromTaggerRequest | null;
    /** asset_id → 文件名，样例里显示。 */
    nameOf: (assetId: string) => string;
    preview: (request: CaptionsFromTaggerRequest) => Promise<CaptionBatchResult>;
    apply: (request: CaptionsFromTaggerRequest) => Promise<void>;
  }

  let { open = $bindable(), request, nameOf, preview, apply }: Props = $props();

  let result = $state.raw<CaptionBatchResult | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let applying = $state(false);
  let token = 0;

  const changes = $derived(result ? result.stats.changed + result.stats.new : 0);

  useOverlay(() => open, { id: "tag-write" });

  async function load(body: CaptionsFromTaggerRequest) {
    const current = ++token;
    loading = true;
    error = null;
    result = null;
    try {
      const next = await preview(body);
      if (current === token) result = next;
    } catch (failure) {
      if (current === token) error = apiErrorMessage(failure);
    } finally {
      if (current === token) loading = false;
    }
  }

  $effect(() => {
    if (!open || !request) return;
    const body = request;
    untrack(() => void load(body));
  });

  async function confirm() {
    if (!request || !result || applying || changes === 0) return;
    applying = true;
    error = null;
    try {
      await apply(request);
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      applying = false;
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[560px]" data-testid="tag-write-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.tag_write_title()}</Dialog.Title>
      <Dialog.Description>{m.tag_write_hint()}</Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <p class="text-xs text-fg3" role="status">{m.tag_write_loading()}</p>
    {:else if result}
      {@const stats = result.stats}
      <p class="text-sm text-fg" data-testid="tag-write-stats" data-changes={changes}>
        {m.tag_write_stats({ changed: changes, total: stats.total })}
      </p>
      <p class="flex flex-wrap gap-x-3 text-2xs text-fg3">
        {#if stats.new}<span>{m.tag_write_new({ count: stats.new })}</span>{/if}
        <span>{m.tag_write_unchanged({ count: stats.unchanged })}</span>
        {#if stats.skipped}<span>{m.tag_write_skipped({ count: stats.skipped })}</span>{/if}
        {#if stats.conflicts}<span class="text-warn">{m.tag_write_conflicts({ count: stats.conflicts })}</span>{/if}
      </p>
      {#if result.samples.length}
        <ul class="flex max-h-[280px] flex-col overflow-y-auto border-y border-line" data-testid="tag-write-samples">
          {#each result.samples as sample (sample.asset_id)}
            <li class="flex flex-col gap-0.5 border-b border-line py-1.5 last:border-b-0">
              <span class="truncate text-xs text-fg2">{nameOf(sample.asset_id)}</span>
              <TagDiff added={sample.added} removed={sample.removed} />
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}

    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (open = false)}>{m.common_cancel()}</Button>
      <Button variant="primary" disabled={!result || changes === 0 || applying} onclick={confirm} data-testid="tag-write-apply">
        {changes ? m.tag_write_apply({ count: changes }) : m.tag_write_nothing()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
