<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import XIcon from "@lucide/svelte/icons/x";

  import { TAG_TEXT_CLASS } from "#lib/components/captions/tag-colors.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { dedupe, parseTagInput, tagCategory, type CategoryLookup } from "#lib/domain/captions.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 逐张校对：大图 + 这张图的标签。× 删一个标签、T 聚焦输入框加标签，改动立即写回（单张编辑，带版本号）。
  // Enter 记为已校对并跳到下一张，←/→ 翻页，Z 撤销上一步——按键由页面注册，这里只画界面。
  let {
    item,
    position,
    total,
    approved,
    triggerWord,
    categoryOf,
    src,
    saving,
    addInput = $bindable(null),
    onedit,
    onapprove,
    ontrash,
    onstep,
  }: {
    item: { readonly asset_id: string; readonly name: string; readonly tags: readonly string[]; readonly text: string };
    /** 当前是结果里的第几张（从 0 开始）。 */
    position: number;
    total: number;
    approved: boolean;
    triggerWord: string;
    categoryOf: CategoryLookup | undefined;
    src: string;
    saving: boolean;
    addInput?: HTMLInputElement | null;
    onedit: (tags: string[]) => Promise<boolean> | void;
    onapprove: () => void;
    ontrash?: () => void;
    onstep: (delta: number) => void;
  } = $props();

  let adding = $state("");
  let failedSrc = $state<string | null>(null);

  const trigger = $derived(triggerWord.trim());

  function remove(tag: string) {
    void onedit(item.tags.filter((current) => current !== tag));
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    const tags = parseTagInput(adding);
    // 空着回车：离开输入框，接着用 Enter 校对。
    if (tags.length === 0) {
      addInput?.blur();
      return;
    }
    const next = dedupe([...item.tags, ...tags]);
    if (next.length === item.tags.length || (await onedit(next)) !== false) adding = "";
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="studio-triage" data-asset={item.asset_id} data-approved={approved}>
  <div class="relative flex min-h-0 flex-1 items-center justify-center bg-bg0 p-4">
    {#if failedSrc === src}
      <div class="flex flex-col items-center gap-2 text-fg3" role="img" aria-label={item.name}>
        <ImageOffIcon class="size-6" />
      </div>
    {:else}
      <img crossorigin="anonymous" {src} alt={item.name} class="max-h-full max-w-full object-contain" draggable="false" onerror={(event) => (failedSrc = event.currentTarget.getAttribute("src"))} />
    {/if}
    {#if approved}
      <span class="absolute top-3 right-3 flex items-center gap-1 rounded-sm bg-bg0/80 px-1.5 py-0.5 text-2xs text-ok" data-testid="studio-triage-approved">
        <CircleCheckIcon class="size-3" />{m.studio_approved()}
      </span>
    {/if}
  </div>

  <div class="flex flex-none flex-col gap-2.5 border-t border-line px-5 py-3">
    <div class="flex items-center gap-2 text-xs">
      <span class="min-w-0 flex-1 truncate text-fg2" title={item.name}>{item.name}</span>
      <span class="font-mono text-2xs text-fg3 tabular-nums" data-testid="studio-triage-position">{position + 1} / {total}</span>
    </div>

    <ul class="flex flex-wrap gap-1" data-testid="studio-triage-tags" aria-busy={saving}>
      {#each item.tags as tag (tag)}
        <li
          class={cn(
            "flex h-6 items-center gap-0.5 rounded-sm border pr-0.5 pl-2 text-xs",
            tag === trigger ? "border-gold" : "border-line2",
            TAG_TEXT_CLASS[tagCategory(tag, categoryOf)],
          )}
          data-tag={tag}
        >
          {tag}
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-sm text-fg3 hover:text-fg disabled:opacity-40"
            aria-label={m.studio_tag_remove({ tag })}
            disabled={saving}
            onclick={() => remove(tag)}
          >
            <XIcon class="size-3" />
          </button>
        </li>
      {:else}
        <li class="text-xs text-fg3">{m.studio_triage_no_tags()}</li>
      {/each}
    </ul>

    <form class="flex items-center gap-2" onsubmit={submit}>
      <Input
        bind:ref={addInput}
        bind:value={adding}
        disabled={saving}
        class="h-7 text-xs"
        placeholder={m.studio_triage_add()}
        aria-label={m.studio_triage_add()}
        data-testid="studio-triage-add"
        onkeydown={(event) => {
          if (event.key === "Escape" && adding) {
            event.stopPropagation();
            adding = "";
          }
        }}
      />
      <Kbd>T</Kbd>
    </form>

    <p class="line-clamp-2 font-mono text-2xs break-all text-fg3" data-testid="studio-triage-text">{item.text}</p>

    <div class="flex items-center gap-1.5">
      <Button variant="ghost" size="sm" disabled={saving || position <= 0} onclick={() => onstep(-1)} aria-label={m.studio_triage_prev()}>
        <ChevronLeftIcon />
      </Button>
      <Button variant="ghost" size="sm" disabled={saving || position >= total - 1} onclick={() => onstep(1)} aria-label={m.studio_triage_next()}>
        <ChevronRightIcon />
      </Button>
      <span class="ml-auto"></span>
      {#if ontrash}
        <Button variant="outline" size="sm" disabled={saving} onclick={ontrash} data-testid="studio-gallery-trash">
          <Trash2Icon data-icon="inline-start" />{m.studio_gallery_trash()} <Kbd>Del</Kbd>
        </Button>
      {/if}
      <Button variant="primary" size="sm" disabled={saving} onclick={onapprove} data-testid="studio-triage-approve">
        <CheckIcon data-icon="inline-start" />{ontrash ? m.studio_gallery_keep_next() : m.studio_triage_approve()} <Kbd>Enter</Kbd>
      </Button>
    </div>
  </div>
</div>
