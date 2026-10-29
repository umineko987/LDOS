<script lang="ts">
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { ModelGate } from "#lib/components/model-install/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import type { AtlasResponse } from "#lib/domain/atlas-model.ts";
  import type { AtlasPhase, AtlasProgressView, AtlasViewState } from "#lib/domain/atlas-ops.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 地图的运行状态：有地图时是画布上方的一条横幅，没有地图时占满画布区域居中显示。

  interface Props {
    state: AtlasViewState;
    atlas: AtlasResponse | undefined;
    progress: AtlasProgressView | null;
    /** 读取地图失败时的错误。 */
    error: unknown;
    /** 有地图可画：状态显示成横幅。 */
    hasMap: boolean;
    busy: boolean;
    onrun: (force: boolean) => void;
    oncancel: () => void;
    onretry: () => void;
  }

  let { state, atlas, progress, error, hasMap, busy, onrun, oncancel, onretry }: Props = $props();

  const PHASES: Record<AtlasPhase, () => string> = {
    queued: m.atlas_phase_queued,
    preparing: m.atlas_phase_preparing,
    hashing: m.atlas_phase_hashing,
    read: m.atlas_phase_read,
    embed: m.atlas_phase_embed,
    pca: m.atlas_phase_pca,
    neighbors: m.atlas_phase_neighbors,
    layout: m.atlas_phase_layout,
    cluster: m.atlas_phase_cluster,
    write: m.atlas_phase_write,
  };

  const UNAVAILABLE: Readonly<Record<string, () => string>> = {
    dedup_disabled: m.atlas_unavailable_dedup_disabled,
    python_missing: m.atlas_unavailable_python_missing,
    worker_missing: m.atlas_unavailable_worker_missing,
  };

  const unavailableText = $derived.by(() => {
    const reason = atlas?.availability.reason ?? "";
    return Object.hasOwn(UNAVAILABLE, reason) ? UNAVAILABLE[reason]!() : m.atlas_unavailable();
  });
  const phaseText = $derived(progress ? (progress.phase ? PHASES[progress.phase]() : progress.label) : "");
</script>

{#snippet gate()}
  <!-- 缺 DINOv2 时就地安装（含许可确认和进度）；装好后显示重新生成。 -->
  <ModelGate keys={["dino"]} title={m.atlas_gate_title()} class="w-full">
    <div class="flex items-center gap-3">
      <span class="text-xs text-fg2">{m.atlas_gate_ready()}</span>
      <Button variant="outline" size="sm" onclick={() => onrun(true)} disabled={busy} data-testid="atlas-gate-retry">{m.atlas_retry()}</Button>
    </div>
  </ModelGate>
{/snippet}

{#if state === "ready"}
  <!-- 就绪时不占位置。 -->
{:else if hasMap}
  <div
    class="flex min-h-row flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-bg1 px-5 py-1.5 text-xs"
    role="status"
    data-testid="atlas-status"
    data-state={state}
  >
    {#if state === "running"}
      <span class="text-fg">{m.atlas_running()}</span>
      <span class="text-fg2" data-testid="atlas-progress" data-phase={progress?.phase} data-done={progress?.done} data-total={progress?.total}>
        {phaseText}{#if progress?.total}<span class="ml-1.5 text-fg3 tabular-nums">{m.atlas_progress_count({ done: progress.done ?? 0, total: progress.total })}</span>{/if}
      </span>
      {#if progress?.fraction !== null && progress?.fraction !== undefined}
        <Progress class="w-40" value={Math.round(progress.fraction * 100)} max={100} />
      {/if}
      <span class="grow"></span>
      <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy} data-testid="atlas-cancel">{m.atlas_cancel()}</Button>
    {:else if state === "stale"}
      <span class="text-fg2">{m.atlas_stale({ added: atlas?.delta.added ?? 0, changed: atlas?.delta.changed ?? 0 })}</span>
      <span class="grow"></span>
      <Button variant="outline" size="sm" onclick={() => onrun(false)} disabled={busy} data-testid="atlas-rerun">{m.atlas_rerun()}</Button>
    {:else if state === "failed"}
      <span class="text-danger">{m.atlas_failed({ reason: atlas?.error?.message || m.api_error_unexpected() })}</span>
      <span class="grow"></span>
      <Button variant="outline" size="sm" onclick={() => onrun(true)} disabled={busy} data-testid="atlas-rerun">{m.atlas_retry()}</Button>
    {:else if state === "gate"}
      <div class="flex grow py-1" data-testid="atlas-gate">{@render gate()}</div>
    {:else if state === "unavailable"}
      <span class="text-fg2">{unavailableText}</span>
    {/if}
  </div>
{:else}
  <div class="flex flex-1 items-center justify-center p-8" data-testid="atlas-status" data-state={state}>
    <div class="flex max-w-[440px] flex-col items-start gap-3" role="status">
      {#if state === "loading"}
        <span class="text-sm text-fg3">{m.atlas_loading()}</span>
      {:else if state === "error"}
        <span class="text-sm text-danger" role="alert">{m.atlas_load_failed({ reason: apiErrorMessage(error) })}</span>
        <Button variant="outline" size="sm" onclick={onretry}>{m.atlas_retry()}</Button>
      {:else if state === "unavailable"}
        <span class="text-sm text-fg">{m.atlas_title()}</span>
        <span class="text-xs text-fg2">{unavailableText}</span>
      {:else if state === "gate"}
        <div class="flex w-full flex-col items-start gap-3" data-testid="atlas-gate">{@render gate()}</div>
      {:else if state === "running"}
        <span class="text-sm text-fg">{m.atlas_running()}</span>
        <span class="text-xs text-fg2" data-testid="atlas-progress" data-phase={progress?.phase} data-done={progress?.done} data-total={progress?.total}>
          {phaseText}{#if progress?.total}<span class="ml-1.5 text-fg3 tabular-nums">{m.atlas_progress_count({ done: progress.done ?? 0, total: progress.total })}</span>{/if}
        </span>
        {#if progress?.fraction !== null && progress?.fraction !== undefined}
          <Progress class="w-64" value={Math.round(progress.fraction * 100)} max={100} />
        {/if}
        <Button variant="outline" size="sm" onclick={oncancel} disabled={busy} data-testid="atlas-cancel">{m.atlas_cancel()}</Button>
      {:else if state === "failed"}
        <span class="text-sm text-fg">{m.atlas_title()}</span>
        <span class="text-xs text-danger">{m.atlas_failed({ reason: atlas?.error?.message || m.api_error_unexpected() })}</span>
        <Button variant="primary" size="sm" onclick={() => onrun(true)} disabled={busy} data-testid="atlas-run">{m.atlas_retry()}</Button>
      {:else}
        <span class="text-sm text-fg">{m.atlas_none_title()}</span>
        <span class="text-xs leading-5 text-fg2">{m.atlas_none_body()}</span>
        <Button variant="primary" size="sm" onclick={() => onrun(state !== "none")} disabled={busy} data-testid="atlas-run">
          {m.atlas_run()}
        </Button>
      {/if}
    </div>
  </div>
{/if}
