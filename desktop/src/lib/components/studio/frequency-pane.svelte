<script lang="ts">
  import BanIcon from "@lucide/svelte/icons/ban";
  import XIcon from "@lucide/svelte/icons/x";

  import { TAG_CATEGORY_LABEL, TAG_TEXT_CLASS } from "#lib/components/captions/tag-colors.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { parseTagInput, type FrequencyTable, type TagCategory, type TagCount } from "#lib/domain/captions.ts";
  import { queryTagState, type ParsedQuery } from "#lib/domain/tag-query.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 左栏：当前结果里的标签频率，按类别分组、用类别颜色；触发词单独钉在最前（金色描边）。
  // 点一个标签把它加进查询（再点去掉），Alt/Shift+点击加成排除项。⊘ 把标签放进黑名单：
  // 黑名单存在数据集设置里，导出时去掉这些标签；这里划线显示。
  let {
    table,
    query,
    blacklist,
    ontoggle,
    onblacklist,
  }: {
    table: FrequencyTable;
    query: ParsedQuery;
    blacklist: readonly string[];
    ontoggle: (tag: string, negate: boolean) => void;
    onblacklist: (tag: string) => void;
  } = $props();

  const GROUP_ROWS = 40;
  let expanded = $state<ReadonlySet<TagCategory>>(new Set());
  let adding = $state("");

  const banned = $derived(new Set(blacklist));

  function expand(category: TagCategory) {
    expanded = new Set([...expanded, category]);
  }

  function addBlacklist(event: SubmitEvent) {
    event.preventDefault();
    for (const tag of parseTagInput(adding)) if (!banned.has(tag)) onblacklist(tag);
    adding = "";
  }
</script>

{#snippet row(entry: TagCount, tone: string, trigger = false)}
  {@const state = queryTagState(query, entry.tag)}
  {@const isBanned = banned.has(entry.tag)}
  <li
    class={cn(
      "group/row flex h-6 items-center gap-1 rounded-sm pr-1 pl-2 text-xs",
      trigger && "border border-gold",
      state === "include" && "bg-bg3",
      state === "exclude" && "bg-danger-12",
    )}
    data-tag={entry.tag}
    data-count={entry.count}
    data-state={state ?? undefined}
  >
    <button
      type="button"
      class={cn("min-w-0 flex-1 truncate text-left", tone, isBanned && "text-fg3 line-through")}
      title={m.studio_freq_toggle()}
      onclick={(event) => ontoggle(entry.tag, event.altKey || event.shiftKey)}
    >
      {#if state === "exclude"}−{/if}{entry.tag}
    </button>
    <span class="font-mono text-2xs text-fg3 tabular-nums">{entry.count}</span>
    {#if !trigger}
      <button
        type="button"
        class={cn(
          "flex size-5 items-center justify-center rounded-sm text-fg3 opacity-0 group-hover/row:opacity-100 hover:text-fg focus-visible:opacity-100",
          isBanned && "text-danger opacity-100",
        )}
        aria-label={isBanned ? m.studio_blacklist_remove({ tag: entry.tag }) : m.studio_blacklist_add({ tag: entry.tag })}
        aria-pressed={isBanned}
        onclick={() => onblacklist(entry.tag)}
      >
        <BanIcon class="size-3" />
      </button>
    {/if}
  </li>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="studio-frequency">
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
    <p class="px-2 text-2xs text-fg3">{m.studio_freq_total({ count: table.total })}</p>
    {#if table.trigger}
      <ul data-testid="studio-trigger">{@render row(table.trigger, "text-tag-character", true)}</ul>
    {/if}
    {#each table.groups as group (group.category)}
      {@const open = expanded.has(group.category)}
      <section class="flex flex-col gap-0.5" data-category={group.category}>
        <h3 class={cn("flex items-baseline gap-2 px-2 text-2xs font-medium", TAG_TEXT_CLASS[group.category])}>
          {TAG_CATEGORY_LABEL[group.category]()}
          <span class="font-normal text-fg3">{group.rows.length}</span>
        </h3>
        <ul class="flex flex-col">
          {#each open ? group.rows : group.rows.slice(0, GROUP_ROWS) as entry (entry.tag)}
            {@render row(entry, TAG_TEXT_CLASS[group.category])}
          {/each}
        </ul>
        {#if !open && group.rows.length > GROUP_ROWS}
          <button type="button" class="self-start px-2 text-2xs text-fg3 hover:text-fg" onclick={() => expand(group.category)}>
            {m.studio_freq_more({ count: group.rows.length - GROUP_ROWS })}
          </button>
        {/if}
      </section>
    {:else}
      <p class="px-2 text-xs text-fg3">{m.studio_freq_empty()}</p>
    {/each}
  </div>

  <section class="flex flex-none flex-col gap-1.5 border-t border-line px-3 py-2.5" data-testid="studio-blacklist">
    <h3 class="px-2 text-2xs font-medium text-fg3">{m.studio_blacklist()}</h3>
    {#if blacklist.length}
      <ul class="flex flex-wrap gap-1 px-1">
        {#each blacklist as tag (tag)}
          <li class="flex h-5 items-center gap-0.5 rounded-sm border border-line2 pr-0.5 pl-1.5 font-mono text-2xs text-fg2">
            {tag}
            <button
              type="button"
              class="flex size-4 items-center justify-center text-fg3 hover:text-fg"
              aria-label={m.studio_blacklist_remove({ tag })}
              onclick={() => onblacklist(tag)}
            >
              <XIcon class="size-3" />
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="px-2 text-2xs text-fg3">{m.studio_blacklist_empty()}</p>
    {/if}
    <form class="px-1" onsubmit={addBlacklist}>
      <Input
        bind:value={adding}
        class="h-6 text-xs"
        placeholder={m.studio_blacklist_placeholder()}
        aria-label={m.studio_blacklist_placeholder()}
      />
    </form>
  </section>
</div>
