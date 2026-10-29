<script lang="ts">
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import type { Snippet } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { StageTriageSummary, TriagePhase } from "#lib/api/queries/triage.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 清洗 / 去重还不能分诊时占满内容区的状态块：没跑过（说明 + 运行选项 + 运行）、分析中、失败、失效（都能重跑）。
  // 就绪后页面自己画卡组，这个组件不渲染。
  interface Props {
    phase: TriagePhase;
    summary: StageTriageSummary | undefined;
    /** 读取状态失败。 */
    error: unknown;
    loading: boolean;
    /** 运行请求在路上。 */
    busy: boolean;
    /** 选项齐了、模型装好了。 */
    canRun: boolean;
    title: string;
    hint: string;
    runLabel: string;
    onrun: () => void;
    onretry: () => void;
    /** 就绪后重新配置时给：显示“取消”，回到卡组。 */
    oncancel?: () => void;
    /** 运行选项（没跑过、失败、失效、重新配置时显示）。 */
    options?: Snippet;
  }

  let { phase, summary, error, loading, busy, canRun, title, hint, runLabel, onrun, onretry, oncancel, options }: Props = $props();

  const runningText = $derived.by(() => {
    switch (summary?.review_status) {
      case "analyzing":
        return m.triage_analyzing({ count: summary.counts.input });
      case "auto_applying":
        return m.triage_auto_applying();
      default:
        return m.triage_preparing();
    }
  });
  const failure = $derived(summary?.review_error || summary?.run?.error_code || m.triage_failed_unknown());
</script>

<div class="flex flex-1 justify-center overflow-y-auto px-7 py-10" data-testid="triage-status" data-phase={loading ? "loading" : error ? "error" : phase}>
  <div class="flex w-full max-w-[560px] flex-col items-start gap-3">
    {#if loading}
      <span class="text-sm text-fg3" role="status">{m.triage_loading()}</span>
    {:else if error}
      <p class="text-sm text-danger" role="alert">{m.triage_load_failed({ reason: apiErrorMessage(error) })}</p>
      <Button variant="outline" size="sm" onclick={onretry}>{m.common_retry()}</Button>
    {:else if phase === "running"}
      <span class="flex items-center gap-2 text-sm text-fg" role="status" data-testid="triage-running">
        <LoaderCircleIcon class="size-4 animate-spin text-fg2" />{runningText}
      </span>
      <span class="text-xs text-fg2">{m.triage_running_hint()}</span>
    {:else}
      {#if phase === "failed"}
        <p class="text-sm text-danger" role="alert" data-testid="triage-failed">{m.triage_failed({ reason: failure })}</p>
      {:else if phase === "expired"}
        <p class="text-sm text-warn" role="alert" data-testid="triage-expired">{m.triage_expired()}</p>
      {:else}
        <h2 class="text-base font-medium">{title}</h2>
      {/if}
      <p class="text-xs leading-5 text-fg2">{hint}</p>
      {@render options?.()}
      <div class="flex items-center gap-2">
        <Button variant="primary" onclick={onrun} disabled={busy || !canRun} data-testid="triage-run">
          {#if busy}<LoaderCircleIcon class="animate-spin" />{/if}
          {phase === "idle" ? runLabel : m.triage_rerun()}
        </Button>
        {#if oncancel}<Button variant="ghost" onclick={oncancel}>{m.common_cancel()}</Button>{/if}
      </div>
    {/if}
  </div>
</div>
