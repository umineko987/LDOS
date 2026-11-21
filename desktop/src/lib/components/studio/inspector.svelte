<script lang="ts">
  import ArrowUpToLineIcon from "@lucide/svelte/icons/arrow-up-to-line";
  import MergeIcon from "@lucide/svelte/icons/merge";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import XIcon from "@lucide/svelte/icons/x";

  import type { CaptionBatchSummary } from "#lib/api/queries/captions.ts";
  import { TAG_TEXT_CLASS } from "#lib/components/captions/tag-colors.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { tagCategory, type CategoryLookup, type SelectionSummary, type SelectionTag } from "#lib/domain/captions.ts";
  import type { OpDraft } from "#lib/domain/studio.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import BatchHistory from "./batch-history.svelte";

  // 右栏：选中图的标签——全部都有的、部分有的（n/总数），每行可以删、置顶、替换、合并到别的标签、补给全部；
  // 顶上的输入框给全部选中的图加标签（T 聚焦）。每个操作都先进对话框看 dry-run 差异再写入。
  // 下面是校对状态和 caption 批次历史（可撤销）。
  let {
    summary,
    scope,
    categoryOf,
    approved,
    batches,
    quickAdd = true,
    locked = false,
    historyLabel,
    addInput = $bindable(null),
    onop,
    onapprove,
    onundo,
  }: {
    summary: SelectionSummary;
    /** 对象是选中的图、当前查询的全部结果，还是校对视图里的当前这张。 */
    scope: "selection" | "results" | "current";
    categoryOf: CategoryLookup | undefined;
    /** 选中的图里已校对的张数。 */
    approved: number;
    batches: readonly CaptionBatchSummary[] | undefined;
    /** 顶上的加标签输入框（逐张校对时由校对视图自己的输入框代替）。 */
    quickAdd?: boolean;
    locked?: boolean;
    historyLabel?: string;
    addInput?: HTMLInputElement | null;
    onop: (draft: Partial<OpDraft>) => void;
    onapprove: (approve: boolean) => void;
    onundo: (batchId: string) => Promise<unknown>;
  } = $props();

  const PARTIAL_ROWS = 60;
  let adding = $state("");
  let showAll = $state(false);

  const partial = $derived(showAll ? summary.partial : summary.partial.slice(0, PARTIAL_ROWS));
  const tone = (tag: string) => TAG_TEXT_CLASS[tagCategory(tag, categoryOf)];

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!adding.trim()) return;
    onop({ kind: "add", tags: adding });
    adding = "";
  }
</script>

{#snippet action(label: string, onclick: () => void, Icon: typeof XIcon, testid: string)}
  <button
    type="button"
    class="flex size-5 items-center justify-center rounded-sm text-fg3 hover:bg-bg3 hover:text-fg"
    aria-label={label}
    title={label}
    data-action={testid}
    disabled={locked}
    {onclick}
  >
    <Icon class="size-3" />
  </button>
{/snippet}

{#snippet tagRow(entry: SelectionTag)}
  <li class="group/row flex h-6 items-center gap-1 pl-1 text-xs" data-tag={entry.tag} data-count={entry.count} data-all={entry.all}>
    <span class={cn("min-w-0 flex-1 truncate", tone(entry.tag))}>{entry.tag}</span>
    <span class="font-mono text-2xs text-fg3 tabular-nums">{entry.count}/{summary.total}</span>
    <span class="flex opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      {#if !entry.all}
        {@render action(m.studio_tag_add_all({ tag: entry.tag }), () => onop({ kind: "add", tags: entry.tag }), PlusIcon, "add")}
      {/if}
      {@render action(m.studio_tag_pin({ tag: entry.tag }), () => onop({ kind: "pin", tags: entry.tag }), ArrowUpToLineIcon, "pin")}
      {@render action(m.studio_tag_replace({ tag: entry.tag }), () => onop({ kind: "replace", from: entry.tag }), PencilIcon, "replace")}
      {@render action(m.studio_tag_merge({ tag: entry.tag }), () => onop({ kind: "merge", tags: entry.tag }), MergeIcon, "merge")}
      {@render action(m.studio_tag_remove({ tag: entry.tag }), () => onop({ kind: "remove", tags: entry.tag }), XIcon, "remove")}
    </span>
  </li>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="studio-inspector">
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
    {#if summary.total === 0}
      <p class="text-xs text-fg3" data-testid="studio-inspector-empty">{m.studio_inspector_empty()}</p>
    {:else}
      <div class="flex items-center gap-2">
        <h3 class="min-w-0 flex-1 text-sm font-medium" data-testid="studio-inspector-title" data-scope={scope} data-count={summary.total}>
          {scope === "selection"
            ? m.studio_inspector_selection({ count: summary.total })
            : scope === "results"
              ? m.studio_inspector_results({ count: summary.total })
              : m.studio_inspector_current()}
        </h3>
        <span class="text-2xs text-fg3">{m.studio_inspector_approved({ count: approved, total: summary.total })}</span>
      </div>
      {#if quickAdd}
        <form onsubmit={submit} class="flex items-center gap-2">
          <Input
            bind:ref={addInput}
            bind:value={adding}
            disabled={locked}
            class="h-7 text-xs"
            placeholder={m.studio_add_placeholder()}
            aria-label={m.studio_add_placeholder()}
            data-testid="studio-add"
            onkeydown={(event) => {
              if (event.key === "Escape" && adding) {
                event.stopPropagation();
                adding = "";
              }
            }}
          />
          <Kbd>T</Kbd>
        </form>
      {/if}

      <section class="flex flex-col gap-0.5" data-testid="studio-tags-all">
        <h4 class="text-2xs font-medium text-fg3">{m.studio_inspector_all({ count: summary.all.length })}</h4>
        <ul class="flex flex-col">
          {#each summary.all as entry (entry.tag)}{@render tagRow(entry)}{/each}
        </ul>
      </section>
      {#if summary.partial.length}
        <section class="flex flex-col gap-0.5" data-testid="studio-tags-partial">
          <h4 class="text-2xs font-medium text-fg3">{m.studio_inspector_partial({ count: summary.partial.length })}</h4>
          <ul class="flex flex-col">
            {#each partial as entry (entry.tag)}{@render tagRow(entry)}{/each}
          </ul>
          {#if summary.partial.length > PARTIAL_ROWS}
            <button type="button" class="self-start text-2xs text-fg3 hover:text-fg" onclick={() => (showAll = !showAll)}>
              {showAll ? m.studio_show_less() : m.studio_show_more({ count: summary.partial.length - PARTIAL_ROWS })}
            </button>
          {/if}
        </section>
      {/if}

      <div class="flex flex-wrap gap-1.5">
        <Button variant="outline" size="sm" disabled={locked} onclick={() => onop({ kind: "replace" })}>{m.studio_op_replace()}…</Button>
        <Button variant="outline" size="sm" disabled={locked} onclick={() => onop({ kind: "merge" })}>{m.studio_op_merge()}…</Button>
        {#if approved < summary.total}
          <Button variant="outline" size="sm" disabled={locked} onclick={() => onapprove(true)} data-testid="studio-approve">
            {m.studio_approve()} <Kbd>A</Kbd>
          </Button>
        {:else}
          <Button variant="ghost" size="sm" disabled={locked} onclick={() => onapprove(false)} data-testid="studio-unapprove">
            {m.studio_unapprove()}
          </Button>
        {/if}
      </div>
    {/if}
  </div>
  <BatchHistory {batches} {onundo} {locked} label={historyLabel} />
</div>
