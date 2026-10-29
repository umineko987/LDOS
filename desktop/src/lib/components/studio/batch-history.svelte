<script lang="ts">
  import Undo2Icon from "@lucide/svelte/icons/undo-2";

  import type { CaptionBatchSummary } from "#lib/api/queries/captions.ts";
  import { formatAgo, formatTimestamp } from "#lib/domain/elapsed.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // caption 批次历史（最近的在上）：打标写入、批量操作、单张编辑各是一个批次；还能撤销的带撤销按钮。
  let {
    batches,
    onundo,
  }: {
    batches: readonly CaptionBatchSummary[] | undefined;
    onundo: (batchId: string) => Promise<unknown>;
  } = $props();

  const ROWS = 8;
  let pending = $state<string | null>(null);

  const KIND_LABEL: Record<CaptionBatchSummary["kind"], () => string> = {
    from_tagger: m.studio_batch_from_tagger,
    ops: m.studio_batch_ops,
    edit: m.studio_batch_edit,
  };

  const rows = $derived((batches ?? []).slice(0, ROWS));
  const now = $derived.by(() => {
    void batches;
    return Date.now() / 1000;
  });

  async function undo(batchId: string) {
    pending = batchId;
    try {
      await onundo(batchId);
    } finally {
      pending = null;
    }
  }
</script>

<section class="flex max-h-[40%] flex-none flex-col gap-1 border-t border-line px-4 py-2.5" data-testid="studio-history">
  <h3 class="text-2xs font-medium text-fg3">{m.studio_history()}</h3>
  {#if rows.length === 0}
    <p class="text-2xs text-fg3">{m.studio_history_empty()}</p>
  {:else}
    <ul class="flex min-h-0 flex-col overflow-y-auto">
      {#each rows as batch (batch.batch_id)}
        {@const undone = batch.undone_at !== null}
        <li class="flex h-7 items-center gap-2 text-xs" data-batch={batch.batch_id} data-kind={batch.kind} data-undone={undone}>
          <span class={cn("min-w-0 flex-1 truncate", undone ? "text-fg3 line-through" : "text-fg2")}>
            {KIND_LABEL[batch.kind]()}
            <span class="text-fg3 tabular-nums">· {m.studio_history_changed({ count: batch.changed_count })}</span>
          </span>
          <span class="text-2xs text-fg3" title={formatTimestamp(batch.created_at, i18n.current)}>
            {formatAgo(now - batch.created_at, i18n.current, m.jobs_just_now())}
          </span>
          {#if undone}
            <span class="text-2xs text-fg3">{m.studio_history_undone()}</span>
          {:else if batch.can_undo}
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded-sm text-fg3 hover:bg-bg3 hover:text-fg disabled:opacity-40"
              aria-label={m.studio_history_undo({ kind: KIND_LABEL[batch.kind]() })}
              title={m.captions_undo()}
              disabled={pending !== null}
              data-action="undo"
              onclick={() => void undo(batch.batch_id)}
            >
              <Undo2Icon class="size-3" />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
