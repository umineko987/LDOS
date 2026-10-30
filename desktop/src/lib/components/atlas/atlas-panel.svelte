<script lang="ts">
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import type { AtlasModel } from "#lib/domain/atlas-model.ts";
  import type { KeepPlan } from "#lib/domain/atlas-ops.ts";
  import { CLUSTER_PALETTE, clusterColorIndex, rgbCss } from "#lib/gfx/atlas/scene.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 地图右侧的面板：摘要、选择操作、提示（占比过高的簇、离群图）、簇列表。

  interface Props {
    model: AtlasModel;
    liveTotal: number;
    method: string | null;
    selection: { readonly live: readonly number[]; readonly removed: readonly number[] };
    keepN: number;
    plan: KeepPlan | null;
    showRemoved: boolean;
    busy: boolean;
    thumbnailUrl: (index: number) => string;
    clusterLabel: (cluster: number) => string;
    onkeepn: (n: number) => void;
    onpreview: () => void;
    onapply: () => void;
    oncancelplan: () => void;
    onclear: () => void;
    ontag: () => void;
    onremove: () => void;
    onrestore: () => void;
    onselectcluster: (cluster: number, additive: boolean) => void;
    onfocus: (index: number) => void;
    onshowremoved: (show: boolean) => void;
  }

  let {
    model,
    liveTotal,
    method,
    selection,
    keepN,
    plan,
    showRemoved,
    busy,
    thumbnailUrl,
    clusterLabel,
    onkeepn,
    onpreview,
    onapply,
    oncancelplan,
    onclear,
    ontag,
    onremove,
    onrestore,
    onselectcluster,
    onfocus,
    onshowremoved,
  }: Props = $props();

  const MAX_OUTLIERS = 24;

  const selectedCount = $derived(selection.live.length + selection.removed.length);
  const clusters = $derived(model.clusterList.filter((cluster) => cluster.liveSize > 0));
  const over = $derived(
    model.clusterList.filter((cluster) => cluster.overRepresented).sort((a, b) => b.liveShare - a.liveShare),
  );
  const outliers = $derived(model.outliers.slice(0, MAX_OUTLIERS));
  const percent = (share: number) => Math.round(share * 100);
  const swatch = (cluster: number) => rgbCss(CLUSTER_PALETTE[clusterColorIndex(cluster, CLUSTER_PALETTE.length)]!);
</script>

<aside class="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg1 p-4" data-testid="atlas-panel">
  <div class="flex flex-col gap-0.5">
    <h2 class="text-sm font-semibold text-fg">{m.atlas_title()}</h2>
    <span class="text-xs text-fg3" data-testid="atlas-summary">
      {#if method}{method} · {/if}{m.atlas_summary({ count: liveTotal, clusters: clusters.length })}
    </span>
  </div>

  {#if selectedCount}
    <section class="flex flex-col gap-2.5 rounded-lg border border-line2 bg-bg2 p-3" data-testid="atlas-selection" data-count={selectedCount}>
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium text-fg">{m.atlas_selected({ count: selectedCount })}</h3>
        <span class="grow"></span>
        <Button variant="ghost" size="xs" onclick={onclear}>{m.atlas_clear()} <Kbd>Esc</Kbd></Button>
      </div>

      {#if selection.live.length >= 2}
        {#if model.vectors}
          <div class="flex items-center gap-1.5 text-xs text-fg2">
            <span>{m.atlas_keep_prefix()}</span>
            <Input
              type="number"
              class="h-6 w-16 px-1.5 text-xs tabular-nums"
              min={1}
              max={selection.live.length}
              value={keepN}
              aria-label={m.atlas_keep_label()}
              oninput={(event) => onkeepn(Number((event.currentTarget as HTMLInputElement).value))}
              data-testid="atlas-keep-n"
            />
            <span>{m.atlas_keep_suffix()}</span>
            <span class="grow"></span>
            <Button variant="outline" size="sm" onclick={onpreview} data-testid="atlas-keep-preview">{m.atlas_keep_preview()}</Button>
          </div>
          {#if plan}
            <p class="text-xs leading-5 text-fg2" data-testid="atlas-keep-hint">
              {m.atlas_keep_hint({ keep: plan.keep.length, drop: plan.drop.length })}
            </p>
            <div class="flex items-center gap-1.5">
              <Button
                variant="destructive"
                size="sm"
                onclick={onapply}
                disabled={busy || !plan.drop.length}
                data-testid="atlas-keep-apply"
              >
                {m.atlas_keep_apply({ count: plan.drop.length })}
              </Button>
              <Button variant="ghost" size="sm" onclick={oncancelplan}>{m.atlas_keep_cancel()}</Button>
            </div>
          {/if}
        {:else}
          <p class="text-xs text-fg3">{m.atlas_keep_unavailable()}</p>
        {/if}
      {/if}

      <div class="flex flex-wrap items-center gap-1.5">
        {#if selection.live.length}
          <Button variant="outline" size="sm" onclick={ontag} disabled={busy} data-testid="atlas-tag">
            {m.atlas_tag()} <Kbd>T</Kbd>
          </Button>
          <Button variant="destructive" size="sm" onclick={onremove} disabled={busy} data-testid="atlas-remove">
            {m.atlas_remove({ count: selection.live.length })} <Kbd>X</Kbd>
          </Button>
        {/if}
        {#if selection.removed.length}
          <Button variant="outline" size="sm" onclick={onrestore} disabled={busy} data-testid="atlas-restore">
            {m.atlas_restore({ count: selection.removed.length })}
          </Button>
        {/if}
      </div>
    </section>
  {/if}

  {#each over as cluster (cluster.id)}
    <section
      class="flex flex-col items-start gap-2 rounded-lg border border-line bg-bg2 p-3 text-xs leading-5 text-fg2"
      data-testid="atlas-hint-cluster"
      data-cluster={cluster.id}
    >
      <p>{m.atlas_hint_over({ cluster: clusterLabel(cluster.id), share: percent(cluster.liveShare) })}</p>
      <Button variant="outline" size="sm" onclick={(event) => onselectcluster(cluster.id, event.shiftKey)}>
        {m.atlas_hint_select()}
      </Button>
    </section>
  {/each}

  {#if outliers.length}
    <section class="flex flex-col gap-2" data-testid="atlas-outliers" data-count={model.outliers.length}>
      <h3 class="text-xs font-medium text-fg2">{m.atlas_outliers({ count: model.outliers.length })}</h3>
      <div class="flex flex-wrap gap-1">
        {#each outliers as index (index)}
          <button
            type="button"
            class="size-[46px] overflow-hidden rounded-sm border border-line bg-bg3 transition-colors duration-(--t-color) hover:border-line3 focus-visible:border-fg"
            title={m.atlas_outlier_score({ score: model.outlier[index]!.toFixed(2) })}
            onclick={() => onfocus(index)}
            data-asset={model.ids[index]}
          >
            <img crossorigin="anonymous" src={thumbnailUrl(index)} alt="" loading="lazy" class="size-full object-cover" />
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if clusters.length}
    <section class="flex flex-col" data-testid="atlas-clusters">
      <div class="flex items-baseline gap-2 pb-1">
        <h3 class="text-xs font-medium text-fg2">{m.atlas_clusters()}</h3>
        <span class="grow"></span>
        <span class="text-2xs text-fg3">{m.atlas_share_threshold({ share: percent(model.shareThreshold) })}</span>
      </div>
      {#each clusters as cluster (cluster.id)}
        <button
          type="button"
          class="grid h-7 grid-cols-[10px_minmax(0,1fr)_auto_36px] items-center gap-2 rounded-sm px-1.5 text-left text-xs text-fg2 transition-colors duration-(--t-color) hover:bg-bg2 hover:text-fg"
          onclick={(event) => onselectcluster(cluster.id, event.shiftKey)}
          data-testid="atlas-cluster"
          data-cluster={cluster.id}
          data-over={cluster.overRepresented || undefined}
        >
          <span class="size-2.5 rounded-full" style:background={swatch(cluster.id)}></span>
          <span class="truncate">{clusterLabel(cluster.id)}</span>
          <span class="text-fg3 tabular-nums">{cluster.liveSize}</span>
          <span class="text-right tabular-nums {cluster.overRepresented ? 'text-warn' : 'text-fg3'}">{percent(cluster.liveShare)}%</span>
        </button>
      {/each}
    </section>
  {/if}

  {#if model.removedCount}
    <label class="flex items-center gap-2 text-xs text-fg2">
      <Checkbox checked={showRemoved} onCheckedChange={(value) => onshowremoved(value === true)} data-testid="atlas-show-removed" />
      {m.atlas_show_removed({ count: model.removedCount })}
    </label>
  {/if}

  <p class="mt-auto text-2xs leading-4 text-fg3">{m.atlas_key_hints()}</p>
</aside>
