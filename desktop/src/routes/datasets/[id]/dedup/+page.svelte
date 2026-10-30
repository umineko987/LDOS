<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import { createInfiniteQuery, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { useTriageEvents, useTriageSettled } from "#lib/api/queries/triage-live.svelte.ts";
  import {
    dedupGroupsQuery,
    invalidateTriage,
    runTriageStage,
    triageKeys,
    triagePhase,
    triageSummaryQuery,
    type DedupGroup,
  } from "#lib/api/queries/triage.ts";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import { ModelGate } from "#lib/components/model-install/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import CompareDeck from "#lib/components/triage/compare-deck.svelte";
  import GroupStrip from "#lib/components/triage/group-strip.svelte";
  import KeyHints from "#lib/components/triage/key-hints.svelte";
  import { toggleAt, useTriageKeys } from "#lib/components/triage/triage-keys.svelte.ts";
  import { TriageSession } from "#lib/components/triage/triage-session.svelte.ts";
  import TriageStatus from "#lib/components/triage/triage-status.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import { dedupDecisions, dedupGroupInit, memberKept, restoreDecision } from "#lib/domain/triage-groups.ts";
  import { currentGroup, groupStatus, keepOf } from "#lib/keys/triage.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 去重段：精确 / 压缩重复由后端自动回收（可在“自动处理”里恢复），近似重复一组一组比对，挑出要保留的。
  // 标题和阶段导航在 ../+layout.svelte。
  const api = useApi();
  const client = useQueryClient();
  const dataset = useDataset();
  const id = $derived(dataset.id);

  const SIMILARITY_MODELS = ["sscd", "dino"] as const;
  /** 焦点离已加载的末尾还剩这么几组时拉下一页。 */
  const PREFETCH = 3;

  let similarityReady = $state(false);
  let running = $state(false);
  let view = $state<"deck" | "auto">("deck");
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);
  let deck = $state<ReturnType<typeof CompareDeck>>();

  const summary = createQuery(() => triageSummaryQuery(api, id, "dedup"));
  useTriageEvents(() => id, "dedup");
  const phase = $derived(triagePhase(summary.data));
  useTriageSettled(() => id, () => phase);
  const ready = $derived(phase === "ready");
  const runId = $derived(summary.data?.run?.run_id ?? null);
  const counts = $derived(summary.data?.counts);

  const manual = createInfiniteQuery(() => ({ ...dedupGroupsQuery(api, id), enabled: ready }));
  const automatic = createInfiniteQuery(() => ({ ...dedupGroupsQuery(api, id, { automatic: true }), enabled: ready && view === "auto" }));

  const groups = $derived(manual.data?.pages.flatMap((page) => page.items).filter((group) => !group.automatic) ?? []);
  const byId = $derived(new Map(groups.map((group) => [group.group_id, group])));
  const inits = $derived(groups.map(dedupGroupInit));
  // 后端没有“只要自动组”的筛选：连普通组一起翻页，这里挑出来。
  const autoGroups = $derived(automatic.data?.pages.flatMap((page) => page.items).filter((group) => group.automatic) ?? []);

  const session = new TriageSession({
    api,
    client,
    id: () => id,
    stage: "dedup",
    runId: () => runId,
    groups: () => inits,
    key: () => `${id}:${runId ?? ""}`,
    decisions: (group, keep) => dedupDecisions(group, keep),
    serverUndoDepth: () => summary.data?.undo_depth ?? 0,
  });

  const triage = $derived(session.state);
  const focusGroup = $derived(currentGroup(triage));
  const group = $derived<DedupGroup | undefined>(focusGroup ? byId.get(focusGroup.id) : undefined);
  const keep = $derived(focusGroup ? keepOf(triage, focusGroup.id) : new Set<string>());
  const status = $derived(focusGroup ? groupStatus(triage, focusGroup.id) : "pending");
  const total = $derived(Math.max(counts?.groups ?? 0, groups.length));
  const finished = $derived(!!counts && counts.groups > 0 && counts.pending_groups === 0);

  $effect(() => {
    if (triage.group >= groups.length - PREFETCH && manual.hasNextPage && !manual.isFetchingNextPage) void manual.fetchNextPage();
  });

  const viewerItems = $derived<ViewerItem[]>(
    (group?.members ?? []).map((member) => ({
      id: member.asset_id,
      name: member.name,
      src: api.resourceUrl(member.image_url),
      thumb: api.resourceUrl(member.thumbnail_url),
      width: member.width,
      height: member.height,
      meta: `${member.width}×${member.height} · ${member.format.toUpperCase()}`,
    })),
  );

  async function run() {
    if (running) return;
    running = true;
    try {
      const body = { options: { basic_dedup: true, similarity_groups: similarityReady } };
      client.setQueryData(triageKeys.summary(id, "dedup"), await runTriageStage(api, id, "dedup", body));
      view = "deck";
      void invalidateTriage(client, id, "dedup");
    } catch (error) {
      toast.error(m.triage_run_failed({ reason: apiErrorMessage(error) }));
    } finally {
      running = false;
    }
  }

  function preview() {
    if (!group) return;
    viewerIndex = Math.max(0, triage.item);
    viewerOpen = true;
  }

  function restore(target: DedupGroup, assetId: string) {
    void session.external([restoreDecision(target, assetId)], assetId);
  }

  useTriageKeys(session, {
    prefix: "dedup",
    group: m.keys_group_dedup,
    enabled: () => ready && view === "deck" && group !== undefined,
    onpreview: preview,
    extra: () => [
      { id: "dedup.zoom.reset", keys: "0", label: m.dedup_key_reset_zoom, group: m.keys_group_dedup, when: () => ready && view === "deck", run: () => deck?.reset() },
      { id: "dedup.run", label: m.triage_rerun, group: m.keys_group_dedup, palette: true, when: () => phase !== "running" && !running, run: () => void run() },
    ],
  });
</script>

{#snippet runOptions()}
  <p class="text-xs text-fg3">{similarityReady ? m.dedup_run_similarity() : m.dedup_run_basic_only()}</p>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="dedup">
  <ModelGate keys={SIMILARITY_MODELS} block={false} bind:ready={similarityReady} title={m.dedup_models_title()} class="mx-7 mt-3" />

  {#if !ready || summary.isError}
    <TriageStatus
      {phase}
      summary={summary.data}
      error={summary.error}
      loading={summary.isPending}
      busy={running}
      canRun={true}
      title={m.dedup_idle_title()}
      hint={m.dedup_idle_body()}
      runLabel={m.dedup_run()}
      onrun={() => void run()}
      onretry={() => void summary.refetch()}
      options={runOptions}
    />
  {:else}
    <div class="flex h-11 flex-none items-center gap-3 border-b border-line px-7" data-testid="dedup-toolbar">
      <Segmented
        options={[
          { value: "deck", label: m.dedup_view_deck({ count: counts?.groups ?? 0 }) },
          { value: "auto", label: m.dedup_view_auto({ count: counts?.automatic_excluded ?? 0 }) },
        ]}
        value={view}
        onchange={(next) => (view = next)}
        label={m.dedup_view()}
        size="sm"
        data-testid="dedup-view"
      />
      <span class="text-xs text-fg2 tabular-nums" data-testid="dedup-progress">
        {m.triage_progress({ decided: counts?.decided_groups ?? 0, total: counts?.groups ?? 0 })}
      </span>
      {#if session.pending > 0}<span class="text-2xs text-fg3" role="status">{m.triage_saving()}</span>{/if}
      <span class="grow"></span>
      <Button variant="ghost" size="sm" onclick={() => void run()} disabled={running} data-testid="dedup-rerun">
        <RotateCcwIcon />{m.triage_rerun()}
      </Button>
    </div>

    {#if view === "auto"}
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 py-4" data-testid="dedup-auto">
        <p class="max-w-[640px] text-xs leading-5 text-fg2">{m.dedup_auto_hint()}</p>
        {#if automatic.isPending}
          <span class="text-xs text-fg3" role="status">{m.triage_loading()}</span>
        {:else if automatic.isError}
          <p class="text-xs text-danger" role="alert">{m.triage_load_failed({ reason: apiErrorMessage(automatic.error) })}</p>
        {:else if autoGroups.length === 0 && !automatic.hasNextPage}
          <span class="text-xs text-fg3">{m.dedup_auto_empty()}</span>
        {/if}
        {#each autoGroups as auto (auto.group_id)}
          <section class="flex flex-col gap-2" data-testid="dedup-auto-group">
            <h3 class="text-xs text-fg2">
              {auto.kind === "auto_exact" ? m.dedup_auto_kind_exact() : m.dedup_auto_kind_compression()}
              <span class="text-fg3 tabular-nums">· {m.dedup_images({ count: auto.members.length })}</span>
            </h3>
            <div class="flex flex-wrap gap-2">
              {#each auto.members as member (member.asset_id)}
                {@const restored = memberKept(member)}
                <div class="flex w-[132px] flex-col overflow-hidden rounded-lg border border-line bg-bg1">
                  <img
                    crossorigin="anonymous"
                    src={api.resourceUrl(member.thumbnail_url)}
                    alt={member.name}
                    loading="lazy"
                    class="aspect-square w-full bg-bg2 object-cover {restored ? '' : 'opacity-50'}"
                  />
                  <div class="flex items-center gap-1 px-2 py-1.5">
                    <span class="min-w-0 flex-1 truncate font-mono text-2xs text-fg3" title={member.name}>{member.name}</span>
                    {#if restored}
                      <span class="text-2xs text-fg2">{m.dedup_auto_restored()}</span>
                    {:else}
                      <Button variant="ghost" size="xs" onclick={() => restore(auto, member.asset_id)} data-testid="dedup-auto-restore">
                        {m.dedup_auto_restore()}
                      </Button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/each}
        {#if automatic.hasNextPage}
          <Button variant="outline" size="sm" class="self-start" disabled={automatic.isFetchingNextPage} onclick={() => automatic.fetchNextPage()}>
            {m.triage_more()}
          </Button>
        {/if}
      </div>
    {:else if manual.isError}
      <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
        {m.triage_load_failed({ reason: apiErrorMessage(manual.error) })}
        <Button variant="outline" size="sm" onclick={() => manual.refetch()}>{m.common_retry()}</Button>
      </div>
    {:else if manual.isPending}
      <span class="px-7 py-4 text-xs text-fg3" role="status">{m.triage_loading()}</span>
    {:else if groups.length === 0}
      <div class="flex flex-1 flex-col items-start justify-center gap-3 px-7" data-testid="dedup-none">
        <h2 class="text-base font-medium">{m.dedup_none_title()}</h2>
        <p class="max-w-[520px] text-sm text-fg2">{m.dedup_none_body({ count: counts?.automatic_excluded ?? 0 })}</p>
        <Button variant="outline" href={`#/datasets/${encodeURIComponent(id)}/tag`}>{m.dedup_next_stage()}<ArrowRightIcon /></Button>
      </div>
    {:else}
      {#if finished}
        <div class="flex items-center gap-3 border-b border-line bg-bg1 px-7 py-2 text-xs" role="status" data-testid="dedup-done">
          <span class="text-fg">{m.dedup_done_title()}</span>
          <span class="text-fg2">{m.triage_done_body()}</span>
          <span class="grow"></span>
          <Button variant="outline" size="sm" href={`#/datasets/${encodeURIComponent(id)}/tag`}>{m.dedup_next_stage()}<ArrowRightIcon /></Button>
        </div>
      {/if}
      <div class="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 px-7 pt-3.5 pb-2" data-testid="dedup-deckbar">
        <h2 class="text-sm font-medium tabular-nums" data-testid="dedup-counter">
          {m.triage_group_counter({ n: triage.group + 1, total })}
        </h2>
        {#if group}
          <span class="text-xs text-fg2">{m.dedup_images({ count: group.members.length })}</span>
          {#if group.kind === "unreadable"}<span class="text-xs text-warn">{m.dedup_kind_unreadable()}</span>{/if}
          <span class="text-xs text-fg3">{m.dedup_group_status({ status: status === "pending" ? m.triage_group_pending() : status === "decided" ? m.triage_group_decided() : m.triage_group_changed() })}</span>
        {/if}
        <span class="grow"></span>
        <Button variant="ghost" size="sm" onclick={() => session.undo()} disabled={session.undoing} data-testid="dedup-undo">
          <Undo2Icon />{m.triage_undo()} <Kbd>Z</Kbd>
        </Button>
        <Button variant="primary" size="sm" onclick={() => session.adopt()} disabled={!group || session.undoing} data-testid="dedup-adopt">
          {m.triage_adopt()} <Kbd class="border-gold-ink/25 bg-transparent text-current">Enter</Kbd>
        </Button>
      </div>
      <div class="px-7 pb-3"><GroupStrip state={triage} ongoto={(index) => session.dispatch({ type: "goto", group: index })} /></div>
      {#if group}
        <div class="flex min-h-0 flex-1 px-7">
          <CompareDeck
            bind:this={deck}
            {api}
            group={group.group_id}
            members={group.members}
            {keep}
            {status}
            focus={triage.item}
            ontoggle={(index) => toggleAt(session, index)}
          />
        </div>
      {:else}
        <span class="px-7 py-4 text-xs text-fg3" role="status">{m.triage_loading()}</span>
      {/if}
      <div class="px-7 py-3"><KeyHints count={group?.members.length ?? 0} zoom /></div>
    {/if}
  {/if}
</div>

<Viewer items={viewerItems} bind:index={viewerIndex} bind:open={viewerOpen} onclose={(index) => session.dispatch({ type: "select", index })} />
