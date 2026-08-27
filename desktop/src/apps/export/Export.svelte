<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { createPlatformAdapter } from "../../core/platform/adapter";
  import type { ApplicationId } from "../../core/applications/definitions";
  import { createGalleryService } from "../gallery/service";
  import type { GalleryDirectoryEntry, GallerySourceSummary } from "../gallery/model";
  import { consumePendingExportSource } from "./intent";
  import {
    EXPORT_BLOCKER_LABELS,
    EXPORT_STATE_LABELS,
    EXPORT_TERMINAL_STATES,
    formatExportBytes,
    type ExportJobState,
    type ExportJobSummary,
  } from "./model";
  import { createExportController } from "./controller";
  import { createExportStore, type ExportAppState } from "./state";
  import "./export.css";

  let {
    api,
    onNavigate,
    polling,
  }: {
    api?: ApiClient;
    onNavigate?: (appId: ApplicationId) => void;
    polling?: import("../../core/polling/service").PollingService | null;
  } = $props();

  const platform = untrack(() => createPlatformAdapter());
  const runtime = untrack(() => {
    const store = createExportStore();
    const controller = api
      ? createExportController(api, store, undefined, polling ?? null)
      : null;
    return { store, controller };
  });
  const { store, controller } = runtime;
  const snapshot: ExportAppState | null = $derived(controller ? $store : null);
  const available = $derived(controller !== null);

  // ---- 新建导出表单（组件本地草稿，不进 store） ----
  type SelectionDraft = {
    sourceId: string;
    sourceLabel: string;
    /** null 表示整个来源。 */
    directoryId: string | null;
    directoryLabel: string;
    includeDescendants: boolean;
    outputAlias: string;
  };

  let newExportOpen = $state(false);
  let targetPath = $state("");
  let targetError = $state<string | null>(null);
  let selections = $state<SelectionDraft[]>([]);
  let aliasErrors = $state<Record<string, string>>({});
  let createPhase = $state<"idle" | "creating" | "blocked" | "error">("idle");
  let createError = $state<string | null>(null);
  let createdBlockers = $state<{ code: string; count: number }[]>([]);

  // ---- 来源选择器 ----
  let pickerOpen = $state(false);
  let pickerSources = $state<readonly GallerySourceSummary[]>([]);
  let pickerPhase = $state<"idle" | "loading" | "error">("idle");
  let pickerDirectory = $state<GalleryDirectoryEntry | null>(null);
  let pickerChildren = $state<readonly GalleryDirectoryEntry[]>([]);
  let pickerTrail = $state<readonly GalleryDirectoryEntry[]>([]);
  let pickerError = $state<string | null>(null);

  const galleryService = untrack(() => (api ? createGalleryService(api) : null));


  async function loadPickerSources(): Promise<void> {
    if (!galleryService) return;
    pickerPhase = "loading";
    pickerError = null;
    try {
      pickerSources = await galleryService.listSources(new AbortController().signal);
      pickerPhase = "idle";
    } catch {
      pickerPhase = "error";
      pickerError = "无法加载图库来源";
    }
  }

  async function browseDirectory(
    directory: GalleryDirectoryEntry | null,
    sourceId: string,
    rootDirectoryId?: string,
  ): Promise<void> {
    if (!galleryService) return;
    pickerPhase = "loading";
    pickerError = null;
    try {
      const page = await galleryService.listDirectoryEntries(
        {
          directoryId: directory?.directory_id ?? rootDirectoryId ?? "",
          includeDescendants: false,
          txtState: null,
          query: "",
          directoryCursor: null,
          assetCursor: null,
        },
        new AbortController().signal,
      );
      pickerDirectory = directory;
      pickerChildren = page.directories.filter((entry) => entry.source_id === sourceId);
      if (directory === null) {
        pickerTrail = [];
      } else {
        pickerTrail = [...pickerTrail.slice(0, pickerTrail.findIndex((entry) => entry.directory_id === directory.directory_id) + 1), directory].filter(
          (entry, index, list) => list.findIndex((other) => other.directory_id === entry.directory_id) === index,
        );
      }
      pickerPhase = "idle";
    } catch {
      pickerPhase = "error";
      pickerError = "无法加载子目录";
    }
  }

  function openPicker(): void {
    pickerOpen = true;
    if (pickerSources.length === 0) void loadPickerSources();
  }

  function closePicker(): void {
    pickerOpen = false;
  }

  function confirmPickerSelection(): void {
    const source = pickerSources.find((entry) => entry.source_id === pickerDirectory?.source_id);
    if (!source || !pickerDirectory) return;
    const directoryLabel = pickerDirectory.relative_path || "（来源根目录）";
    const alias = selections.some((selection) => selection.sourceId === source.source_id)
      ? `${source.display_name}-${pickerDirectory.name}`
      : source.display_name;
    selections = [
      ...selections,
      {
        sourceId: source.source_id,
        sourceLabel: source.display_name,
        directoryId: pickerDirectory.directory_id,
        directoryLabel,
        includeDescendants: true,
        outputAlias: alias,
      },
    ];
    pickerOpen = false;
  }

  function goUpOneLevel(): void {
    const current = pickerDirectory;
    if (current === null) return;
    const source = pickerSources.find((entry) => entry.source_id === current.source_id);
    const parent = pickerTrail.length > 1 ? pickerTrail[pickerTrail.length - 2] : null;
    void browseDirectory(parent, current.source_id, source?.root_directory_id ?? undefined);
  }

  function removeSelection(index: number): void {
    selections = selections.filter((_, position) => position !== index);
  }

  function updateSelectionAlias(index: number, alias: string): void {
    selections = selections.map((selection, position) =>
      position === index ? { ...selection, outputAlias: alias } : selection,
    );
  }

  function toggleSelectionDescendants(index: number, includeDescendants: boolean): void {
    selections = selections.map((selection, position) =>
      position === index ? { ...selection, includeDescendants } : selection,
    );
  }

  async function chooseTargetDirectory(): Promise<void> {
    if (!platform.capabilities.selectDirectory) return;
    try {
      const picked = await platform.selectDirectory("export_target");
      if (picked !== null) {
        targetPath = picked;
        targetError = null;
      }
    } catch {
      targetError = "无法打开本机目录选择";
    }
  }

  function openNewExport(): void {
    newExportOpen = true;
    createPhase = "idle";
    createError = null;
    createdBlockers = [];
    const intent = consumePendingExportSource();
    if (intent !== null) {
      // Gallery 的“导出此目录”预选：来源已由意图携带。
      selections = [
        {
          sourceId: intent.sourceId,
          sourceLabel: intent.sourceLabel ?? intent.suggestedAlias ?? "来源",
          directoryId: intent.directoryId,
          directoryLabel: intent.directoryId === null ? "（整个来源）" : "（当前目录）",
          includeDescendants: intent.includeDescendants,
          outputAlias: intent.suggestedAlias ?? intent.sourceId,
        },
      ];
    }
  }

  function closeNewExport(): void {
    newExportOpen = false;
    targetError = null;
    createPhase = "idle";
    createError = null;
    createdBlockers = [];
    selections = [];
    aliasErrors = {};
  }

  async function submitCreate(): Promise<void> {
    if (!controller) return;
    targetError = targetPath.trim().length === 0 ? "请填写或选择目标目录" : null;
    const aliasIssues: Record<string, string> = {};
    for (const [index, selection] of selections.entries()) {
      const trimmed = selection.outputAlias.trim();
      if (trimmed.length === 0 || trimmed.length > 60) {
        aliasIssues[String(index)] = "别名需为 1-60 个字符";
      }
    }
    aliasErrors = aliasIssues;
    if (targetError !== null || Object.keys(aliasIssues).length > 0 || selections.length === 0) return;
    createPhase = "creating";
    createError = null;
    createdBlockers = [];
    try {
      const result = await controller.service.createExport(targetPath.trim(), selections.map((selection) => ({
        sourceId: selection.sourceId,
        directoryId: selection.directoryId,
        includeDescendants: selection.includeDescendants,
        outputAlias: selection.outputAlias.trim(),
      })));
      store.patchJobSummary(result.job);
      if (result.blockers.length > 0) {
        createPhase = "blocked";
        createdBlockers = [...result.blockers];
      } else {
        createPhase = "idle";
        newExportOpen = false;
        selections = [];
        await controller.openDetail(result.job.export_id);
      }
    } catch (error) {
      createPhase = "error";
      createError = error instanceof Error ? error.message : "export_unknown_error";
    }
  }

  function statusLabel(status: ExportJobState): string {
    return EXPORT_STATE_LABELS[status];
  }

  function isTerminal(job: ExportJobSummary): boolean {
    return EXPORT_TERMINAL_STATES.includes(job.status);
  }

  function formatTimestamp(epochSeconds: number): string {
    // 后端时间戳为 epoch 秒；Date 需要毫秒。
    return new Date(epochSeconds * 1000).toLocaleString();
  }

  function shortId(exportId: string): string {
    return exportId.length > 12 ? `${exportId.slice(0, 12)}…` : exportId;
  }

  async function operation(kind: "start" | "pause" | "resume" | "discard", exportId: string): Promise<void> {
    if (!controller) return;
    if (kind === "discard" && !confirmDiscard) {
      confirmDiscard = exportId;
      return;
    }
    await controller[`${kind}Job`](exportId);
    await controller.refreshDetail();
    if (kind === "discard") confirmDiscard = null;
  }

  let confirmDiscard = $state<string | null>(null);

  onMount(() => {
    controller?.activate();
    return () => controller?.destroy();
  });
</script>

<section
  class="export-app"
  data-export-app
  data-domain-owner="export"
  data-preview-availability="live"
  aria-labelledby="export-heading"
>
  <header class="export-header">
    <div>
      <p>数据集导出</p>
      <h1 id="export-heading">确定性导出工作区</h1>
    </div>
    <div class="export-header-actions">
      <button type="button" class="export-button" onclick={openNewExport} disabled={!available}>
        新建导出
      </button>
      <button
        type="button"
        class="export-button"
        onclick={() => controller && void controller.refreshJobs()}
        disabled={!available || snapshot?.jobs.phase === "loading"}
      >
        刷新
      </button>
    </div>
  </header>

  {#if !available}
    <p class="export-unavailable" role="status">后端连接不可用；导出功能需要运行中的后端服务。</p>
  {:else if snapshot}
    <div class="export-layout">
      <aside class="export-jobs" aria-labelledby="export-jobs-heading">
        <h2 id="export-jobs-heading">导出任务</h2>
        {#if snapshot.jobs.phase === "loading" && snapshot.jobs.jobs.length === 0}
          <p class="export-hint" role="status">正在加载任务列表…</p>
        {:else if snapshot.jobs.phase === "error"}
          <p class="export-hint export-hint--error" role="alert">任务列表加载失败：{snapshot.jobs.errorCode ?? "未知错误"}</p>
        {:else if snapshot.jobs.jobs.length === 0}
          <p class="export-hint">暂无导出任务；点击“新建导出”开始。</p>
        {:else}
          <ul class="export-job-list">
            {#each snapshot.jobs.jobs as job (job.export_id)}
              <li>
                <button
                  type="button"
                  class="export-job-row"
                  class:is-active={snapshot.detail.exportId === job.export_id}
                  onclick={() => controller && void controller.openDetail(job.export_id)}
                  aria-current={snapshot.detail.exportId === job.export_id ? "true" : undefined}
                >
                  <span class="export-job-id">{shortId(job.export_id)}</span>
                  <span class="export-job-status" data-status={job.status}>{statusLabel(job.status)}</span>
                  <span class="export-job-counts">{job.committed_sample_count}/{job.sample_count} 样本</span>
                  <span class="export-job-time">{formatTimestamp(job.updated_at)}</span>
                </button>
              </li>
            {/each}
          </ul>
          {#if snapshot.jobs.mayHaveMore}
            <button type="button" class="export-button export-button--ghost" onclick={() => controller && void controller.loadMoreJobs()}>
              加载更多
            </button>
          {/if}
        {/if}
      </aside>

      <main class="export-main" aria-labelledby="export-detail-heading">
        {#if newExportOpen}
          <section class="export-form" aria-labelledby="export-form-heading">
            <header>
              <h2 id="export-form-heading">新建数据集导出</h2>
              <button type="button" class="export-button export-button--ghost" onclick={closeNewExport}>关闭</button>
            </header>
            <form onsubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
              <fieldset>
                <legend>01 · 目标目录</legend>
                <div class="export-target-row">
                  <label class="export-field">
                    <span>目标目录路径</span>
                    <input
                      type="text"
                      bind:value={targetPath}
                      placeholder="导出文件将复制到该目录"
                      aria-describedby={targetError ? "export-target-error" : undefined}
                    />
                  </label>
                  {#if platform.capabilities.selectDirectory}
                    <button type="button" class="export-button" onclick={() => void chooseTargetDirectory()}>选择目录</button>
                  {:else}
                    <button type="button" class="export-button" disabled title="浏览器模式不支持本机目录选择">选择目录</button>
                  {/if}
                </div>
                {#if targetError}
                  <p id="export-target-error" class="export-field-error" role="alert">{targetError}</p>
                {/if}
              </fieldset>

              <fieldset>
                <legend>02 · 导出来源（完整图库目录）</legend>
                {#if selections.length === 0}
                  <p class="export-hint">尚未选择来源目录；图片与同名 TXT 将按原相对目录完整复制。</p>
                {:else}
                  <ul class="export-selections">
                    {#each selections as selection, index (index)}
                      <li class="export-selection">
                        <div class="export-selection-head">
                          <strong>{selection.sourceLabel}</strong>
                          <span class="export-selection-path">{selection.directoryLabel}</span>
                          <button type="button" class="export-button export-button--ghost" onclick={() => removeSelection(index)}>移除</button>
                        </div>
                        <div class="export-selection-config">
                          <label class="export-field">
                            <span>来源别名</span>
                            <input
                              type="text"
                              value={selection.outputAlias}
                              oninput={(event) => updateSelectionAlias(index, event.currentTarget.value)}
                              aria-invalid={aliasErrors[String(index)] ? "true" : undefined}
                            />
                          </label>
                          <label class="export-check">
                            <input
                              type="checkbox"
                              checked={selection.includeDescendants}
                              onchange={(event) => toggleSelectionDescendants(index, event.currentTarget.checked)}
                            />
                            <span>包含子目录</span>
                          </label>
                        </div>
                        {#if aliasErrors[String(index)]}
                          <p class="export-field-error" role="alert">{aliasErrors[String(index)]}</p>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
                <button type="button" class="export-button export-button--ghost" onclick={openPicker}>添加来源目录</button>

                {#if pickerOpen}
                  <div class="export-picker" role="group" aria-label="来源目录选择器">
                    {#if pickerPhase === "loading"}
                      <p class="export-hint" role="status">正在加载…</p>
                    {:else if pickerPhase === "error"}
                      <p class="export-hint export-hint--error" role="alert">{pickerError ?? "加载失败"}</p>
                    {:else}
                      {#if pickerDirectory === null}
                        <h3>选择来源</h3>
                        <ul class="export-picker-list">
                          {#each pickerSources as source (source.source_id)}
                            <li>
                              <button type="button" class="export-picker-row" onclick={() => void browseDirectory(null, source.source_id, source.root_directory_id ?? undefined)} disabled={!source.root_directory_id}>
                                <strong>{source.display_name}</strong>
                                <span>{source.root_directory_id ? "浏览目录" : "未完成扫描"}</span>
                              </button>
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <h3>{pickerDirectory.relative_path || "来源根目录"}</h3>
                        <p class="export-picker-breadcrumb">
                          来源根
                          {#each pickerTrail as entry (entry.directory_id)}
                            <span aria-hidden="true"> › </span>
                            <button type="button" class="export-picker-crumb" onclick={() => void browseDirectory(entry, entry.source_id)}>{entry.name}</button>
                          {/each}
                        </p>
                        {#if pickerChildren.length === 0}
                          <p class="export-hint">没有子目录。</p>
                        {:else}
                          <ul class="export-picker-list">
                            {#each pickerChildren as child (child.directory_id)}
                              <li>
                                <button type="button" class="export-picker-row" onclick={() => void browseDirectory(child, child.source_id)}>
                                  <strong>{child.name}</strong>
                                  <span>{child.recursive_asset_count} 项</span>
                                </button>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                        <div class="export-picker-actions">
                          <button type="button" class="export-button" onclick={confirmPickerSelection}>选择此目录</button>
                          <button type="button" class="export-button export-button--ghost" onclick={goUpOneLevel}>
                            上一级
                          </button>
                        </div>
                      {/if}
                    {/if}
                    <button type="button" class="export-button export-button--ghost" onclick={closePicker}>取消选择器</button>
                  </div>
                {/if}
              </fieldset>

              <fieldset>
                <legend>03 · 预检与开始</legend>
                <p class="export-hint">创建任务会先执行预检；同名 TXT 缺失、空白或编码异常，以及目标路径冲突都会阻止导出。</p>
                {#if createPhase === "creating"}
                  <p class="export-hint" role="status">正在预检…</p>
                {:else if createPhase === "blocked"}
                  <div class="export-blockers" role="alert">
                    <h3>预检未通过</h3>
                    <ul>
                      {#each createdBlockers as blocker (blocker.code)}
                        <li>{EXPORT_BLOCKER_LABELS[blocker.code as keyof typeof EXPORT_BLOCKER_LABELS] ?? blocker.code} × {blocker.count}</li>
                      {/each}
                    </ul>
                    {#if onNavigate}
                      <button type="button" class="export-button" onclick={() => onNavigate("gallery")}>返回图库修复</button>
                    {/if}
                  </div>
                {:else if createPhase === "error"}
                  <p class="export-hint export-hint--error" role="alert">创建失败：{createError ?? "未知错误"}</p>
                {/if}
                <button type="submit" class="export-button export-button--primary" disabled={createPhase === "creating"}>
                  创建并预检
                </button>
              </fieldset>
            </form>
          </section>
        {:else if snapshot.detail.phase === "loading"}
          <h2 id="export-detail-heading">任务详情</h2>
          <p class="export-hint" role="status">正在加载任务详情…</p>
        {:else if snapshot.detail.phase === "error"}
          <h2 id="export-detail-heading">任务详情</h2>
          <p class="export-hint export-hint--error" role="alert">详情加载失败：{snapshot.detail.errorCode ?? "未知错误"}</p>
        {:else if snapshot.detail.job}
          {@const job = snapshot.detail.job}
          <section class="export-detail" aria-labelledby="export-detail-heading">
            <header class="export-detail-head">
              <div>
                <h2 id="export-detail-heading">任务 {shortId(job.export_id)}</h2>
                <p class="export-job-status" data-status={job.status}>{statusLabel(job.status)}</p>
              </div>
            </header>
            <dl class="export-facts">
              <div><dt>冻结样本</dt><dd>{job.sample_count}</dd></div>
              <div><dt>已暂存</dt><dd>{job.staged_sample_count}</dd></div>
              <div><dt>已提交</dt><dd>{job.committed_sample_count}</dd></div>
              <div><dt>图片体积</dt><dd>{formatExportBytes(job.image_bytes)}</dd></div>
              <div><dt>TXT 体积</dt><dd>{formatExportBytes(job.txt_bytes)}</dd></div>
              <div><dt>创建时间</dt><dd>{formatTimestamp(job.created_at)}</dd></div>
              <div><dt>更新时间</dt><dd>{formatTimestamp(job.updated_at)}</dd></div>
              {#if job.error_class}
                <div><dt>错误类别</dt><dd>{job.error_class}</dd></div>
              {/if}
            </dl>
            {#if job.sources.length > 0}
              <section class="export-detail-sources">
                <h3>导出来源</h3>
                <ul>
                  {#each job.sources as source (source.directory_id)}
                    <li>
                      <strong>{source.output_alias}</strong>
                      <span>{source.include_descendants ? "包含子目录" : "仅当前目录"}</span>
                      {#if onNavigate}
                        <button type="button" class="export-button export-button--ghost" onclick={() => onNavigate("gallery")}>在图库中查看来源</button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}
            {#if job.blockers.length > 0}
              <section class="export-blockers" role="alert">
                <h3>阻断项</h3>
                <ul>
                  {#each job.blockers as blocker (blocker.code)}
                    <li>{EXPORT_BLOCKER_LABELS[blocker.code] ?? blocker.code} × {blocker.count}</li>
                  {/each}
                </ul>
                {#if onNavigate}
                  <button type="button" class="export-button" onclick={() => onNavigate("gallery")}>返回图库修复</button>
                {/if}
              </section>
            {/if}
            <footer class="export-detail-actions">
              {#if job.status === "ready" || job.status === "paused" || job.status === "failed"}
                <button type="button" class="export-button export-button--primary" disabled={snapshot.operation.phase === "busy"} onclick={() => void operation("start", job.export_id)}>
                  {job.status === "ready" ? "开始导出" : "继续暂存"}
                </button>
              {:else if job.status === "staging"}
                <button type="button" class="export-button" disabled={snapshot.operation.phase === "busy"} onclick={() => void operation("pause", job.export_id)}>暂停</button>
              {/if}
              {#if !isTerminal(job) && job.status !== "staging" && job.status !== "committing"}
                <button type="button" class="export-button export-button--danger" disabled={snapshot.operation.phase === "busy"} onclick={() => void operation("discard", job.export_id)}>
                  {confirmDiscard === job.export_id ? "确认丢弃暂存？" : "丢弃暂存"}
                </button>
              {/if}
              {#if snapshot.operation.phase === "error" && snapshot.operation.exportId === job.export_id}
                <p class="export-hint export-hint--error" role="alert">操作失败：{snapshot.operation.errorCode ?? "未知错误"}</p>
              {/if}
            </footer>
          </section>
        {:else}
          <h2 id="export-detail-heading">任务详情</h2>
          <p class="export-hint">选择左侧任务查看详情，或新建导出。</p>
        {/if}
      </main>
    </div>
  {/if}
</section>
