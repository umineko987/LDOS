<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import StepForwardIcon from "@lucide/svelte/icons/step-forward";
  import XIcon from "@lucide/svelte/icons/x";

  import { Badge } from "#lib/components/ui/badge/index.ts";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.ts";
  import type { CollectBrowseItem } from "#lib/domain/collect-range.ts";
  import { isCollectableItem } from "#lib/domain/collect-range.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  let {
    item,
    index,
    previewUrl = null,
    selected = false,
    excluded = false,
    onclick,
    onselectuntil,
  }: {
    item: CollectBrowseItem;
    index: number;
    previewUrl?: string | null;
    selected?: boolean;
    excluded?: boolean;
    onclick: (index: number, shiftKey: boolean) => void;
    onselectuntil: (index: number) => void;
  } = $props();

  let imageFailed = $state(false);
  const collectable = $derived(isCollectableItem(item));
  const title = $derived(item.title || `#${item.id}`);
  const metaText = $derived.by(() => {
    const parts: string[] = [];
    if (item.author) parts.push(item.author);
    if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
    if (item.file_ext) parts.push(item.file_ext.toUpperCase());
    return parts.join(" · ");
  });

  function safeExternalUrl(raw: string): string | null {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
      return null;
    }
  }

  const externalUrl = $derived(safeExternalUrl(item.url));
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="block min-w-0">
    <button
      type="button"
      class={cn(
        "group relative flex w-full flex-col overflow-hidden rounded-md border bg-bg1 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-gold",
        selected ? "border-gold ring-1 ring-gold" : "border-line hover:border-line2",
        !collectable && "cursor-not-allowed opacity-60",
        excluded && "opacity-55",
      )}
      disabled={!collectable}
      aria-pressed={selected}
      data-collect-card={item.id}
      data-selected={selected ? "true" : "false"}
      data-excluded={excluded ? "true" : "false"}
      onclick={(event) => onclick(index, event.shiftKey)}
    >
      <div class="relative aspect-[4/3] w-full overflow-hidden bg-bg2">
        {#if previewUrl && !imageFailed}
          <img
            src={previewUrl}
            alt={title}
            loading="lazy"
            decoding="async"
            crossorigin="anonymous"
            class="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
            onerror={() => (imageFailed = true)}
          />
        {:else}
          <div class="flex size-full flex-col items-center justify-center gap-1 px-2 text-fg3">
            <ImageOffIcon class="size-5" aria-hidden="true" />
          </div>
        {/if}

        <div class="pointer-events-none absolute top-1.5 left-1.5 flex flex-wrap items-center gap-1">
          {#if item.page != null}
            <Badge variant="secondary" class="bg-bg0/85 px-1.5 py-0 text-2xs tabular-nums">
              {m.collect_v2_page_label({ page: item.page })}
            </Badge>
          {/if}
          {#if item.media_count > 1}
            <Badge variant="secondary" class="bg-bg0/85 px-1.5 py-0 text-2xs tabular-nums">
              <LayersIcon class="size-3" aria-hidden="true" />
              {m.collect_v2_badge_pages({ count: item.media_count })}
            </Badge>
          {/if}
        </div>

        <div class="pointer-events-none absolute top-1.5 right-1.5 flex items-center gap-1">
          {#if selected}
            <span
              class="flex size-5 items-center justify-center rounded-full bg-gold text-bg0"
              aria-hidden="true"
            >
              <CheckIcon class="size-3.5 stroke-[2.5]" />
            </span>
          {:else if excluded}
            <span
              class="flex size-5 items-center justify-center rounded-full border border-line2 bg-bg0/90 text-fg3"
              title={m.collect_v2_badge_excluded()}
              aria-hidden="true"
            >
              <XIcon class="size-3" />
            </span>
          {/if}
        </div>

        {#if item.local_state === "in_dataset"}
          <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-bg0/90 px-2 py-0.5 text-2xs font-medium text-fg2">
            {m.collect_v2_badge_in_dataset()}
          </div>
        {:else if item.local_state === "in_library"}
          <div class="pointer-events-none absolute inset-x-0 bottom-0 bg-bg0/90 px-2 py-0.5 text-2xs font-medium text-ok">
            {m.collect_v2_badge_in_library()}
          </div>
        {:else if !item.downloadable && item.unavailable_reason}
          <div class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-bg0/90 px-2 py-0.5 text-2xs text-danger">
            {item.unavailable_reason}
          </div>
        {/if}
      </div>

      <div class="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
        <span class={cn("truncate text-xs font-medium text-fg", excluded && "line-through text-fg3")}>
          {title}
        </span>
        {#if metaText}
          <span class="truncate text-2xs text-fg3 tabular-nums">{metaText}</span>
        {/if}
      </div>
    </button>
  </ContextMenu.Trigger>

  <ContextMenu.Content>
    <ContextMenu.Group>
      <ContextMenu.Item disabled={!collectable} onclick={() => onclick(index, false)}>
        {#if selected}
          <XIcon class="size-4" />
          {m.collect_v2_menu_exclude()}
        {:else}
          <CheckIcon class="size-4" />
          {m.collect_v2_menu_include()}
        {/if}
      </ContextMenu.Item>
      <ContextMenu.Item onclick={() => onselectuntil(index)}>
        <StepForwardIcon class="size-4" />
        {m.collect_v2_menu_select_until()}
      </ContextMenu.Item>
      {#if externalUrl}
        <ContextMenu.Separator />
        <ContextMenu.Item>
          {#snippet child({ props })}
            <a {...props} href={externalUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon class="size-4" />
              {m.collect_v2_menu_open_web()}
            </a>
          {/snippet}
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Group>
  </ContextMenu.Content>
</ContextMenu.Root>
