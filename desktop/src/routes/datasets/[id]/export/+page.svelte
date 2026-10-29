<script lang="ts">
  import FolderSearchIcon from "@lucide/svelte/icons/folder-search";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { useExportEvents } from "#lib/api/queries/exports-live.svelte.ts";
  import {
    cancelExport,
    datasetExportsQuery,
    isActiveExport,
    previewExport,
    resumeExport,
    startExport,
    upsertExport,
    type DatasetExport,
    type ExportLayout,
    type ExportPlan,
    type ExportRename,
  } from "#lib/api/queries/exports.ts";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import ExportPlanView from "#lib/components/export/export-plan-view.svelte";
  import ExportRecord from "#lib/components/export/export-record.svelte";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import {
    EXPORT_REPEATS_MAX,
    EXPORT_REPEATS_MIN,
    exportFormDefaults,
    exportFormIssue,
    exportRequest,
    folderHint,
    type ExportForm,
    type ExportFormIssue,
  } from "#lib/domain/export-plan.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { usePlatform } from "#lib/platform/context.ts";

  // 导出段：把最终的图和标注复制成训练目录（kohya `{repeats}_{触发词}` 或平铺）。
  // 先预览计划（dry_run，不写文件），确认后开始；进度看实时任务表，状态变化看 dataset.export.updated。
  // 中断（后端重启）或目标名字被占用的导出可以续传。标题和阶段导航在 ../+layout.svelte。
  const api = useApi();
  const client = useQueryClient();
  const platform = usePlatform();
  const jobs = useJobs();
  const dataset = useDataset();
  const id = $derived(dataset.id);

  type Form = { -readonly [K in keyof ExportForm]: ExportForm[K] };

  const history = createQuery(() => datasetExportsQuery(api, id));
  useExportEvents(() => id);

  let form = $state<Form>(exportFormDefaults(""));
  let initialized = $state(false);
  let plan = $state.raw<ExportPlan | null>(null);
  let planKey = $state<string | null>(null);
  let planning = $state(false);
  let planError = $state<string | null>(null);
  let starting = $state(false);
  let acting = $state(false);
  let currentId = $state<string | null>(null);

  // 选项默认沿用上一次导出；历史读回来（或读失败）之后只初始化一次。
  $effect(() => {
    if (initialized || history.isPending || dataset.loading) return;
    const last = history.data?.[0]?.options ?? null;
    untrack(() => {
      form = { ...exportFormDefaults(dataset.triggerWord, last) };
      initialized = true;
    });
  });

  const request = $derived(exportRequest(form));
  const requestKey = $derived(JSON.stringify(request));
  const issue = $derived(exportFormIssue(form));
  const fresh = $derived(plan !== null && planKey === requestKey);
  const hint = $derived(folderHint(form, dataset.name));
  const records = $derived(history.data ?? []);
  const current = $derived(
    records.find((record) => record.export_id === currentId) ?? records.find((record) => isActiveExport(record.status)) ?? null,
  );
  const resumable = $derived(current ? null : (records.find((record) => record.resumable && record.status === "interrupted") ?? null));
  const pinned = $derived(current ?? resumable);
  const past = $derived(records.filter((record) => record.export_id !== pinned?.export_id));
  const exporting = $derived(current !== null && isActiveExport(current.status));
  const canStart = $derived(
    fresh && plan !== null && !plan.target_exists && plan.blockers.length === 0 && plan.image_count > 0 && !starting && !exporting && issue === null,
  );

  const ISSUES: Record<ExportFormIssue, () => string> = {
    target_required: m.export_issue_target_required,
    target_not_absolute: m.export_issue_target_not_absolute,
    trigger_required: m.export_issue_trigger_required,
    repeats_invalid: m.export_issue_repeats_invalid,
  };

  // 宿主的失败都报成 PlatformCapabilityError（取消选择是 null，不算失败）。
  async function pickTarget() {
    try {
      const path = await platform.selectDirectory("export_target");
      if (path) form.target = path;
    } catch {
      toast.error(m.export_target_pick_failed());
    }
  }

  async function preview() {
    if (issue || planning) return;
    planning = true;
    planError = null;
    const key = requestKey;
    try {
      plan = await previewExport(api, id, request);
      planKey = key;
    } catch (error) {
      planError = apiErrorMessage(error);
      plan = null;
      planKey = null;
    } finally {
      planning = false;
    }
  }

  async function start() {
    if (!canStart) return;
    starting = true;
    try {
      const record = await startExport(api, id, request);
      // 页面自己给反馈：成功时不再弹通用的任务完成提示。
      jobs.silence(record.job_id);
      upsertExport(client, record);
      currentId = record.export_id;
      plan = null;
      planKey = null;
      toast(m.export_started());
    } catch (error) {
      toast.error(m.export_start_failed({ reason: apiErrorMessage(error) }));
      // 目录变了、来源离线……让计划重新算一次。
      planKey = null;
    } finally {
      starting = false;
    }
  }

  async function act(action: () => Promise<DatasetExport>, failure: (reason: string) => string) {
    if (acting) return;
    acting = true;
    try {
      const record = await action();
      upsertExport(client, record);
      return record;
    } catch (error) {
      toast.error(failure(apiErrorMessage(error)));
    } finally {
      acting = false;
    }
  }

  async function cancel(record: DatasetExport) {
    const result = await act(() => cancelExport(api, record.export_id), (reason) => m.export_cancel_failed({ reason }));
    if (result?.status === "cancelled") toast(m.export_cancelled());
  }

  async function resume(record: DatasetExport) {
    const result = await act(() => resumeExport(api, record.export_id), (reason) => m.export_resume_failed({ reason }));
    if (result) {
      jobs.silence(result.job_id);
      currentId = result.export_id;
    }
  }

  async function reveal(record: DatasetExport) {
    try {
      await platform.revealInFileManager(record.output_path);
    } catch {
      toast.error(m.export_reveal_failed());
    }
  }

  const layouts = [
    { value: "kohya" as const, label: m.export_layout_kohya() },
    { value: "flat" as const, label: m.export_layout_flat() },
  ];
  const renames = [
    { value: "none" as const, label: m.export_rename_none() },
    { value: "sequential" as const, label: m.export_rename_sequential() },
  ];

  const group = m.keys_group_export;
  useBindings("page", () => [
    { id: "export.preview", label: m.export_preview, group, palette: true, when: () => issue === null && !planning, run: () => void preview() },
    { id: "export.start", label: m.export_start, group, palette: true, when: () => canStart, run: () => void start() },
    ...(platform.capabilities.selectDirectory
      ? [{ id: "export.pick", label: m.export_target_pick, group, palette: true, run: () => void pickTarget() }]
      : []),
  ]);
</script>

{#snippet field(label: string, control: import("svelte").Snippet, note?: string)}
  <div class="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-3">
    <span class="pt-1.5 text-xs text-fg2">{label}</span>
    <div class="flex min-w-0 flex-col gap-1">
      {@render control()}
      {#if note}<span class="text-2xs text-fg3">{note}</span>{/if}
    </div>
  </div>
{/snippet}

{#snippet targetControl()}
  <div class="flex gap-2">
    <Input
      bind:value={form.target}
      class="h-8 min-w-0 flex-1 font-mono text-xs"
      placeholder={m.export_target_placeholder()}
      aria-label={m.export_target()}
      spellcheck={false}
      data-testid="export-target"
    />
    {#if platform.capabilities.selectDirectory}
      <Button variant="outline" size="sm" onclick={pickTarget} data-testid="export-pick"><FolderSearchIcon />{m.export_target_pick()}</Button>
    {/if}
  </div>
{/snippet}

{#snippet layoutControl()}
  <Segmented options={layouts} value={form.layout} onchange={(next: ExportLayout) => (form.layout = next)} label={m.export_layout()} size="sm" class="self-start" data-testid="export-layout" />
{/snippet}

{#snippet repeatsControl()}
  <Input
    type="number"
    min={EXPORT_REPEATS_MIN}
    max={EXPORT_REPEATS_MAX}
    step={1}
    value={String(form.repeats)}
    oninput={(event) => (form.repeats = Number((event.currentTarget as HTMLInputElement).value))}
    class="h-8 w-24 text-xs tabular-nums"
    aria-label={m.export_repeats()}
    data-testid="export-repeats"
  />
{/snippet}

{#snippet triggerControl()}
  <Input bind:value={form.trigger} class="h-8 text-xs" placeholder={m.export_trigger_placeholder()} aria-label={m.export_trigger()} data-testid="export-trigger" />
{/snippet}

{#snippet folderControl()}
  <Input bind:value={form.folder} class="h-8 font-mono text-xs" placeholder={m.export_folder_placeholder()} aria-label={m.export_folder()} data-testid="export-folder" />
{/snippet}

{#snippet renameControl()}
  <Segmented options={renames} value={form.rename} onchange={(next: ExportRename) => (form.rename = next)} label={m.export_rename()} size="sm" class="self-start" data-testid="export-rename" />
{/snippet}

{#snippet check(checked: boolean, onchange: (value: boolean) => void, label: string, testid: string)}
  <label class="flex items-center gap-2 text-xs text-fg">
    <Checkbox {checked} onCheckedChange={(value) => onchange(value === true)} data-testid={testid} />
    {label}
  </label>
{/snippet}

{#snippet captionControl()}
  <div class="flex flex-col gap-2 pt-1">
    {@render check(form.captions, (value) => (form.captions = value), m.export_captions(), "export-captions")}
    {#if form.captions}
      {@render check(form.pinTrigger, (value) => (form.pinTrigger = value), m.export_pin_trigger(), "export-pin-trigger")}
      {@render check(form.underscores, (value) => (form.underscores = value), m.export_underscores(), "export-underscores")}
      <Input bind:value={form.blacklist} class="h-8 text-xs" placeholder={m.export_blacklist_placeholder()} aria-label={m.export_blacklist()} data-testid="export-blacklist" />
    {/if}
  </div>
{/snippet}

<div class="grid min-h-0 flex-1 grid-cols-[minmax(380px,460px)_minmax(0,1fr)] overflow-hidden" data-testid="export">
  <form
    class="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line px-7 py-5"
    onsubmit={(event) => {
      event.preventDefault();
      void preview();
    }}
    data-testid="export-form"
  >
    {@render field(m.export_target(), targetControl)}
    {@render field(m.export_layout(), layoutControl, form.layout === "kohya" ? m.export_layout_kohya_hint() : m.export_layout_flat_hint())}
    {#if form.layout === "kohya"}
      {@render field(m.export_repeats(), repeatsControl)}
      {@render field(m.export_trigger(), triggerControl)}
    {/if}
    {@render field(m.export_folder(), folderControl, hint ? m.export_folder_hint({ name: hint }) : undefined)}
    {@render field(m.export_rename(), renameControl, form.rename === "sequential" ? m.export_rename_sequential_hint() : undefined)}
    {@render field(m.export_captions_section(), captionControl)}

    <!-- 还没填目录只是提示；其余是填错了。 -->
    {#if issue}
      <p class="text-xs {issue === 'target_required' ? 'text-fg3' : 'text-warn'}" role="status" data-testid="export-issue">{ISSUES[issue]()}</p>
    {/if}
    {#if planError}<p class="text-xs text-danger" role="alert" data-testid="export-plan-error">{planError}</p>{/if}

    <div class="flex items-center gap-2">
      <Button type="submit" variant="outline" disabled={issue !== null || planning} data-testid="export-preview">
        {#if planning}<LoaderCircleIcon class="animate-spin" />{/if}{m.export_preview()}
      </Button>
      <Button variant="primary" disabled={!canStart} onclick={start} data-testid="export-start">
        {#if starting}<LoaderCircleIcon class="animate-spin" />{/if}{m.export_start()}
      </Button>
    </div>
  </form>

  <div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-7 py-5">
    <!-- 这一页开始的导出、进行中的导出，或者可以续传的中断导出（后端重启过）。 -->
    {#if pinned}
      <ExportRecord
        record={pinned}
        job={isActiveExport(pinned.status) ? jobs.get(pinned.job_id) : null}
        prominent
        canReveal={platform.capabilities.revealInFileManager}
        busy={acting}
        oncancel={cancel}
        onresume={resume}
        onreveal={reveal}
      />
    {/if}

    {#if plan}
      <ExportPlanView {plan} stale={!fresh} />
    {:else if !pinned}
      <p class="text-xs leading-5 text-fg3" data-testid="export-plan-empty">{m.export_plan_hint()}</p>
    {/if}

    <section class="flex flex-col" data-testid="export-history">
      <h2 class="mb-1 text-xs font-medium text-fg2">{m.export_history()}</h2>
      {#if history.isPending}
        <span class="text-xs text-fg3" role="status">{m.export_history_loading()}</span>
      {:else if history.isError}
        <p class="flex items-center gap-3 text-xs text-danger" role="alert">
          {apiErrorMessage(history.error)}
          <Button variant="ghost" size="xs" onclick={() => history.refetch()}>{m.common_retry()}</Button>
        </p>
      {:else if past.length === 0}
        <span class="text-xs text-fg3">{m.export_history_empty()}</span>
      {:else}
        {#each past as record (record.export_id)}
          <ExportRecord
            {record}
            job={isActiveExport(record.status) ? jobs.get(record.job_id) : null}
            canReveal={platform.capabilities.revealInFileManager}
            busy={acting}
            oncancel={cancel}
            onresume={resume}
            onreveal={reveal}
          />
        {/each}
      {/if}
    </section>
  </div>
</div>
