<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { onDestroy, tick, untrack } from "svelte";
  import type { ApiClient } from "../../core/api/client";
  import type { PollingHandle, PollingService } from "../../core/polling/service";
  import type { TaggerCatalogEntry, TaggerStatus, TaggerCategory } from "./model";
  import type { PickGalleryAssets } from "../gallery/picker";
  import { createTaggerService } from "./service";
  import { normalizeModelProxyUrl } from "../review/service";
  import {
    downloadProgress,
    isRunning,
    lastSummary,
    stageProgress,
    toggleModel,
    validateStart,
  } from "./controller";
  import { formatBytes, normalizeThreshold, TAGGER_CATEGORIES, TAGGER_THRESHOLD_LABELS } from "./model";

  let { api, polling, onPickAssets, active = true }: { api: ApiClient; polling: PollingService; onPickAssets?: PickGalleryAssets; active?: boolean } = $props();

  const service = untrack(() => createTaggerService(api));

  let catalog = $state<readonly TaggerCatalogEntry[]>([]);
  let status = $state<TaggerStatus | null>(null);
  let selected = $state<string[]>([]);
  let assetIds = $state<string[]>([]);
  let directoryIds = $state<string[]>([]);
  let thresholds = $state<Record<string, Record<string, string>>>({});
  let thresholdError = $state<{ model: string; category: TaggerCategory } | null>(null);
  let selectedCategories = $state<Set<TaggerCategory>>(new Set());
  let overwrite = $state(false);
  let error = $state("");
  let busy = $state(false);
  let licenseModel = $state("");
  let tokenInput = $state("");
  let licenseAccepted = $state(false);
  let statusPoll: PollingHandle | null = null;
  let catalogRead: AbortController | null = null;
  let showDownloadConfig = $state(false);
  let mirrorUrl = $state("");
  let downloadProxy = $state("");
  let downloadProxyError = $state("");
  let showModelManager = $state(false);
  let downloadModelKey = $state("");
  let licenseDialog = $state<HTMLDialogElement>();

  const running = $derived(isRunning(status));
  const progress = $derived(stageProgress(status));
  const download = $derived(running ? downloadProgress(status) : null);
  const summary = $derived(lastSummary(status));
  const stageLabels: Record<string, string> = {
    hashing: "计算哈希",
    inferring: "推理",
    selecting: "筛选",
  };

  $effect(() => {
    if (active) void refreshCatalog();
  });

  $effect(() => {
    const intervalMs = running ? 750 : 2000;
    if (active) untrack(() => syncStatusPolling(intervalMs));
    return stopStatusPolling;
  });

  $effect(() => {
    if (!licenseDialog) return;
    if (licenseModel && active) {
      if (!licenseDialog.open) licenseDialog.showModal();
    } else licenseDialog.close();
  });

  onDestroy(() => {
    catalogRead?.abort();
    stopStatusPolling();
  });

  async function refreshCatalog(): Promise<void> {
    catalogRead?.abort();
    const controller = new AbortController();
    catalogRead = controller;
    try {
      const payload = await service.readCatalog(controller.signal);
      if (!controller.signal.aborted) catalog = payload;
    } catch (cause) {
      if (!controller.signal.aborted) error = describeError(cause);
    }
  }

  function syncStatusPolling(intervalMs: number): void {
    stopStatusPolling();
    statusPoll = polling.start({
      key: "tagger.status",
      scope: "app:tagger",
      intervalMs,
      critical: false,
      task: (signal) => service.readStatus(signal),
      onError: (cause) => { error = describeError(cause); },
      onResult: (payload: TaggerStatus) => {
        const wasPreparing = status?.phase === "preparing";
        status = payload;
        if (wasPreparing && payload.phase !== "preparing") void refreshCatalog();
      },
    });
  }

  function stopStatusPolling(): void {
    if (statusPoll) {
      statusPoll.stop();
      statusPoll = null;
    }
  }

  function install(entry: TaggerCatalogEntry): void {
    try {
      normalizeModelProxyUrl(downloadProxy);
    } catch {
      downloadProxyError = "代理地址格式不正确，请输入带协议和端口的地址，例如 http://127.0.0.1:7890。";
      showDownloadConfig = true;
      void tick().then(() => document.getElementById("tagger-download-proxy")?.focus());
      return;
    }
    downloadProxyError = "";
    if (entry.gated) {
      licenseModel = entry.key;
      licenseAccepted = false;
      tokenInput = "";
      return;
    }
    void runInstall(entry.key);
  }

  async function runInstall(key: string, options?: { token?: string; acceptLicense?: boolean }): Promise<void> {
    busy = true;
    error = "";
    try {
      await service.prepare([key], new AbortController().signal, {
        ...options,
        ...(mirrorUrl.trim() ? { proxyUrl: mirrorUrl.trim() } : {}),
        downloadProxy,
      });
      status = { phase: "preparing", stage: "", done: 0, total: 0, message: "准备下载", download: {}, lastResult: null, enabled: true };
    } catch (cause) {
      error = describeError(cause);
    } finally {
      busy = false;
    }
  }

  function dismissLicense(): void {
    licenseModel = "";
    tokenInput = "";
    licenseAccepted = false;
  }

  function confirmLicensedInstall(): void {
    if (!licenseModel || !licenseAccepted) return;
    const key = licenseModel;
    const token = tokenInput.trim() || undefined;
    dismissLicense();
    void runInstall(key, {
      token,
      acceptLicense: true,
    });
  }

  async function start(): Promise<void> {
    const localError = validateStart(selected, assetIds, directoryIds);
    if (localError) {
      error = localError;
      return;
    }
    const parsedThresholds: Record<string, Record<string, number>> = {};
    thresholdError = null;
    for (const entry of selectedModels) {
      const overrides: Record<string, number> = {};
      for (const category of entry.categories) {
        try {
          const parsed = normalizeThreshold(thresholds[entry.key]?.[category] ?? "");
          if (parsed !== null) overrides[category] = parsed;
        } catch {
          thresholdError = { model: entry.key, category };
          document.getElementById(`tagger-${entry.key}-${category}`)?.focus();
          return;
        }
      }
      if (Object.keys(overrides).length) parsedThresholds[entry.key] = overrides;
    }
    busy = true;
    error = "";
    try {
      await service.run({
        models: selected,
        assetIds,
        directoryIds,
        ...(Object.keys(parsedThresholds).length ? { thresholds: parsedThresholds } : {}),
        ...(selectedCategories.size > 0 ? { categories: [...selectedCategories] } : {}),
        writeCaptions: true,
        overwriteCaptions: overwrite,
      }, new AbortController().signal);
      status = { phase: "tagging", stage: "", done: 0, total: 0, message: "", download: {}, lastResult: null, enabled: true };
    } catch (cause) {
      error = describeError(cause);
    } finally {
      busy = false;
    }
  }

  async function cancel(): Promise<void> {
    try {
      await service.cancel(new AbortController().signal);
    } catch (cause) {
      error = describeError(cause);
    }
  }

  function describeError(cause: unknown): string {
    if (cause instanceof Error && cause.message) return cause.message;
    return "请求失败，请稍后重试。";
  }

  function setThreshold(model: string, category: TaggerCategory, value: string): void {
    thresholds[model] = { ...thresholds[model], [category]: value };
    if (thresholdError?.model === model && thresholdError.category === category) thresholdError = null;
  }

  function toggleCategory(category: TaggerCategory): void {
    const newSet = new Set(selectedCategories);
    if (newSet.has(category)) {
      newSet.delete(category);
    } else {
      newSet.add(category);
    }
    selectedCategories = newSet;
  }

  async function openGalleryPicker(): Promise<void> {
    if (!onPickAssets) {
      error = "图库选择器不可用。";
      return;
    }
    try {
      const result = await onPickAssets({
        origin: "打标 / 选择图片与目录",
        assetIds,
        directoryIds,
        signal: new AbortController().signal,
      });
      if (result === null) return;
      assetIds = [...new Set(result.assetIds)];
      directoryIds = [...new Set(result.directoryIds)];
      error = "";
    } catch (cause) {
      error = describeError(cause);
    }
  }

  const installedModels = $derived(catalog.filter((entry) => entry.installed));
  const selectedModels = $derived(catalog.filter((entry) => selected.includes(entry.key)).map((entry) => ({
    ...entry,
    categories: TAGGER_CATEGORIES.filter((category) => entry.defaultThresholds[category] !== undefined),
  })));
  const uninstalledModels = $derived(catalog.filter((entry) => !entry.installed));
  const modelToInstall = $derived(uninstalledModels.find((entry) => entry.key === downloadModelKey) ?? uninstalledModels[0]);
</script>

<section class="tagger" aria-busy={running}>
  <header class="tagger-head">
    <div>
      <h2>图片打标</h2>
      <p>从图库选择图片或目录，生成训练用 caption</p>
    </div>
    <span class="tagger-status" class:running class:failed={status?.phase === "failed"} role="status">
      {status?.phase === "preparing" ? "正在安装模型" : running ? "正在打标" : status?.phase === "failed" ? "任务失败" : "就绪"}
    </span>
  </header>

  <div class="tagger-layout">
    <div class="tagger-main">
      <section class="tagger-card tagger-inputs" aria-label="图库输入">
        <header class="tagger-card-head">
          <h3><span class="tagger-step" aria-hidden="true">01</span>选择图库图片</h3>
        </header>
        {#if assetIds.length || directoryIds.length}
          <p class="tagger-selection" role="status">{`已选择 ${assetIds.length} 张图片 · ${directoryIds.length} 个目录`}</p>
        {:else}
          <p class="tagger-empty">尚未选择图片或目录</p>
        {/if}
        <div class="tagger-input-actions">
          <Button variant="outline" size="sm" type="button" class="tagger-btn-gallery" onclick={openGalleryPicker} disabled={running || busy}>从图库选择图片或目录</Button>
          {#if assetIds.length || directoryIds.length}
            <Button variant="ghost" size="sm" type="button" class="tagger-btn-text" onclick={() => { assetIds = []; directoryIds = []; }} disabled={running || busy}>清空选择</Button>
          {/if}
        </div>
        <p class="tagger-hint">目录包含全部子目录中的图库图片；重叠选择只处理一次。</p>
      </section>

      <fieldset class="tagger-card tagger-models" disabled={running || busy}>
        <legend><span class="tagger-step" aria-hidden="true">02</span>选择打标模型</legend>
        {#if installedModels.length}
          <div class="tagger-model-list">
            {#each installedModels as entry (entry.key)}
              <label class="tagger-model-item" class:chosen={selected.includes(entry.key)}>
                <input type="checkbox" checked={selected.includes(entry.key)} onchange={() => (selected = [...toggleModel(selected, entry.key)])} />
                <span>{entry.key}</span>
                {#if selected[0] === entry.key}<Badge variant="secondary">首个模型</Badge>{/if}
              </label>
            {/each}
          </div>
          <p class="tagger-hint">按勾选顺序合并到图片同名 TXT：重复标签跳过，新标签追加。</p>
        {:else}
          <div class="tagger-model-empty">
            <p class="tagger-empty">还没有已安装的模型</p>
            <Button variant="outline" size="sm" type="button" onclick={() => (showModelManager = true)}>去安装模型</Button>
          </div>
        {/if}
      </fieldset>

      <section class="tagger-card" aria-label="打标设置">
        <header class="tagger-card-head">
          <h3><span class="tagger-step" aria-hidden="true">03</span>打标设置</h3>
        </header>
        {#if selectedModels.length}
          <p class="tagger-hint">各模型单独设置，互不影响。留空使用下方默认值；可填写 0.01–0.99，越高输出越少。</p>
          <Field.Group class="gap-6 mt-4">
            {#each selectedModels as entry (entry.key)}
              <Field.Set class="gap-3 min-w-0" disabled={running || busy} data-threshold-model={entry.key}>
                <Field.Legend variant="label"><span class="tagger-threshold-model" data-no-i18n>{entry.key}</span></Field.Legend>
                <Field.Group class="tagger-threshold-grid grid grid-cols-2 gap-3">
                  {#each entry.categories as category (category)}
                    {@const id = `tagger-${entry.key}-${category}`}
                    {@const invalid = thresholdError?.model === entry.key && thresholdError.category === category}
                    <Field.Field class="gap-2 min-w-0" data-disabled={running || busy} data-invalid={invalid}>
                      <Field.Label for={id}>{TAGGER_THRESHOLD_LABELS[category]}</Field.Label>
                      <Input {id} type="text" inputmode="decimal" placeholder={String(entry.defaultThresholds[category])}
                        value={thresholds[entry.key]?.[category] ?? ""} oninput={(event) => setThreshold(entry.key, category, event.currentTarget.value)}
                        disabled={running || busy} aria-invalid={invalid} aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ""}`} />
                      <Field.Description id={`${id}-hint`}>
                        <span>默认值</span> <span data-no-i18n>{entry.defaultThresholds[category]}</span>
                        {#if category === "rating"}
                          {#if entry.defaultThresholds.rating === 0}<span>（不设最低分）</span>{/if}
                          <span class="tagger-threshold-note">仅保留最高分项，低于阈值则不输出。</span>
                        {:else if category === "quality"}
                          <span class="tagger-threshold-note">只控制质量标签，不过滤图片。</span>
                        {/if}
                      </Field.Description>
                      {#if invalid}<Field.Error id={`${id}-error`}>阈值需在 0.01 到 0.99 之间，或留空使用模型推荐值。</Field.Error>{/if}
                    </Field.Field>
                  {/each}
                </Field.Group>
              </Field.Set>
            {/each}
          </Field.Group>
        {:else}
          <p class="tagger-hint">请先选择打标模型，再设置对应阈值。</p>
        {/if}
        <label class="tagger-check">
          <input type="checkbox" checked={overwrite} onchange={(event) => (overwrite = event.currentTarget.checked)} disabled={running || busy} />
          <span>覆盖已存在的 txt</span>
        </label>
        <details class="tagger-category-options">
          <summary>输出分类（默认全部）</summary>
          <div class="tagger-categories-grid">
            {#each TAGGER_CATEGORIES as category (category)}
              <label class="tagger-check">
                <input type="checkbox" checked={selectedCategories.has(category)} onchange={() => toggleCategory(category)} disabled={running || busy} />
                <span>{category}</span>
              </label>
            {/each}
          </div>
        </details>
      </section>
    </div>

    <aside class="tagger-side" aria-label="任务与模型管理">
      <section class="tagger-card tagger-task" aria-label="本次任务">
        <h3>本次任务</h3>
        <dl class="tagger-task-facts">
          <div><dt>图库输入</dt><dd>{`${assetIds.length} 张图片 · ${directoryIds.length} 个目录`}</dd></div>
          <div><dt>合并顺序</dt><dd>{selected.join(" → ") || "未选择"}</dd></div>
          <div><dt>输出</dt><dd>图片旁的 TXT</dd></div>
        </dl>
        {#if running}
          <Button variant="destructive" size="sm" type="button" class="tagger-cancel" onclick={() => void cancel()}>取消</Button>
        {:else}
          <Button variant="default" size="sm" type="button" class="tagger-btn-primary" onclick={() => void start()} disabled={busy || !selected.length || (!assetIds.length && !directoryIds.length)}>开始打标</Button>
        {/if}
        {#if running && status}
          <div class="tagger-progress">
            <progress max="1" value={status.phase === "preparing" ? (download && download.total > 0 ? download.done / download.total : undefined) : progress} aria-label={status.phase === "preparing" ? "模型下载进度" : "打标进度"}></progress>
            <div class="tagger-progress-info">
              <span>{status.message || stageLabels[status.stage] || "准备下载"}</span>
              {#if status.total}<span>{status.done}/{status.total}</span>{/if}
            </div>
            {#if download}
              <small>{download.model} · {download.file}</small>
              <small>{formatBytes(download.done)}{#if download.total > 0} / {formatBytes(download.total)}{/if}</small>
            {/if}
          </div>
        {:else}
          <p class="tagger-hint">Caption 保存在原图片旁；默认不覆盖已有 TXT。</p>
        {/if}
      </section>

      {#if !running && summary && summary.total > 0}
        <section class="tagger-card tagger-summary" aria-label="最近结果">
          <h3>最近结果</h3>
          <p>上次：{summary.total} 张，写入 {summary.captionsWritten} 个</p>
          {#if summary.captionsSkipped > 0}<p>跳过 {summary.captionsSkipped} 个已有 caption</p>{/if}
          {#if summary.decodeErrors.length > 0}<p class="tagger-summary-error">失败 {summary.decodeErrors.length} 张</p>{/if}
        </section>
      {/if}

      <details class="tagger-card tagger-model-manager" bind:open={showModelManager}>
        <summary><span>模型管理</span><small title="已安装 / 登记模型">{installedModels.length}/{catalog.length}</small></summary>
        <div class="tagger-manager-body">
          {#if modelToInstall}
            <p class="tagger-hint">下载后即可在打标模型中选择。</p>
            <fieldset class="tagger-manager-controls" disabled={busy || running}>
              <Field.Field class="tagger-field">
                <Field.Label for="tagger-download-model">下载模型</Field.Label>
                <NativeSelect.Root id="tagger-download-model" value={modelToInstall.key} onchange={(event) => (downloadModelKey = event.currentTarget.value)}>
                  {#each uninstalledModels as entry (entry.key)}<option value={entry.key}>{entry.key}</option>{/each}
                </NativeSelect.Root>
              </Field.Field>
              <Button variant="outline" size="sm" type="button" onclick={() => modelToInstall && install(modelToInstall)}>安装</Button>
            </fieldset>
            {#if modelToInstall.gated}<p class="tagger-hint tagger-gated">需授权：安装前确认模型许可。</p>{/if}
          {:else if catalog.length}
            <p class="tagger-hint">全部模型已安装。</p>
          {/if}
          <Button variant="ghost" size="sm" type="button" class="tagger-btn-text" aria-expanded={showDownloadConfig} aria-controls="tagger-download-network" onclick={() => (showDownloadConfig = !showDownloadConfig)} disabled={busy || running}>
            {showDownloadConfig ? "收起网络设置" : mirrorUrl.trim() || downloadProxy.trim() ? "镜像与代理（已配置）" : "镜像与代理（可选）"}
          </Button>
          {#if showDownloadConfig}
            <Field.Group id="tagger-download-network" class="gap-4">
              <Field.Field data-disabled={busy || running}>
                <Field.Label for="tagger-mirror">HuggingFace 镜像（可选）</Field.Label>
                <Input id="tagger-mirror" type="url" placeholder="https://hf-mirror.com" value={mirrorUrl} oninput={(event) => (mirrorUrl = event.currentTarget.value)} aria-describedby="tagger-mirror-help" disabled={busy || running} />
                <Field.Description id="tagger-mirror-help">留空使用默认地址，可与代理同时使用。</Field.Description>
              </Field.Field>
              <Field.Field data-invalid={Boolean(downloadProxyError)} data-disabled={busy || running}>
                <Field.Label for="tagger-download-proxy">下载代理（可选）</Field.Label>
                <Input id="tagger-download-proxy" type="text" inputmode="url" maxlength={300} autocomplete="off" autocapitalize="none" spellcheck={false}
                  placeholder="http://127.0.0.1:7890" value={downloadProxy} oninput={(event) => { downloadProxy = event.currentTarget.value; downloadProxyError = ""; }}
                  aria-invalid={Boolean(downloadProxyError)} aria-describedby={downloadProxyError ? "tagger-download-proxy-help tagger-download-proxy-error" : "tagger-download-proxy-help"} disabled={busy || running} />
                <Field.Description id="tagger-download-proxy-help">支持带端口的 HTTP(S) 地址；留空沿用环境设置。</Field.Description>
                {#if downloadProxyError}<Field.Error id="tagger-download-proxy-error">{downloadProxyError}</Field.Error>{/if}
              </Field.Field>
              <p class="tagger-hint">仅用于模型下载，不修改全局代理，不会保存。</p>
            </Field.Group>
          {/if}
        </div>
      </details>
    </aside>
  </div>

  {#if status?.phase === "failed" && status.message}<Alert.Root variant="destructive"><Alert.Description>{status.message}</Alert.Description></Alert.Root>{/if}
  {#if error}<Alert.Root variant="destructive"><Alert.Description>{error}</Alert.Description></Alert.Root>{/if}

  <dialog class="tagger-license" bind:this={licenseDialog} aria-label="模型许可确认" oncancel={dismissLicense}>
    {#if licenseModel}
      <h3>安装 {licenseModel}</h3>
      <p class="tagger-license-text" data-no-i18n>{catalog.find((entry) => entry.key === licenseModel)?.license}</p>
      <label class="tagger-check">
        <input type="checkbox" checked={licenseAccepted} onchange={(event) => (licenseAccepted = event.currentTarget.checked)} />
        <span>我已阅读并同意上述许可条款（下载即视为同意）</span>
      </label>
      <Field.Field class="tagger-field">
        <Field.Label for="tagger-token">HuggingFace 访问令牌（仅本次下载使用，不会保存）</Field.Label>
        <Input id="tagger-token" type="password" placeholder="hf_..." value={tokenInput} oninput={(event) => (tokenInput = event.currentTarget.value)} autocomplete="off" />
      </Field.Field>
      <div class="tagger-license-actions">
        <Button variant="outline" size="sm" type="button" onclick={dismissLicense}>取消</Button>
        <Button variant="default" size="sm" type="button" class="tagger-btn-primary" disabled={!licenseAccepted} onclick={confirmLicensedInstall}>同意并安装</Button>
      </div>
    {/if}
  </dialog>
</section>

<style>
  .tagger {
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: 100%;
    min-height: 0;
    padding: 16px 20px;
    overflow-y: auto;
    container-type: inline-size;
  }
  .tagger-head, .tagger-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 1.0625rem; color: var(--ldos-text-heading); }
  h3, legend { font-size: 0.95rem; font-weight: 600; color: var(--ldos-text-heading); }
  .tagger-head p { margin-top: 6px; color: var(--ldos-text-muted); font-size: 0.85rem; }
  .tagger-status { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; font-size: 0.78rem; color: var(--ldos-text-muted); }
  .tagger-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ldos-state-success); }
  .tagger-status.running::before { background: var(--ldos-state-running); }
  .tagger-status.failed::before { background: var(--ldos-state-danger); }
  .tagger-layout { display: grid; grid-template-columns: minmax(0, 1fr) 288px; align-items: start; gap: 18px; }
  .tagger-main, .tagger-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .tagger-side { position: sticky; top: 0; }
  .tagger-card { margin: 0; padding: 14px; min-width: 0; border: 1px solid var(--ldos-border-weak); border-radius: var(--ldos-radius-card); background: var(--ldos-glass-surface-weak); }
  .tagger-card-head { margin-bottom: 14px; }
  .tagger-step { display: inline-block; margin-right: 10px; font-size: 0.72rem; font-variant-numeric: tabular-nums; color: var(--ldos-accent); }
  .tagger-empty { color: var(--ldos-text-muted); font-size: 0.9rem; }
  .tagger-selection { font-size: 0.95rem; font-weight: 600; color: var(--ldos-text-heading); }
  .tagger-input-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 10px; }
  .tagger-hint { color: var(--ldos-text-muted); font-size: 0.76rem; line-height: 1.6; }
  .tagger-models { padding-top: 10px; }
  legend { padding: 0 5px; }
  .tagger-model-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .tagger-model-item { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 9px 10px; border: 1px solid var(--ldos-border-default); border-radius: var(--ldos-radius-control); font-size: 0.82rem; cursor: pointer; }
  .tagger-model-item.chosen { border-color: var(--ldos-accent); background: var(--ldos-focus-glow); }
  .tagger-model-item span { overflow-wrap: anywhere; }
  .tagger-model-empty { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .tagger-threshold-model { overflow-wrap: anywhere; }
  .tagger-threshold-note { display: block; }
  option { background: var(--ldos-fallback-elevated-solid); color: var(--ldos-text-body); }
  input[type="checkbox"] { margin: 0; accent-color: var(--ldos-accent); flex-shrink: 0; }
  .tagger-check { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; cursor: pointer; }
  .tagger-card > .tagger-check { margin-top: 18px; }
  .tagger-category-options { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--ldos-border-weak); }
  summary { cursor: pointer; font-size: 0.82rem; color: var(--ldos-text-body); }
  .tagger-categories-grid { display: flex; flex-wrap: wrap; gap: 12px 18px; margin-top: 14px; }
  .tagger-task { display: flex; flex-direction: column; gap: 16px; }
  .tagger-task-facts { display: flex; flex-direction: column; gap: 12px; margin: 0; font-size: 0.8rem; }
  .tagger-task-facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  dt { color: var(--ldos-text-muted); flex-shrink: 0; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; color: var(--ldos-text-fact); }
  input:focus-visible, summary:focus-visible { outline: 2px solid var(--ldos-accent); outline-offset: 3px; }
  .tagger-progress { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 0.8rem; }
  progress { width: 100%; height: 6px; accent-color: var(--ldos-accent); }
  .tagger-progress-info { display: flex; justify-content: space-between; gap: 8px; }
  .tagger-progress small { overflow-wrap: anywhere; color: var(--ldos-text-muted); }
  .tagger-summary { border-color: var(--ldos-state-success); }
  .tagger-summary p { margin-top: 10px; font-size: 0.82rem; }
  .tagger-summary-error { color: var(--ldos-state-danger); }
  .tagger-model-manager { padding: 13px 16px; }
  .tagger-model-manager > summary { font-weight: 500; }
  .tagger-model-manager > summary small { float: right; font-weight: 400; color: var(--ldos-text-muted); font-variant-numeric: tabular-nums; }
  .tagger-manager-body { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .tagger-manager-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; padding: 0; margin: 0; border: 0; min-width: 0; }
  .tagger-gated { color: var(--ldos-state-warning); }
  .tagger-license { width: min(480px, calc(100% - 32px)); max-height: 80vh; padding: 22px; border: 1px solid var(--ldos-border-default); border-radius: var(--ldos-radius-card); background: var(--ldos-fallback-elevated-solid); color: var(--ldos-text-body); }
  .tagger-license[open] { display: flex; flex-direction: column; gap: 18px; }
  .tagger-license::backdrop { background: rgb(0 0 0 / 0.6); }
  .tagger-license-text { max-height: 10em; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.82rem; line-height: 1.6; color: var(--ldos-text-muted); }
  .tagger-license-actions { display: flex; justify-content: flex-end; gap: 8px; }
  @container (max-width: 740px) {
    .tagger-layout { grid-template-columns: minmax(0, 1fr); }
    .tagger-side { position: static; }
  }
  @container (max-width: 430px) {
    .tagger :global(.tagger-threshold-grid) { grid-template-columns: minmax(0, 1fr); }
  }
</style>
