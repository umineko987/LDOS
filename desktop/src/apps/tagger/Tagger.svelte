<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { ApiClient } from "../../core/api/client";
  import type { PollingHandle, PollingService } from "../../core/polling/service";
  import type { TaggerCatalogEntry, TaggerStatus } from "./model";
  import { createTaggerService } from "./service";
  import {
    downloadProgress,
    isRunning,
    lastSummary,
    stageProgress,
    toggleModel,
    validateStart,
  } from "./controller";
  import { formatBytes, normalizeInputs, normalizeThreshold } from "./model";

  let { api, polling, active = true }: { api: ApiClient; polling: PollingService; active?: boolean } = $props();

  const service = untrack(() => createTaggerService(api));

  let catalog = $state<readonly TaggerCatalogEntry[]>([]);
  let status = $state<TaggerStatus | null>(null);
  let selected = $state<string[]>([]);
  let inputs = $state("");
  let generalThreshold = $state("");
  let characterThreshold = $state("");
  let overwrite = $state(false);
  let error = $state("");
  let busy = $state(false);
  let licenseModel = $state("");
  let tokenInput = $state("");
  let licenseAccepted = $state(false);
  let statusPoll: PollingHandle | null = null;

  const running = $derived(isRunning(status));
  const progress = $derived(stageProgress(status));
  const download = $derived(running ? downloadProgress(status) : null);
  const summary = $derived(lastSummary(status));
  const stageLabels: Record<string, string> = {
    hashing: "计算哈希",
    inferring: "推理",
    selecting: "筛选",
  };

  onMount(() => {
    void refreshCatalog();
    syncStatusPolling();
  });
  onDestroy(() => {
    stopStatusPolling();
  });

  async function refreshCatalog(): Promise<void> {
    try {
      catalog = await service.readCatalog(new AbortController().signal);
    } catch {
      // 目录加载失败时保留空列表；运行状态轮询会继续报告后端问题
    }
  }

  function syncStatusPolling(): void {
    stopStatusPolling();
    if (!active) return;
    statusPoll = polling.start({
      key: "tagger.status",
      scope: "app:tagger-status",
      intervalMs: running ? 750 : 2000,
      critical: false,
      task: (signal) => service.readStatus(signal),
      onResult: (payload: TaggerStatus) => {
        const wasRunning = running;
        status = payload;
        // 运行结束：从快速轮询回到慢速轮询，保留 lastResult 可查
        if (wasRunning && !isRunning(payload)) syncStatusPolling();
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
      await service.prepare([key], new AbortController().signal, options);
      syncStatusPolling();
    } catch (cause) {
      error = describeError(cause);
    } finally {
      busy = false;
    }
  }

  function confirmLicensedInstall(): void {
    if (!licenseModel || !licenseAccepted) return;
    const key = licenseModel;
    licenseModel = "";
    void runInstall(key, { token: tokenInput.trim() || undefined, acceptLicense: true });
  }

  async function start(): Promise<void> {
    const localError = validateStart(selected, inputs);
    if (localError) {
      error = localError;
      return;
    }
    const thresholds: Record<string, number> = {};
    try {
      const general = normalizeThreshold(generalThreshold);
      const character = normalizeThreshold(characterThreshold);
      if (general !== null) thresholds.general = general;
      if (character !== null) thresholds.character = character;
    } catch {
      error = "阈值需在 0.01 到 0.99 之间，或留空使用模型推荐值。";
      return;
    }
    busy = true;
    error = "";
    try {
      await service.run({
        models: selected,
        inputs: normalizeInputs(inputs),
        ...(Object.keys(thresholds).length ? { thresholds } : {}),
        writeCaptions: true,
        overwriteCaptions: overwrite,
      }, new AbortController().signal);
      syncStatusPolling();
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
</script>

<section class="tagger" aria-busy={running}>
  <header class="tagger-head">
    <h2>图片打标</h2>
    <p>用 booru 打标模型为图片生成训练用 caption：与图片同名的 txt 文件。</p>
  </header>

  <label class="tagger-field">
    <span>图片目录或文件（每行一个路径）</span>
    <textarea
      rows="2"
      placeholder="/home/user/pictures/dataset"
      value={inputs}
      oninput={(event) => (inputs = (event.currentTarget as HTMLTextAreaElement).value)}
      disabled={running}
    ></textarea>
  </label>

  <fieldset class="tagger-models">
    <legend>模型（勾选参与打标，第一项为「主模型」，写入同名 txt）</legend>
    {#each catalog as entry (entry.key)}
      <div class="tagger-model">
        <label class="tagger-model-check">
          <input
            type="checkbox"
            checked={selected.includes(entry.key)}
            onchange={() => (selected = [...toggleModel(selected, entry.key)])}
            disabled={running || !entry.installed}
          />
          <span class="tagger-model-key">
            {entry.key}
            {#if selected[0] === entry.key}<em class="tagger-primary">主</em>{/if}
            {#if entry.gated}<em class="tagger-gated">需授权</em>{/if}
          </span>
          <small>{entry.repo}{entry.installed ? "" : " · 未安装"}</small>
        </label>
        {#if !entry.installed}
          <button type="button" onclick={() => install(entry)} disabled={busy || running}>安装</button>
        {/if}
        {#if download && download.model === entry.key && download.total > 0}
          <span class="tagger-download">{download.file}：{formatBytes(download.done)} / {formatBytes(download.total)}</span>
        {/if}
      </div>
    {/each}
  </fieldset>

  <div class="tagger-options">
    <label class="tagger-field">
      <span>通用标签阈值（留空用模型推荐）</span>
      <input
        type="text"
        placeholder="如 0.35"
        value={generalThreshold}
        oninput={(event) => (generalThreshold = (event.currentTarget as HTMLInputElement).value)}
        disabled={running}
      />
    </label>
    <label class="tagger-field">
      <span>角色标签阈值（留空用模型推荐）</span>
      <input
        type="text"
        placeholder="如 0.85"
        value={characterThreshold}
        oninput={(event) => (characterThreshold = (event.currentTarget as HTMLInputElement).value)}
        disabled={running}
      />
    </label>
    <label class="tagger-check">
      <input
        type="checkbox"
        checked={overwrite}
        onchange={(event) => (overwrite = (event.currentTarget as HTMLInputElement).checked)}
        disabled={running}
      />
      <span>覆盖已存在的同名 txt</span>
    </label>
  </div>

  <div class="tagger-actions">
    {#if running}
      <button type="button" onclick={() => void cancel()}>取消</button>
    {:else}
      <button
        type="button"
        class="tagger-start"
        onclick={() => void start()}
        disabled={busy || !selected.length || !inputs.trim()}
      >
        开始打标
      </button>
    {/if}
  </div>

  {#if running && status}
    <div class="tagger-progress">
      <div class="tagger-progress-bar">
        <div class="tagger-progress-fill" style="width: {Math.round(progress * 100)}%"></div>
      </div>
      <p>
        {status.message || stageLabels[status.stage] || ""}
        {#if status.total}（{status.done}/{status.total}）{/if}
      </p>
    </div>
  {/if}

  {#if !running && summary && summary.total > 0}
    <div class="tagger-summary">
      <h3>上次结果</h3>
      {#if summary.captionsSkipped}
        <p>{`共 ${summary.total} 张，caption 写入 ${summary.captionsWritten} 个，跳过已存在 ${summary.captionsSkipped} 个。`}</p>
      {:else}
        <p>{`共 ${summary.total} 张，caption 写入 ${summary.captionsWritten} 个。`}</p>
      {/if}
      {#each Object.entries(summary.perModel) as [model, result] (model)}
        <p><code>{model}</code>：新推理 {result.inferred} 张，缓存命中 {result.cacheHits} 张。</p>
      {/each}
      {#if summary.decodeErrors.length}
        <details>
          <summary>解码失败 {summary.decodeErrors.length} 张</summary>
          <ul>{#each summary.decodeErrors as item (item)}<li><code>{item}</code></li>{/each}</ul>
        </details>
      {/if}
    </div>
  {/if}

  {#if status?.phase === "failed" && status.message}
    <p class="tagger-error" role="alert">{status.message}</p>
  {/if}
  {#if error}
    <p class="tagger-error" role="alert">{error}</p>
  {/if}

  {#if licenseModel}
    <div class="tagger-license" role="dialog" aria-modal="true" aria-label="模型许可确认">
      <h3>安装 {licenseModel}</h3>
      <p class="tagger-license-text">
        {catalog.find((entry) => entry.key === licenseModel)?.license}
      </p>
      <label class="tagger-license-accept">
        <input
          type="checkbox"
          checked={licenseAccepted}
          onchange={(event) => (licenseAccepted = (event.currentTarget as HTMLInputElement).checked)}
        />
        <span>我已阅读并同意上述许可条款（下载即视为同意）</span>
      </label>
      <label class="tagger-field">
        <span>HuggingFace 访问令牌（仅本次下载使用，不会保存）</span>
        <input
          type="password"
          placeholder="hf_..."
          value={tokenInput}
          oninput={(event) => (tokenInput = (event.currentTarget as HTMLInputElement).value)}
          autocomplete="off"
        />
      </label>
      <div class="tagger-license-actions">
        <button type="button" onclick={() => (licenseModel = "")}>取消</button>
        <button type="button" disabled={!licenseAccepted} onclick={confirmLicensedInstall}>同意并安装</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .tagger {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    overflow-y: auto;
  }
  .tagger-head h2 {
    margin: 0 0 4px;
    font-size: 1.15rem;
  }
  .tagger-head p {
    margin: 0;
    opacity: 0.75;
    font-size: 0.85rem;
  }
  .tagger-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tagger-field span {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .tagger-models {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .tagger-model {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tagger-model-check {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .tagger-model-key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tagger-model small {
    opacity: 0.65;
  }
  .tagger-primary,
  .tagger-gated {
    font-size: 0.7rem;
    font-style: normal;
    border-radius: 4px;
    padding: 1px 5px;
    background: rgba(96, 165, 250, 0.2);
  }
  .tagger-gated {
    background: rgba(245, 158, 11, 0.25);
  }
  .tagger-download {
    font-size: 0.75rem;
    opacity: 0.75;
    white-space: nowrap;
  }
  .tagger-options {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 12px;
    align-items: end;
  }
  .tagger-check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 0.85rem;
  }
  .tagger-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .tagger-start {
    font-weight: 600;
  }
  .tagger-progress-bar {
    height: 8px;
    border-radius: 4px;
    background: rgba(128, 128, 128, 0.25);
    overflow: hidden;
  }
  .tagger-progress-fill {
    height: 100%;
    background: rgba(96, 165, 250, 0.85);
    transition: width 0.4s ease;
  }
  .tagger-progress p,
  .tagger-summary p {
    margin: 6px 0 0;
    font-size: 0.85rem;
  }
  .tagger-error {
    color: #f87171;
    font-size: 0.85rem;
  }
  .tagger-license {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid rgba(245, 158, 11, 0.5);
    border-radius: 10px;
    background: var(--app-surface, #1e1e22);
    box-shadow: 0 -4px 18px rgba(0, 0, 0, 0.35);
  }
  .tagger-license-text {
    font-size: 0.8rem;
    opacity: 0.8;
    max-height: 7em;
    overflow-y: auto;
    margin: 0;
  }
  .tagger-license-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
