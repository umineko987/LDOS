<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    applyCaptionEdit,
    assetContentPath,
    assetThumbnailPath,
    captionBatchesQuery,
    captionKeys,
    captionOps,
    captionsQuery,
    decideReview,
    editCaption,
    invalidateCaptions,
    reviewApprovalsQuery,
    setApproved,
    type CaptionItem,
    type CaptionOpsRequest,
  } from "#lib/api/queries/captions.ts";
  import { useCaptionEvents } from "#lib/api/queries/captions-live.svelte.ts";
  import { applyFunnel, datasetKeys, updateDataset, type DatasetDetail } from "#lib/api/queries/datasets.ts";
  import { candidatesQuery } from "#lib/api/queries/tagger.ts";
  import { useCaptionFeedback } from "#lib/components/captions/batch-feedback.svelte.ts";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import { GridSelection, ThumbCell, VirtualGrid } from "#lib/components/grid/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import FrequencyPane from "#lib/components/studio/frequency-pane.svelte";
  import Inspector from "#lib/components/studio/inspector.svelte";
  import OpDialog from "#lib/components/studio/op-dialog.svelte";
  import PaneGutter from "#lib/components/studio/pane-gutter.svelte";
  import TriageView from "#lib/components/studio/triage-view.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import {
    categoryIndex,
    formatCaption,
    frequencyTable,
    selectionSummary,
    type CaptionOp,
    type CaptionTarget,
  } from "#lib/domain/captions.ts";
  import {
    blacklistOf,
    EMPTY_DRAFT,
    expectedVersions,
    filterCaptions,
    indexCaptions,
    latestUndoable,
    toggleBlacklist,
    triageCursor,
    withBlacklist,
    type OpDraft,
  } from "#lib/domain/studio.ts";
  import { indexCandidates, latestTagBatch, savedTagSettings } from "#lib/domain/tag-plan.ts";
  import { parseQuery, toggleQueryTag, type QueryError } from "#lib/domain/tag-query.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { isEditableTarget } from "#lib/keys/keymap.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // review 段 = 标签工作室。左栏是当前结果的标签频率（点标签加进查询）和黑名单；中间是查询框和网格
  // （或逐张校对视图）；右栏是选中图的标签（全部都有 / 部分有）、批量操作和批次历史。
  // 批量操作先 dry-run 看差异再写，写完 toast 可撤销；逐张校对里改标签直接写回单张。
  // 没选图时，右栏和批量操作针对当前查询的全部结果。
  const api = useApi();
  const client = useQueryClient();
  const dataset = useDataset();
  const id = $derived(dataset.id);
  const feedback = useCaptionFeedback(() => id);
  useCaptionEvents(() => id);

  const SAMPLE_ROWS = 6;
  const LEFT = { min: 220, max: 420 };
  const RIGHT = { min: 260, max: 480 };

  const captions = createQuery(() => captionsQuery(api, id));
  const batches = createQuery(() => captionBatchesQuery(api, id));
  const approvals = createQuery(() => reviewApprovalsQuery(api, id));

  // 标签类别来自最近一次打标写入用的模型的词表（候选分数接口带着）；没有打过标时全按一般标签。
  const tagModels = $derived.by(() => {
    const latest = latestTagBatch(batches.data);
    return latest ? (savedTagSettings(latest.params)?.models ?? []) : [];
  });
  const candidates = createQuery(() => ({ ...candidatesQuery(api, id, tagModels), retry: false }));
  const categoryOf = $derived.by(() => {
    const response = candidates.data?.candidates;
    return response ? categoryIndex(indexCandidates(response).models.map((model) => model.tags)) : undefined;
  });

  let leftWidth = $state(280);
  let rightWidth = $state(320);
  let search = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let addInput = $state<HTMLInputElement | null>(null);
  let triageInput = $state<HTMLInputElement | null>(null);
  let gridHost = $state<HTMLDivElement | null>(null);
  let focus = $state(-1);
  const selection = new GridSelection();

  const triggerWord = $derived(dataset.triggerWord);
  const items = $derived(captions.data?.list.items ?? []);
  const byId = $derived(new Map(items.map((item) => [item.asset_id, item])));
  const nameOf = (assetId: string) => byId.get(assetId)?.name ?? assetId;
  const indexed = $derived(indexCaptions(items));
  const approved = $derived(approvals.data ?? new Set<string>());
  const parsed = $derived(parseQuery(search));
  const results = $derived(filterCaptions(indexed, parsed, approved, { triggerWord, categoryOf }));
  const order = $derived(results.map((item) => item.asset_id));
  const table = $derived(frequencyTable(results.map((item) => item.tags), { triggerWord, categoryOf }));
  const blacklist = $derived(blacklistOf(dataset.detail?.config));
  const reviewed = $derived(items.reduce((count, item) => count + (approved.has(item.asset_id) ? 1 : 0), 0));

  // 结果变了（查询、写入后）选择里只留还在结果里的图。
  $effect(() => selection.retain(order));

  /** 右栏和批量操作的对象：有选择用选择，否则是全部结果。 */
  const targetIds = $derived(selection.size > 0 ? order.filter((assetId) => selection.has(assetId)) : order);

  // ---- 逐张校对 ----

  let triage = $state(false);
  let triageId = $state<string | null>(null);
  let triageHint = $state(0);
  let saving = $state(false);
  // Z 的撤销栈只在逐张校对里用：编辑的撤销是把旧标签再写回去（批次撤销要求文件版本没变过，
  // 连续撤销几次编辑时前面的批次会报冲突）。
  type UndoStep = { kind: "approve"; assetId: string } | { kind: "edit"; assetId: string; before: readonly string[] };
  let undoStack = $state.raw<readonly UndoStep[]>([]);

  const triageIndex = $derived(triageCursor(order, triageId, triageHint));
  const triageItem = $derived<CaptionItem | undefined>(results[triageIndex]);
  const scopeIds = $derived(triage ? (triageItem ? [triageItem.asset_id] : []) : targetIds);
  const scopeItems = $derived(scopeIds.flatMap((assetId) => byId.get(assetId) ?? []));
  const summary = $derived(selectionSummary(scopeItems.map((item) => item.tags), triggerWord));
  const scopeApproved = $derived(scopeItems.filter((item) => approved.has(item.asset_id)).length);

  // 当前图被过滤掉（例如 is:pending 下刚校对完）时游标落到同一位置的那张上。
  $effect(() => {
    if (!triage) return;
    if (triageItem && triageItem.asset_id !== triageId) triageId = triageItem.asset_id;
    if (triageIndex >= 0) triageHint = triageIndex;
  });

  // 预先加载下一张大图。
  $effect(() => {
    if (!triage) return;
    const next = order[triageIndex + 1];
    if (!next) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = api.resourceUrl(assetContentPath(next));
  });

  function enterTriage(index = focus) {
    const start = index >= 0 ? index : selection.size > 0 ? order.findIndex((assetId) => selection.has(assetId)) : 0;
    if (!order.length) return;
    triageId = order[Math.max(0, start)] ?? null;
    triageHint = Math.max(0, start);
    triage = true;
  }

  function exitTriage() {
    triage = false;
    focus = triageIndex;
  }

  function step(delta: number) {
    const next = order[triageIndex + delta];
    if (!next) return;
    triageId = next;
    triageHint = triageIndex + delta;
  }

  function approveCurrent() {
    const item = triageItem;
    if (!item) return;
    const index = triageIndex;
    const next = order[index + 1];
    if (!approved.has(item.asset_id)) {
      undoStack = [...undoStack, { kind: "approve", assetId: item.asset_id }];
      void decide([item.asset_id], true);
    }
    if (next) {
      triageId = next;
      triageHint = index;
    } else {
      toast(m.studio_triage_end());
    }
  }

  async function writeTags(item: CaptionItem, tags: readonly string[]): Promise<boolean> {
    saving = true;
    try {
      const response = await editCaption(api, id, item.asset_id, { text: formatCaption(tags), expected_version: item.version });
      applyCaptionEdit(client, id, response);
      return true;
    } catch (error) {
      toast.error(m.studio_edit_failed({ reason: apiErrorMessage(error) }));
      void invalidateCaptions(client, id);
      return false;
    } finally {
      saving = false;
    }
  }

  async function editCurrent(tags: string[]) {
    const item = triageItem;
    if (!item || saving) return;
    const before = item.tags;
    if (await writeTags(item, tags)) undoStack = [...undoStack, { kind: "edit", assetId: item.asset_id, before }];
  }

  async function undoTriage() {
    if (saving) return;
    const last = undoStack.at(-1);
    if (!last) {
      toast(m.studio_undo_nothing());
      return;
    }
    undoStack = undoStack.slice(0, -1);
    triageId = last.assetId;
    if (last.kind === "approve") {
      await decide([last.assetId], false);
      toast(m.studio_unapproved_one({ name: nameOf(last.assetId) }));
      return;
    }
    const item = byId.get(last.assetId);
    if (item && (await writeTags(item, last.before))) toast(m.studio_edit_undone({ name: item.name }));
  }

  // ---- 校对状态 ----

  async function decide(assetIds: readonly string[], approve: boolean) {
    if (!assetIds.length) return;
    setApproved(client, id, assetIds, approve);
    try {
      const result = await decideReview(api, id, assetIds, approve ? "approve" : "clear");
      if (result) applyFunnel(client, result.funnel);
    } catch (error) {
      toast.error(m.studio_approve_failed({ reason: apiErrorMessage(error) }));
      void client.invalidateQueries({ queryKey: captionKeys.approvals(id) });
    }
  }

  /**
   * A：选中的图（没选时是焦点那一格）全都校对过就撤回，否则全部记为已校对。
   * 不像右栏那样落到全部结果上：误按一下不该改动整个查询结果。
   */
  function toggleApproval() {
    const ids = selection.targets(order, focus);
    if (ids.length) void decide(ids, !ids.every((assetId) => approved.has(assetId)));
  }

  // ---- 批量操作 ----

  let opOpen = $state(false);
  let opDraft = $state.raw<OpDraft>(EMPTY_DRAFT);
  let opIds = $state.raw<readonly string[]>([]);
  const opTargets = $derived<CaptionTarget[]>(opIds.flatMap((assetId) => byId.get(assetId) ?? []));

  function openOp(partial: Partial<OpDraft>) {
    if (!scopeIds.length) return;
    opIds = scopeIds;
    opDraft = { ...EMPTY_DRAFT, ...partial };
    opOpen = true;
  }

  const opBody = (op: CaptionOp, dryRun: boolean): CaptionOpsRequest => ({
    asset_ids: [...opIds],
    // 本地的操作类型是只读的，请求体类型是可变的；内容一样。
    ops: [op] as CaptionOpsRequest["ops"],
    expected_versions: expectedVersions(items, opIds),
    dry_run: dryRun,
    sample_limit: dryRun ? SAMPLE_ROWS : 0,
  });

  const previewOp = (op: CaptionOp) => captionOps(api, id, opBody(op, true));

  async function applyOp(op: CaptionOp) {
    const result = await captionOps(api, id, opBody(op, false));
    feedback.written(result, m.studio_op_done({ count: result.stats.written }));
  }

  async function undoLatest() {
    const latest = latestUndoable(batches.data);
    if (!latest) {
      toast(m.studio_undo_nothing());
      return;
    }
    await feedback.undo(latest.batch_id);
  }

  // ---- 黑名单 ----

  async function toggleBlacklisted(tag: string) {
    const detail = dataset.detail;
    if (!detail) return;
    const config = withBlacklist(detail.config, toggleBlacklist(blacklist, tag));
    client.setQueryData<DatasetDetail>(datasetKeys.detail(id), (current) => current && { ...current, config });
    try {
      await updateDataset(api, id, { config });
    } catch (error) {
      toast.error(m.studio_blacklist_failed({ reason: apiErrorMessage(error) }));
      void client.invalidateQueries({ queryKey: datasetKeys.detail(id) });
    }
  }

  // ---- 查询 ----

  function toggleTag(tag: string, negate: boolean) {
    search = toggleQueryTag(search, tag, negate);
    focus = -1;
  }

  function queryError(error: QueryError): string {
    return error.kind === "unknown_category"
      ? m.studio_query_unknown_category({ value: error.value })
      : m.studio_query_unknown_state({ value: error.value });
  }

  // ---- 查看器 ----

  let viewerOpen = $state(false);
  let viewerIndex = $state(0);
  const thumb = (assetId: string) => api.resourceUrl(assetThumbnailPath(assetId));
  const viewerItems = $derived<ViewerItem[]>(
    results.map((item) => ({
      id: item.asset_id,
      name: item.name,
      src: api.resourceUrl(assetContentPath(item.asset_id)),
      thumb: thumb(item.asset_id),
      meta: item.text,
    })),
  );

  function originOf(_item: ViewerItem, index: number) {
    return gridHost?.querySelector<HTMLElement>(`[data-index="${index}"] img`) ?? null;
  }

  // ---- 按键和 Esc ----

  function focusAdd() {
    if (triage) {
      triageInput?.focus();
      return;
    }
    if (selection.size === 0 && focus >= 0 && order[focus]) selection.click(order, order[focus]!);
    // 输入框在有对象时才渲染；选中后等一帧。
    requestAnimationFrame(() => addInput?.focus());
  }

  // 输入框里先离开输入框（focus 那一步）；校对视图：退回网格；网格：选择由网格自己清，没有选择时清空查询。
  useEscape("selection", () => {
    if (isEditableTarget(document.activeElement)) return false;
    if (triage) {
      exitTriage();
      return true;
    }
    if (selection.size > 0) return false;
    if (search) {
      search = "";
      return true;
    }
    return false;
  });

  const group = m.keys_group_studio;
  useBindings("page", () => [
    { id: "studio.search", keys: "/", label: m.studio_key_search, group, run: () => searchInput?.focus() },
    {
      id: "studio.add",
      keys: "t",
      label: m.studio_key_add,
      group,
      when: () => (triage ? triageItem !== undefined : order.length > 0),
      run: focusAdd,
    },
    {
      id: "studio.approve",
      keys: "a",
      label: m.studio_key_approve,
      group,
      when: () => !triage && (selection.size > 0 || focus >= 0),
      run: toggleApproval,
    },
    {
      id: "studio.undo",
      keys: "z",
      label: m.studio_key_undo,
      group,
      run: () => void (triage ? undoTriage() : undoLatest()),
    },
    {
      id: "studio.triage",
      label: m.studio_key_triage,
      group,
      palette: true,
      when: () => !triage && order.length > 0,
      run: () => enterTriage(),
    },
    ...(triage
      ? [
          { id: "studio.triage.approve", keys: "enter", label: m.studio_key_approve_next, group, run: approveCurrent },
          { id: "studio.triage.prev", keys: ["arrowleft", "h"], label: m.studio_triage_prev, group, run: () => step(-1) },
          { id: "studio.triage.next", keys: ["arrowright", "l"], label: m.studio_triage_next, group, run: () => step(1) },
        ]
      : []),
  ]);

  const modes = [
    { value: "grid" as const, label: m.studio_mode_grid() },
    { value: "triage" as const, label: m.studio_mode_triage() },
  ];
</script>

<div class="flex min-h-0 flex-1" data-testid="studio">
  <aside class="flex flex-none flex-col border-r border-line" style:width="{leftWidth}px" aria-label={m.studio_frequency()}>
    <FrequencyPane {table} query={parsed} {blacklist} ontoggle={toggleTag} onblacklist={(tag) => void toggleBlacklisted(tag)} />
  </aside>
  <PaneGutter bind:width={leftWidth} limits={LEFT} side="left" label={m.studio_resize_left()} />

  <main class="flex min-w-0 flex-1 flex-col">
    <div class="flex h-11 flex-none items-center gap-3 border-b border-line px-4" data-testid="studio-toolbar">
      <Segmented
        options={modes}
        value={triage ? "triage" : "grid"}
        onchange={(next) => (next === "triage" ? enterTriage() : exitTriage())}
        label={m.studio_mode()}
        size="sm"
        data-testid="studio-mode"
      />
      <div class="relative min-w-0 flex-1">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg3" />
        <Input
          bind:ref={searchInput}
          bind:value={search}
          type="search"
          class="h-7 pl-7 font-mono text-xs"
          placeholder={m.studio_query_placeholder()}
          aria-label={m.studio_query()}
          aria-invalid={parsed.errors.length > 0}
          data-testid="studio-query"
          oninput={() => (focus = -1)}
          onkeydown={(event) => {
            if (event.key === "Escape" && search) {
              event.stopPropagation();
              search = "";
            }
          }}
        />
      </div>
      <span class="flex-none text-xs text-fg2 tabular-nums" data-testid="studio-count" data-count={results.length}>
        {m.studio_results({ count: results.length, total: items.length })}
      </span>
      <span class="flex flex-none items-center gap-2 text-2xs text-fg3" data-testid="studio-reviewed" data-count={reviewed}>
        <Progress value={reviewed} max={Math.max(1, items.length)} class="w-16" aria-label={m.studio_reviewed_label()} />
        {m.studio_reviewed({ count: reviewed, total: items.length })}
      </span>
    </div>
    {#if parsed.errors.length}
      <p class="flex-none border-b border-line px-4 py-1 text-2xs text-warn" role="status" data-testid="studio-query-errors">
        {parsed.errors.map(queryError).join(" · ")}
      </p>
    {/if}
    {#if selection.size > 0 && !triage}
      <div class="flex h-9 flex-none items-center gap-2 border-b border-line px-4 text-xs" data-testid="studio-selection">
        <span class="text-fg2">{m.studio_selected({ count: selection.size })}</span>
        <Button variant="ghost" size="xs" onclick={() => selection.clear()}>{m.studio_clear_selection()} <Kbd>Esc</Kbd></Button>
      </div>
    {/if}

    {#if captions.isError}
      <div class="flex items-center gap-3 px-4 py-4 text-sm text-danger" role="alert">
        {apiErrorMessage(captions.error)}
        <Button variant="outline" size="sm" onclick={() => captions.refetch()}>{m.common_retry()}</Button>
      </div>
    {:else if triage}
      {#if triageItem}
        <TriageView
          item={triageItem}
          position={triageIndex}
          total={order.length}
          approved={approved.has(triageItem.asset_id)}
          {triggerWord}
          {categoryOf}
          src={api.resourceUrl(assetContentPath(triageItem.asset_id))}
          {saving}
          bind:addInput={triageInput}
          onedit={(tags) => void editCurrent(tags)}
          onapprove={approveCurrent}
          onstep={step}
        />
      {:else}
        <p class="px-4 py-6 text-sm text-fg3">{m.studio_no_results()}</p>
      {/if}
    {:else}
      <div bind:this={gridHost} class="flex min-h-0 flex-1 flex-col">
        <VirtualGrid
          items={results}
          key={(item) => item.asset_id}
          label={m.studio_grid({ count: results.length })}
          itemLabel={(item) => (approved.has(item.asset_id) ? m.studio_item_approved({ name: item.name }) : item.name)}
          {selection}
          bind:focus
          thumbSize={152}
          aspect={1.35}
          onopen={(_item, index) => enterTriage(index)}
          onpreview={(_item, index) => {
            viewerIndex = index;
            viewerOpen = true;
          }}
        >
          {#snippet cell({ item })}
            <div class="flex size-full flex-col">
              <div class="min-h-0 flex-1">
                <ThumbCell src={thumb(item.asset_id)} alt={item.name}>
                  {#snippet topRight()}
                    {#if approved.has(item.asset_id)}
                      <CircleCheckIcon class="size-3.5 rounded-full bg-bg0/80 text-ok" aria-hidden="true" data-approved />
                    {/if}
                  {/snippet}
                </ThumbCell>
              </div>
              <p
                class={cn(
                  "line-clamp-2 h-8 flex-none px-1.5 pt-1 text-2xs leading-tight break-all",
                  item.tags.length ? "text-fg2" : "text-fg3 italic",
                )}
                data-caption
              >
                {item.tags.length ? item.text : m.studio_no_caption()}
              </p>
            </div>
          {/snippet}
          {#snippet empty()}
            {#if captions.isPending}
              <span role="status">{m.studio_loading()}</span>
            {:else if search}
              {m.studio_no_match({ query: search })}
            {:else}
              {m.studio_no_results()}
            {/if}
          {/snippet}
        </VirtualGrid>
      </div>
    {/if}
  </main>

  <PaneGutter bind:width={rightWidth} limits={RIGHT} side="right" label={m.studio_resize_right()} />
  <aside class="flex flex-none flex-col border-l border-line" style:width="{rightWidth}px" aria-label={m.studio_inspector()}>
    <Inspector
      {summary}
      scope={triage ? "current" : selection.size > 0 ? "selection" : "results"}
      {categoryOf}
      approved={scopeApproved}
      batches={batches.data}
      quickAdd={!triage}
      bind:addInput
      onop={openOp}
      onapprove={(approve) => void decide(scopeIds, approve)}
      onundo={(batchId) => feedback.undo(batchId)}
    />
  </aside>
</div>

<OpDialog
  bind:open={opOpen}
  initial={opDraft}
  targets={opTargets}
  {triggerWord}
  {nameOf}
  preview={previewOp}
  apply={applyOp}
/>

<Viewer
  items={viewerItems}
  bind:index={viewerIndex}
  bind:open={viewerOpen}
  origin={originOf}
  onclose={(index) => (focus = index)}
/>
