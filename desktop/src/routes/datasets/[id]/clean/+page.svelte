<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import { createInfiniteQuery, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { useTriageEvents, useTriageSettled } from "#lib/api/queries/triage-live.svelte.ts";
  import {
    CLEAN_REASONS,
    cleanItemsQuery,
    FILTER_MODELS,
    invalidateTriage,
    reviewPresetsQuery,
    runTriageStage,
    triageKeys,
    triagePhase,
    triageSummaryQuery,
    type CleanReason,
    type StageRunRequest,
  } from "#lib/api/queries/triage.ts";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import { ModelGate } from "#lib/components/model-install/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import DeckCard from "#lib/components/triage/deck-card.svelte";
  import GroupStrip from "#lib/components/triage/group-strip.svelte";
  import KeyHints from "#lib/components/triage/key-hints.svelte";
  import ReferencePicker from "#lib/components/triage/reference-picker.svelte";
  import { toggleAt, useTriageKeys } from "#lib/components/triage/triage-keys.svelte.ts";
  import { TriageSession } from "#lib/components/triage/triage-session.svelte.ts";
  import TriageStatus from "#lib/components/triage/triage-status.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import { CLEAN_BATCH, cleanBatches, cleanDecisions } from "#lib/domain/triage-groups.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { currentGroup, groupStatus, keepOf } from "#lib/keys/triage.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 清洗段：用模型标出黑白图、线稿、角色不符的图，一批 8 张逐批确认。命中的图默认移除，数字键改为保留。
  // 移除的图进回收区，可以恢复。标题和阶段导航在 ../+layout.svelte。
  const api = useApi();
  const client = useQueryClient();
  const dataset = useDataset();
  const id = $derived(dataset.id);

  const MAX_REFERENCES = 20;
  const DEFAULT_PRESET = "builtin-style";
  type Filter = "filter_monochrome" | "filter_sketch" | "filter_character";
  type ReasonFilter = "all" | CleanReason;

  let running = $state(false);
  let modelsReady = $state(false);
  /** 就绪后点了“重新运行”：先显示运行选项。 */
  let configuring = $state(false);
  let reason = $state<ReasonFilter>("all");
  let presetId = $state<string | null>(null);
  let filters = $state<Record<Filter, boolean>>({ filter_monochrome: true, filter_sketch: true, filter_character: false });
  let references = $state.raw<string[]>([]);
  let pickerOpen = $state(false);
  let presetMenuOpen = $state(false);
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);

  const summary = createQuery(() => triageSummaryQuery(api, id, "clean"));
  useTriageEvents(() => id, "clean");
  const presets = createQuery(() => reviewPresetsQuery(api));
  const phase = $derived(triagePhase(summary.data));
  useTriageSettled(() => id, () => phase);
  const ready = $derived(phase === "ready");
  const runId = $derived(summary.data?.run?.run_id ?? null);
  const counts = $derived(summary.data?.counts);
  const memberCount = $derived(dataset.stage("clean")?.input ?? dataset.detail?.member_count ?? 0);

  // ---- 运行选项：预设打底，三个过滤器可以单独开关 ----

  const presetList = $derived(presets.data ?? []);
  const preset = $derived(presetList.find((item) => item.id === presetId) ?? null);

  // 预设读回来以后选上默认的那个。
  $effect(() => {
    if (presetId === null && presetList.length) untrack(() => choosePreset(presetList.find((item) => item.id === DEFAULT_PRESET)?.id ?? presetList[0]!.id));
  });

  function choosePreset(next: string) {
    const chosen = presetList.find((item) => item.id === next);
    if (!chosen) return;
    presetId = chosen.id;
    filters = {
      filter_monochrome: chosen.options.filter_monochrome,
      filter_sketch: chosen.options.filter_sketch,
      filter_character: chosen.options.filter_character && memberCount > 0,
    };
    references = chosen.options.reference_asset_ids.slice(0, MAX_REFERENCES);
  }

  const modelKeys = $derived([...new Set((Object.keys(filters) as Filter[]).filter((key) => filters[key]).map((key) => FILTER_MODELS[key]))]);
  const anyFilter = $derived(filters.filter_monochrome || filters.filter_sketch || filters.filter_character);
  const runIssue = $derived(
    !anyFilter ? m.clean_need_filter() : filters.filter_character && references.length === 0 ? m.clean_need_references() : null,
  );
  // 没开过滤器时不需要模型（runIssue 会拦住运行）。
  const canRun = $derived(runIssue === null && (modelKeys.length === 0 || modelsReady));

  const runBody = $derived<StageRunRequest>({
    preset_id: preset?.id ?? null,
    options: { ...filters, reference_asset_ids: filters.filter_character ? references : [] },
  });

  async function run() {
    if (running || !canRun) return;
    running = true;
    try {
      client.setQueryData(triageKeys.summary(id, "clean"), await runTriageStage(api, id, "clean", runBody));
      reason = "all";
      configuring = false;
      void invalidateTriage(client, id, "clean");
    } catch (error) {
      toast.error(m.triage_run_failed({ reason: apiErrorMessage(error) }));
    } finally {
      running = false;
    }
  }

  // ---- 卡组 ----

  const items = createInfiniteQuery(() => ({
    ...cleanItemsQuery(api, id, { reason: reason === "all" ? null : reason }),
    enabled: ready,
  }));
  const flagged = $derived(items.data?.pages.flatMap((page) => page.items) ?? []);
  const flaggedTotal = $derived(items.data?.pages[0]?.total ?? 0);
  const batches = $derived(cleanBatches(flagged));
  const batchById = $derived(new Map(batches.map((batch) => [batch.id, batch])));

  const session = new TriageSession({
    api,
    client,
    id: () => id,
    stage: "clean",
    runId: () => runId,
    groups: () => batches,
    key: () => `${id}:${runId ?? ""}:${reason}`,
    decisions: (group, keep) => {
      const batch = batchById.get(group);
      return batch ? cleanDecisions(batch, keep) : [];
    },
    serverUndoDepth: () => summary.data?.undo_depth ?? 0,
  });

  const triage = $derived(session.state);
  const focusBatch = $derived(currentGroup(triage));
  const batch = $derived(focusBatch ? batchById.get(focusBatch.id) : undefined);
  const keep = $derived(focusBatch ? keepOf(triage, focusBatch.id) : new Set<string>());
  const status = $derived(focusBatch ? groupStatus(triage, focusBatch.id) : "pending");
  const totalBatches = $derived(Math.max(Math.ceil(flaggedTotal / CLEAN_BATCH), batches.length));
  const finished = $derived(!!counts && counts.flagged > 0 && counts.pending_groups === 0);

  $effect(() => {
    if (triage.group >= batches.length - 2 && items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
  });

  const reasonLabels: Record<CleanReason, () => string> = {
    monochrome: m.clean_reason_monochrome,
    rough: m.clean_reason_rough,
    filter_character: m.clean_reason_filter_character,
    unreadable: m.clean_reason_unreadable,
  };
  const reasonOptions = $derived([
    { value: "all" as const, label: m.clean_reason_all() },
    ...CLEAN_REASONS.map((value) => ({ value, label: reasonLabels[value]() })),
  ]);

  const viewerItems = $derived<ViewerItem[]>(
    (batch?.members ?? []).map((member) => ({
      id: member.asset_id,
      name: member.name,
      src: api.resourceUrl(member.image_url),
      thumb: api.resourceUrl(member.thumbnail_url),
      width: member.width,
      height: member.height,
      meta: member.reasons.map((item) => reasonLabels[item as CleanReason]?.() ?? item).join(" · "),
    })),
  );

  function setAll(kept: boolean) {
    if (batch) session.dispatch({ type: "set", keep: kept ? batch.items : [] });
  }

  function preview() {
    if (!batch) return;
    viewerIndex = Math.max(0, triage.item);
    viewerOpen = true;
  }

  const group = m.keys_group_clean;
  const deckActive = () => ready && !configuring && batch !== undefined;
  useTriageKeys(session, {
    prefix: "clean",
    group,
    enabled: () => deckActive(),
    onpreview: preview,
    extra: () => [
      { id: "clean.keep-all", label: m.clean_keep_all, group, palette: true, when: deckActive, run: () => setAll(true) },
      { id: "clean.drop-all", label: m.clean_drop_all, group, palette: true, when: deckActive, run: () => setAll(false) },
      { id: "clean.rerun", label: m.triage_rerun, group, palette: true, when: () => ready && !configuring && !running, run: () => void (configuring = true) },
    ],
  });
  useOverlay(() => presetMenuOpen, { id: "clean-presets" });
</script>

{#snippet filterRow(key: Filter, label: string)}
  <label class="flex items-center gap-2 text-sm text-fg">
    <Checkbox checked={filters[key]} onCheckedChange={(value) => (filters = { ...filters, [key]: value === true })} data-testid={`clean-${key}`} />
    {label}
  </label>
{/snippet}

{#snippet runOptions()}
  <div class="flex w-full flex-col gap-3 rounded-lg border border-line bg-bg1 px-4 py-3" data-testid="clean-options">
    <div class="flex items-center gap-2 text-xs text-fg2">
      {m.clean_preset()}
      <DropdownMenu.Root bind:open={presetMenuOpen}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button variant="outline" size="sm" {...props} data-testid="clean-preset">
              {preset?.name ?? m.clean_preset_none()}<ChevronDownIcon />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" class="min-w-44">
          <DropdownMenu.RadioGroup value={presetId ?? ""} onValueChange={(value) => choosePreset(value)}>
            {#each presetList as item (item.id)}
              <DropdownMenu.RadioItem value={item.id}>{item.name}</DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {#if presets.isError}<span class="text-danger">{apiErrorMessage(presets.error)}</span>{/if}
    </div>
    <div class="flex flex-col gap-2">
      {@render filterRow("filter_monochrome", m.clean_filter_monochrome())}
      {@render filterRow("filter_sketch", m.clean_filter_sketch())}
      {#if memberCount > 0}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          {@render filterRow("filter_character", m.clean_filter_character())}
          {#if filters.filter_character}
            <Button variant="outline" size="xs" onclick={() => (pickerOpen = true)} data-testid="clean-references">
              {references.length ? m.clean_references_picked({ count: references.length }) : m.clean_references_pick()}
            </Button>
          {/if}
        </div>
      {:else}
        <p class="text-xs text-fg3" data-testid="clean-character-unavailable">{m.clean_character_unavailable()}</p>
      {/if}
    </div>
    {#if modelKeys.length}
      <ModelGate keys={modelKeys} block={false} bind:ready={modelsReady} title={m.clean_models_title()} />
    {/if}
    {#if runIssue}<p class="text-xs text-warn" role="status" data-testid="clean-run-issue">{runIssue}</p>{/if}
  </div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="clean">
  {#if !ready || summary.isError || configuring}
    <TriageStatus
      {phase}
      summary={summary.data}
      error={summary.error}
      loading={summary.isPending}
      busy={running}
      {canRun}
      title={configuring ? m.clean_rerun_title() : m.clean_idle_title()}
      hint={configuring ? m.clean_rerun_body() : m.clean_idle_body()}
      runLabel={m.clean_run()}
      onrun={() => void run()}
      onretry={() => void summary.refetch()}
      oncancel={configuring ? () => (configuring = false) : undefined}
      options={runOptions}
    />
  {:else}
    <div class="flex h-11 flex-none items-center gap-3 border-b border-line px-7" data-testid="clean-toolbar">
      <Segmented
        options={reasonOptions}
        value={reason}
        onchange={(next) => (reason = next)}
        label={m.clean_reason_filter()}
        size="sm"
        data-testid="clean-reason"
      />
      <span class="text-xs text-fg2 tabular-nums" data-testid="clean-progress">
        {m.clean_counts({ flagged: counts?.flagged ?? 0, pending: counts?.pending_groups ?? 0 })}
      </span>
      {#if session.pending > 0}<span class="text-2xs text-fg3" role="status">{m.triage_saving()}</span>{/if}
      <span class="grow"></span>
      <Button variant="ghost" size="sm" onclick={() => (configuring = true)} disabled={running} data-testid="clean-rerun">
        <RotateCcwIcon />{m.triage_rerun()}
      </Button>
    </div>

    {#if items.isError}
      <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
        {m.triage_load_failed({ reason: apiErrorMessage(items.error) })}
        <Button variant="outline" size="sm" onclick={() => items.refetch()}>{m.common_retry()}</Button>
      </div>
    {:else if items.isPending}
      <span class="px-7 py-4 text-xs text-fg3" role="status">{m.triage_loading()}</span>
    {:else if batches.length === 0}
      <div class="flex flex-1 flex-col items-start justify-center gap-3 px-7" data-testid="clean-none">
        <h2 class="text-base font-medium">{reason === "all" ? m.clean_none_title() : m.clean_none_reason()}</h2>
        {#if reason === "all"}<p class="max-w-[520px] text-sm text-fg2">{m.clean_none_body()}</p>{/if}
        <Button variant="outline" href={`#/datasets/${encodeURIComponent(id)}/dedup`}>{m.clean_next_stage()}<ArrowRightIcon /></Button>
      </div>
    {:else}
      {#if finished}
        <div class="flex items-center gap-3 border-b border-line bg-bg1 px-7 py-2 text-xs" role="status" data-testid="clean-done">
          <span class="text-fg">{m.clean_done_title()}</span>
          <span class="text-fg2">{m.triage_done_body()}</span>
          <span class="grow"></span>
          <Button variant="outline" size="sm" href={`#/datasets/${encodeURIComponent(id)}/dedup`}>{m.clean_next_stage()}<ArrowRightIcon /></Button>
        </div>
      {/if}
      <div class="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 px-7 pt-3.5 pb-2" data-testid="clean-deckbar">
        <h2 class="text-sm font-medium tabular-nums" data-testid="clean-counter">
          {m.triage_group_counter({ n: triage.group + 1, total: totalBatches })}
        </h2>
        <span class="text-xs text-fg3">{m.clean_batch_hint({ count: CLEAN_BATCH })}</span>
        <span class="grow"></span>
        <Button variant="ghost" size="sm" onclick={() => setAll(true)} disabled={!batch}>{m.clean_keep_all()}</Button>
        <Button variant="ghost" size="sm" onclick={() => setAll(false)} disabled={!batch}>{m.clean_drop_all()}</Button>
        <Button variant="ghost" size="sm" onclick={() => session.undo()} disabled={session.undoing} data-testid="clean-undo">
          <Undo2Icon />{m.triage_undo()} <Kbd>Z</Kbd>
        </Button>
        <Button variant="primary" size="sm" onclick={() => session.adopt()} disabled={!batch || session.undoing} data-testid="clean-adopt">
          {m.triage_adopt()} <Kbd class="border-gold-ink/25 bg-transparent text-current">Enter</Kbd>
        </Button>
      </div>
      <div class="px-7 pb-3"><GroupStrip state={triage} ongoto={(index) => session.dispatch({ type: "goto", group: index })} /></div>
      <div class="min-h-0 flex-1 overflow-y-auto px-7">
        {#if batch}
          <div class="grid max-w-[1200px] grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5" data-testid="clean-deck">
            {#each batch.members as member, index (member.asset_id)}
              <DeckCard
                {index}
                src={api.resourceUrl(member.thumbnail_url)}
                alt={member.name}
                kept={keep.has(member.asset_id)}
                {status}
                focused={index === triage.item}
                failed={member.disposition === "failed"}
                onclick={() => toggleAt(session, index)}
              >
                {#snippet chips()}
                  {#each member.reasons as item (item)}
                    <span class="rounded-[4px] border border-line2 px-1.5 text-2xs text-fg2" data-testid="clean-reason-chip">
                      {reasonLabels[item as CleanReason]?.() ?? item}
                    </span>
                  {/each}
                {/snippet}
                {#snippet meta()}
                  <span class="text-fg3 tabular-nums">{member.width}×{member.height}</span>
                {/snippet}
              </DeckCard>
            {/each}
          </div>
        {/if}
      </div>
      <div class="px-7 py-3"><KeyHints count={batch?.members.length ?? 0} /></div>
    {/if}
  {/if}
</div>

<ReferencePicker bind:open={pickerOpen} dataset={id} value={references} max={MAX_REFERENCES} onsubmit={(ids) => (references = ids)} />
<Viewer items={viewerItems} bind:index={viewerIndex} bind:open={viewerOpen} onclose={(index) => session.dispatch({ type: "select", index })} />
