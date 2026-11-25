<script lang="ts">
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import AlertTriangleIcon from "@lucide/svelte/icons/triangle-alert";

  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import type { CollectSiteStatus } from "#lib/api/queries/collect.ts";
  import {
    describeSourceSelection,
    type CollectSourceSpec,
    type SourceSelectionState,
  } from "#lib/domain/collect-range.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  let {
    sources,
    selections,
    activeSourceId,
    siteStatuses,
    authorizingSite = null,
    onselectsource,
    ontoggleenabled,
    onauthorizesite,
    onclearall,
  }: {
    sources: readonly CollectSourceSpec[];
    selections: Readonly<Record<string, SourceSelectionState>>;
    activeSourceId: string | null;
    siteStatuses: readonly CollectSiteStatus[];
    authorizingSite?: string | null;
    onselectsource: (sourceId: string) => void;
    ontoggleenabled: (sourceId: string) => void;
    onauthorizesite?: (site: string) => void;
    onclearall: () => void;
  } = $props();

  const SITE_LABELS = $derived<Record<string, string>>({
    danbooru: m.collect_v2_site_danbooru(),
    pixiv: m.collect_v2_site_pixiv(),
    twitter: m.collect_v2_site_twitter(),
    exhentai: m.collect_v2_site_exhentai(),
    pawchive: m.collect_v2_site_pawchive(),
  });

  const unauthorizedSites = $derived(
    siteStatuses.filter((st) => !st.authorized && st.site !== "danbooru" && st.site !== "pawchive"),
  );
</script>

<aside
  class="flex h-full min-h-0 w-full flex-col border-b border-line bg-bg1 md:w-64 md:shrink-0 md:border-r md:border-b-0"
  aria-label={m.collect_v2_sources_heading({ count: sources.length })}
  data-testid="collect-source-rail"
>
  <div class="flex items-center justify-between border-b border-line px-3 py-2">
    <span class="text-xs font-medium text-fg2">
      {m.collect_v2_sources_heading({ count: sources.length })}
    </span>
    {#if sources.length > 0}
      <Button type="button" variant="ghost" size="sm" onclick={onclearall}>
        <Trash2Icon class="size-3.5" data-icon="inline-start" />
        {m.collect_v2_clear_all()}
      </Button>
    {/if}
  </div>

  {#if unauthorizedSites.length > 0}
    <div class="flex flex-col gap-1.5 border-b border-line bg-bg2 px-3 py-2">
      {#each unauthorizedSites as status (status.site)}
        {@const siteLabel = SITE_LABELS[status.site] ?? status.site}
        <div class="flex items-center justify-between gap-2 text-2xs text-warn">
          <div class="flex min-w-0 items-center gap-1.5">
            <AlertTriangleIcon class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate" title={status.summary || m.collect_v2_auth_required({ site: siteLabel })}>
              {m.collect_v2_auth_required({ site: siteLabel })}
            </span>
          </div>
          {#if onauthorizesite}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={authorizingSite === status.site}
              onclick={() => onauthorizesite(status.site)}
            >
              {authorizingSite === status.site ? m.collect_v2_auth_checking() : m.collect_v2_auth_action()}
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
    {#if sources.length === 0}
      <p class="px-2 py-6 text-center text-xs text-fg3">
        {m.collect_v2_empty_rail()}
      </p>
    {:else}
      {#each sources as source (source.id)}
        {@const state = selections[source.id]}
        {@const active = source.id === activeSourceId}
        {@const checked = state?.enabled ?? false}
        {@const summary = state ? describeSourceSelection(source, state) : m.collect_v2_source_skipped()}
        <div
          class={cn(
            "flex items-center gap-2 rounded-md border px-2 py-2 transition-colors",
            active ? "border-line2 bg-bg2" : "border-transparent hover:bg-bg2/60",
          )}
          data-source-id={source.id}
          data-source-active={active ? "true" : "false"}
        >
          <Checkbox
            checked={checked}
            aria-label={source.label}
            onCheckedChange={() => ontoggleenabled(source.id)}
          />
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-gold"
            onclick={() => onselectsource(source.id)}
          >
            <div class="flex items-center justify-between gap-1.5">
              <Badge variant="outline" class="px-1.5 py-0 text-2xs">
                {SITE_LABELS[source.site] ?? source.site}
              </Badge>
              <span
                class={cn(
                  "text-2xs tabular-nums",
                  checked ? "font-medium text-fg" : "text-fg3",
                )}
              >
                {summary}
              </span>
            </div>
            <span class="truncate text-xs font-medium text-fg">{source.label}</span>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</aside>
