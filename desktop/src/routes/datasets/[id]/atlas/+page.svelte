<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { isApiError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    addAtlasTags,
    atlasJobId,
    atlasQuery,
    atlasThumbnailPath,
    cancelAtlas,
    invalidateAtlas,
    removeFromAtlas,
    restoreToAtlas,
    runAtlas,
    undoCaptionBatch,
  } from "#lib/api/queries/atlas.ts";
  import AtlasPanel from "#lib/components/atlas/atlas-panel.svelte";
  import AtlasStage from "#lib/components/atlas/atlas-stage.svelte";
  import AtlasStatus from "#lib/components/atlas/atlas-status.svelte";
  import AtlasTagDialog from "#lib/components/atlas/atlas-tag-dialog.svelte";
  import {
    applySelection,
    buildAtlasModel,
    buildFlags,
    clusterMembers,
    FLAG_HIDDEN,
    isRemoved,
    liveCount,
    partitionSelection,
    type AtlasModel,
    type SelectMode,
  } from "#lib/domain/atlas-model.ts";
  import {
    ATLAS_MODEL_UNAVAILABLE,
    atlasProgress,
    atlasViewState,
    keepDiverse,
    keepTarget,
    type AtlasTool,
    type KeepPlan,
  } from "#lib/domain/atlas-ops.ts";
  import { KEY_ZOOM_STEP } from "#lib/domain/atlas-view.ts";
  import type { Job } from "#lib/events/bus.ts";
  import { useEvent } from "#lib/events/context.svelte.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 语义地图：DINOv2 嵌入降维后的散点图。圈选一片相似的图，移除（记为去重阶段的排除，reason=atlas）、
  // 只保留其中最多样的 N 张，或批量加标签。标题和阶段导航在 ../+layout.svelte。
  //
  // 选择和“正在移除 / 恢复”的图按 asset id 记：换一份地图数据后下标会变，id 不会。

  const api = useApi();
  const client = useQueryClient();

  const id = $derived(page.params.id ?? "");
  const query = createQuery(() => atlasQuery(api, id));
  const atlas = $derived(query.data?.atlas);
  const model = $derived(atlas?.items?.length ? buildAtlasModel(atlas) : null);
  const hasMap = $derived(model !== null && model.count > 0);

  let selectedIds = $state.raw<ReadonlySet<string>>(new Set());
  let removingIds = $state.raw<ReadonlySet<string>>(new Set());
  let restoringIds = $state.raw<ReadonlySet<string>>(new Set());
  let plan = $state.raw<(KeepPlan & { readonly model: AtlasModel }) | null>(null);
  let showRemoved = $state(false);
  let tool = $state<AtlasTool>("pan");
  let keepN = $state(1);
  let busy = $state(false);
  let runError = $state.raw<unknown>(null);
  let job = $state.raw<Job | null>(null);
  let tagOpen = $state(false);
  let stage = $state<ReturnType<typeof AtlasStage>>();

  function indicesOf(ids: ReadonlySet<string>, target: AtlasModel | null): Set<number> {
    const out = new Set<number>();
    if (!target) return out;
    for (const assetId of ids) {
      const index = target.indexOf.get(assetId);
      if (index !== undefined) out.add(index);
    }
    return out;
  }

  const pending = $derived({ pendingRemoved: indicesOf(removingIds, model), pendingRestored: indicesOf(restoringIds, model) });
  const activePlan = $derived(plan && plan.model === model ? plan : null);
  // 关掉“显示已移除”后，已移除的图虽然还记在选择里，但看不见，不算选中。
  const selected = $derived.by(() => {
    const indices = indicesOf(selectedIds, model);
    if (showRemoved || !model) return indices;
    const current = model;
    return new Set([...indices].filter((index) => !isRemoved(current, pending, index)));
  });
  const selection = $derived(model ? partitionSelection(model, pending, selected) : { live: [], removed: [] });
  const flags = $derived(
    model ? buildFlags(model, { ...pending, selected, drop: new Set(activePlan?.drop ?? []), showRemoved }) : null,
  );
  const liveTotal = $derived(model ? liveCount(model, pending) : 0);

  const viewState = $derived(atlasViewState(atlas, query.error, runError));
  const progress = $derived(atlasProgress(atlas, job));

  // 有代表标签的簇用标签当名字，没有的按编号。
  const clusterLabel = (cluster: number) =>
    model?.clusterTags.get(cluster)?.join(" · ") ?? m.atlas_cluster_label({ n: cluster + 1 });
  const thumbnailUrl = (index: number) => api.resourceUrl(atlasThumbnailPath(model?.ids[index] ?? ""));

  const refresh = () => invalidateAtlas(client, id);

  useEvent("atlas.updated", (event) => {
    if (event.dataset_id === id) void refresh();
  });
  useEvent("dataset.updated", (event) => {
    if (event.dataset_id === id) void refresh();
  });
  useEvent("job.updated", ({ job: next }) => {
    if (next.id !== atlasJobId(id)) return;
    job = next;
    if (next.status !== "running" && next.status !== "queued") void refresh();
  });
  useEvent("resync", () => {
    job = null;
    void refresh();
  });

  const union = (set: ReadonlySet<string>, ids: readonly string[]) => new Set([...set, ...ids]);
  const without = (set: ReadonlySet<string>, ids: readonly string[]) => {
    const drop = new Set(ids);
    return new Set([...set].filter((assetId) => !drop.has(assetId)));
  };

  function select(indices: readonly number[], mode: SelectMode, keep?: number) {
    if (!model) return;
    const next = applySelection(selected, indices, mode);
    const current = model;
    selectedIds = new Set([...next].map((index) => current.ids[index]!));
    plan = null;
    const live = partitionSelection(current, pending, next).live.length;
    keepN = Math.max(1, Math.min(live, keep ?? Math.round(live / 2)));
  }

  function selectCluster(cluster: number, additive: boolean) {
    if (!model) return;
    const current = model;
    const members = clusterMembers(current, cluster, (index) => !isRemoved(current, pending, index));
    select(members, additive ? "add" : "replace", additive ? undefined : keepTarget(liveTotal, members.length, current.shareThreshold));
  }

  function selectAll() {
    if (!model || !flags) return;
    const visible: number[] = [];
    for (let index = 0; index < model.count; index += 1) if (!(flags[index]! & FLAG_HIDDEN)) visible.push(index);
    select(visible, "replace");
  }

  function clearSelection() {
    selectedIds = new Set();
    plan = null;
  }

  function focusAsset(index: number) {
    stage?.focus(index);
    select([index], "replace");
  }

  function setKeepN(value: number) {
    const live = selection.live.length;
    keepN = Number.isFinite(value) ? Math.max(1, Math.min(live, Math.round(value))) : 1;
    plan = null;
  }

  function previewKeep() {
    if (!model) return;
    const result = keepDiverse(model, selection.live, keepN);
    plan = result ? { ...result, model } : null;
  }

  async function run(force: boolean) {
    if (busy) return;
    busy = true;
    runError = null;
    try {
      await runAtlas(api, id, { force });
      job = null;
      await refresh();
    } catch (error) {
      runError = error;
      if (!(isApiError(error) && error.code === ATLAS_MODEL_UNAVAILABLE)) {
        toast.error(m.atlas_run_failed({ reason: apiErrorMessage(error) }));
      }
    } finally {
      busy = false;
    }
  }

  async function cancel() {
    if (busy) return;
    busy = true;
    try {
      await cancelAtlas(api, id);
      await refresh();
    } catch (error) {
      toast.error(m.atlas_cancel_failed({ reason: apiErrorMessage(error) }));
    } finally {
      busy = false;
    }
  }

  /** 先在地图上隐藏（乐观），请求完成并刷新后再交给服务端数据。 */
  async function removeIds(ids: readonly string[], undoable: boolean) {
    if (!ids.length || busy) return;
    busy = true;
    removingIds = union(removingIds, ids);
    restoringIds = without(restoringIds, ids);
    clearSelection();
    try {
      const result = await removeFromAtlas(api, id, ids);
      const count = result?.updated ?? ids.length;
      if (undoable) {
        toast(m.atlas_removed_toast({ count }), {
          action: { label: m.atlas_undo(), onClick: () => void restoreIds(ids, false) },
        });
      } else {
        toast(m.atlas_removed_toast({ count }));
      }
      await refresh();
    } catch (error) {
      toast.error(m.atlas_remove_failed({ reason: apiErrorMessage(error) }));
    } finally {
      removingIds = without(removingIds, ids);
      busy = false;
    }
  }

  async function restoreIds(ids: readonly string[], undoable: boolean) {
    if (!ids.length || busy) return;
    busy = true;
    restoringIds = union(restoringIds, ids);
    removingIds = without(removingIds, ids);
    clearSelection();
    try {
      const result = await restoreToAtlas(api, id, ids);
      const count = result?.updated ?? ids.length;
      const message =
        count < ids.length ? m.atlas_restore_partial({ count, rest: ids.length - count }) : m.atlas_restored_toast({ count });
      if (undoable && count > 0) {
        toast(message, { action: { label: m.atlas_undo(), onClick: () => void removeIds(ids, false) } });
      } else {
        toast(message);
      }
      await refresh();
    } catch (error) {
      toast.error(m.atlas_restore_failed({ reason: apiErrorMessage(error) }));
    } finally {
      restoringIds = without(restoringIds, ids);
      busy = false;
    }
  }

  const idsOf = (indices: readonly number[]) => (model ? indices.map((index) => model!.ids[index]!) : []);

  function removeSelected() {
    void removeIds(idsOf(selection.live), true);
  }

  function restoreSelected() {
    void restoreIds(idsOf(selection.removed), true);
  }

  function applyKeep() {
    if (activePlan) void removeIds(idsOf(activePlan.drop), true);
  }

  async function undoTags(batchId: string) {
    try {
      await undoCaptionBatch(api, batchId);
      toast(m.atlas_tag_undone());
    } catch (error) {
      toast.error(m.atlas_tag_undo_failed({ reason: apiErrorMessage(error) }));
    }
  }

  const previewTags = (tags: string[]) => addAtlasTags(api, id, idsOf(selection.live), tags, true);

  async function applyTags(tags: string[]) {
    const result = await addAtlasTags(api, id, idsOf(selection.live), tags, false);
    const batchId = result.batch_id;
    const message = m.atlas_tag_done({ count: result.stats.written });
    if (batchId) toast(message, { action: { label: m.atlas_undo(), onClick: () => void undoTags(batchId) } });
    else toast(message);
  }

  const canRun = () => viewState !== "running" && viewState !== "loading" && viewState !== "unavailable";
  const mapReady = () => hasMap;
  const group = m.atlas_title;

  useBindings("page", () => [
    { id: "atlas.tool.pan", keys: "v", label: m.atlas_key_pan, group, run: () => void (tool = "pan"), when: mapReady },
    { id: "atlas.tool.lasso", keys: "l", label: m.atlas_key_lasso, group, run: () => void (tool = "lasso"), when: mapReady },
    { id: "atlas.reset", keys: "0", label: m.atlas_key_reset, group, run: () => stage?.reset(), when: mapReady },
    { id: "atlas.zoom.in", keys: "=", label: m.atlas_key_zoom_in, group, run: () => stage?.zoom(KEY_ZOOM_STEP), when: mapReady },
    { id: "atlas.zoom.out", keys: "-", label: m.atlas_key_zoom_out, group, run: () => stage?.zoom(1 / KEY_ZOOM_STEP), when: mapReady },
    { id: "atlas.pan.left", keys: "arrowleft", label: m.atlas_key_pan_left, group, run: () => stage?.pan(-1, 0), when: mapReady },
    { id: "atlas.pan.right", keys: "arrowright", label: m.atlas_key_pan_right, group, run: () => stage?.pan(1, 0), when: mapReady },
    { id: "atlas.pan.up", keys: "arrowup", label: m.atlas_key_pan_up, group, run: () => stage?.pan(0, -1), when: mapReady },
    { id: "atlas.pan.down", keys: "arrowdown", label: m.atlas_key_pan_down, group, run: () => stage?.pan(0, 1), when: mapReady },
    { id: "atlas.select.all", keys: "mod+a", label: m.atlas_key_select_all, group, run: selectAll, when: mapReady, inInput: false },
    {
      id: "atlas.remove",
      keys: ["x", "delete"],
      label: m.atlas_key_remove,
      group,
      run: removeSelected,
      when: () => selection.live.length > 0 && !busy,
    },
    {
      id: "atlas.tag",
      keys: "t",
      label: m.atlas_key_tag,
      group,
      run: () => void (tagOpen = true),
      when: () => selection.live.length > 0,
    },
    {
      id: "atlas.run",
      label: () => (viewState === "none" ? m.atlas_run() : m.atlas_key_rerun()),
      group,
      run: () => void run(viewState !== "none"),
      when: () => canRun() && !busy,
      palette: true,
    },
    {
      id: "atlas.cancel",
      label: m.atlas_key_cancel,
      group,
      run: () => void cancel(),
      when: () => viewState === "running" && !busy,
      palette: true,
    },
  ]);

  useEscape("selection", () => {
    if (activePlan) {
      plan = null;
      return true;
    }
    if (selectedIds.size) {
      clearSelection();
      return true;
    }
    return false;
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="atlas-page" data-state={viewState}>
  <AtlasStatus
    state={viewState}
    {atlas}
    {progress}
    error={query.error}
    {hasMap}
    {busy}
    onrun={(force) => void run(force)}
    oncancel={() => void cancel()}
    onretry={() => void query.refetch()}
  />
  {#if hasMap && model && flags}
    <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
      <AtlasStage
        bind:this={stage}
        {model}
        {flags}
        {tool}
        ontool={(next) => (tool = next)}
        onselect={select}
        resolveUrl={api.resourceUrl}
        {thumbnailUrl}
        {clusterLabel}
      />
      <AtlasPanel
        {model}
        {liveTotal}
        method={atlas?.run?.method ?? null}
        {selection}
        {keepN}
        plan={activePlan}
        {showRemoved}
        {busy}
        {thumbnailUrl}
        {clusterLabel}
        onkeepn={setKeepN}
        onpreview={previewKeep}
        onapply={applyKeep}
        oncancelplan={() => (plan = null)}
        onclear={clearSelection}
        ontag={() => (tagOpen = true)}
        onremove={removeSelected}
        onrestore={restoreSelected}
        onselectcluster={selectCluster}
        onfocus={focusAsset}
        onshowremoved={(show) => (showRemoved = show)}
      />
    </div>
  {/if}
</div>

<AtlasTagDialog bind:open={tagOpen} count={selection.live.length} preview={previewTags} apply={applyTags} />
