<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { ApiClient } from "../../core/api/client";
  import { createGalleryService } from "../gallery/service";
  import type { PickGalleryAssets } from "../gallery/picker";
  import { FILTER_LABELS, FILTER_MODELS, requiredFilterModels, type FilterOptions, type FilterCapabilities } from "./model";
  import { createFilterPresetService } from "./service";
  import { createReviewService, normalizeModelProxyUrl } from "../review/service";
  import type { ModelSetupSnapshot } from "../review/model";
  import { ApiError } from "../../core/api/client";
  import "./filter-presets.css";

  let { api, options, onChange, onPickAssets, referenceOrigin, capabilities, setup, onModelSetup, active = true, prepareDisabled = false, disabled = false }: {
    api: ApiClient;
    options: FilterOptions;
    onChange: (next: FilterOptions) => void;
    onPickAssets: PickGalleryAssets;
    referenceOrigin: string;
    capabilities: FilterCapabilities | null;
    setup: ModelSetupSnapshot | null;
    onModelSetup: (next: ModelSetupSnapshot | null) => void;
    active?: boolean;
    prepareDisabled?: boolean;
    disabled?: boolean;
  } = $props();
  const gallery = untrack(() => createGalleryService(api));
  const uid = $props.id();
  let pickerRequest: AbortController | null = null;
  const references = $derived(Array.from(new Set(options.reference_asset_ids)));

  const filterService = untrack(() => createFilterPresetService(api));
  const setupService = untrack(() => createReviewService(api));
  let modelRequest: AbortController | null = null;
  let modelTimer: ReturnType<typeof setTimeout> | null = null;
  let modelLoading = $state(false);
  let modelError = $state("");
  let modelConfirmation = $state(false);
  let modelProxy = $state("");
  let modelProxyError = $state("");
  const requiredModels = $derived(requiredFilterModels(options, capabilities));
  const preparing = $derived(modelLoading || setup?.phase === "installing");

  function stopModels(): void {
    if (modelTimer !== null) clearTimeout(modelTimer);
    modelTimer = null;
    modelRequest?.abort(); modelRequest = null; modelLoading = false;
  }
  async function refreshModels(install = false, polling = false): Promise<void> {
    if (!active || install && (prepareDisabled || preparing || !requiredModels.length)) return;
    let proxyUrl = "";
    if (install) {
      try { proxyUrl = normalizeModelProxyUrl(modelProxy); }
      catch { modelProxyError = "代理地址格式不正确，请输入带协议和端口的地址，例如 http://127.0.0.1:7890。"; return; }
    }
    const models = [...requiredModels];
    stopModels();
    const next = new AbortController(); modelRequest = next; modelLoading = true; modelError = "";
    if (install) { modelProxy = ""; modelProxyError = ""; modelConfirmation = false; }
    // The parent owns capabilities: never show a local ready state while execution stays blocked.
    if (!polling) onModelSetup(null);
    try {
      const status = install
        ? await setupService.installModels(proxyUrl, next.signal, models)
        : await filterService.readModelSetup(next.signal);
      if (modelRequest !== next || next.signal.aborted) return;
      if (!status.reviewFilters) throw new TypeError("invalid_filter_capabilities");
      onModelSetup(status);
      if (status.phase === "installing") modelTimer = setTimeout(() => { modelTimer = null; void refreshModels(false, true); }, 750);
    } catch (cause) {
      if (modelRequest !== next || next.signal.aborted) return;
      onModelSetup(null);
      modelError = cause instanceof ApiError ? `${cause.code}: ${cause.message}`
        : cause instanceof Error ? cause.message : "模型准备失败，请重试。";
    } finally { if (modelRequest === next) { modelRequest = null; modelLoading = false; } }
  }
  $effect(() => {
    if (active) untrack(() => { void refreshModels(); });
    else untrack(stopModels);
    return stopModels;
  });
  onDestroy(stopModels);
  async function openPicker(): Promise<void> {
    if (disabled || pickerRequest) return;
    const request = new AbortController(); pickerRequest = request;
    try {
      const ids = await onPickAssets({ origin: referenceOrigin, assetIds: references, signal: request.signal });
      // Keyed editor destruction cancels the request, so an old result cannot update a new draft.
      if (pickerRequest === request && !request.signal.aborted && ids !== null) {
        onChange({ ...options, reference_asset_ids: ids });
      }
    } finally { if (pickerRequest === request) pickerRequest = null; }
  }
  function change(key: keyof typeof FILTER_LABELS, checked: boolean): void {
    if (!disabled) onChange({ ...options, [key]: checked });
  }
  function remove(id: string): void {
    if (!disabled) onChange({ ...options, reference_asset_ids: options.reference_asset_ids.filter((value) => value !== id) });
  }
  onDestroy(() => { pickerRequest?.abort(); pickerRequest = null; });
</script>

  <div class="filter-options-editor" data-filter-options-editor>
    <fieldset disabled={disabled}><legend>自动去重</legend>
      <label class="filter-toggle"><input type="checkbox" checked={options.basic_dedup} onchange={(event) => change("basic_dedup", event.currentTarget.checked)} /><span>{FILTER_LABELS.basic_dedup}</span></label>
    </fieldset>
    <fieldset disabled={disabled}><legend>辅助分类</legend>
      {#each (["filter_sketch", "filter_monochrome"] as const) as key}
        <label class="filter-toggle"><input type="checkbox" checked={options[key]} aria-describedby={`${uid}-${key}-capability`} onchange={(event) => change(key, event.currentTarget.checked)} /><span>{FILTER_LABELS[key]}</span></label>
        <p id={`${uid}-${key}-capability`} class="filter-help" data-filter-capability={key}>
          {#if capabilities?.[key]?.available === true}分类能力已就绪
          {:else}<strong>暂不可执行</strong><span> · </span><span>{capabilities?.[key]?.reason || "过滤能力未加载，暂不可执行。"}</span>{/if}
        </p>
      {/each}
      <p class="filter-help">线稿/草图、单色共用动漫完成度模型，仅辅助分类，不自动排除或回收图片；模型可能误判，请人工确认。</p>
    </fieldset>
    <fieldset disabled={disabled}><legend>自动角色过滤</legend>
      <label class="filter-toggle"><input type="checkbox" checked={options.filter_character} aria-describedby={`${uid}-filter_character-capability`} onchange={(event) => change("filter_character", event.currentTarget.checked)} /><span>{FILTER_LABELS.filter_character}</span></label>
      <p id={`${uid}-filter_character-capability`} class="filter-help" data-filter-capability="filter_character">
        {#if capabilities?.filter_character.available === true}过滤能力已就绪
        {:else}<strong>暂不可执行</strong><span> · </span><span>{capabilities?.filter_character.reason || "过滤能力未加载，暂不可执行。"}</span>{/if}
      </p>
      <p class="filter-help">CCIP 角色过滤偏保守，多人图不保证准确；请使用清晰参考图。不可用选项仍可保存为预设。</p>
    </fieldset>
    {#if requiredModels.length || preparing || modelError || setup?.phase === "failed"}
      <section class="filter-model-setup" data-filter-model-setup aria-labelledby={`${uid}-models-heading`} aria-busy={preparing}>
        <h3 id={`${uid}-models-heading`}>准备已选模型</h3>
        {#if setup?.phase === "installing"}
          <div class="review-model-progress" role="status" aria-live="polite">
            <p class="filter-help"><span>正在准备：</span>{#each setup.requestedModels as key}<span>{key === "dedup" ? "SSCD / DINOv2" : FILTER_MODELS[key].label}</span> {/each}</p>
            <progress max={setup.expectedBytes} value={setup.downloadedBytes}></progress>
            <span>{(setup.downloadedBytes / 1_000_000).toFixed(1)} / {(setup.expectedBytes / 1_000_000).toFixed(1)} MB{setup.usingProxy ? " · 使用本次代理" : ""}</span>
            <small>{setup.message || "正在下载并检查模型"}</small>
          </div>
        {:else if modelLoading}<p role="status">正在检查过滤模型…</p>{/if}
        {#if modelError || setup?.phase === "failed"}<p role="alert">{modelError || setup?.message || "模型准备失败，请重试。"}</p>{/if}
        {#if modelConfirmation && requiredModels.length}
          <div class="filter-model-confirmation" data-filter-model-confirmation>
            <p>仅下载当前勾选且未就绪的模型：</p>
            <ul>{#each requiredModels as key}<li><span>{FILTER_MODELS[key].label}</span><span> · </span><span>约</span> {FILTER_MODELS[key].megabytes} MB</li>{/each}</ul>
            <p class="filter-help">不会下载 SSCD/DINO；线稿/草图和单色只下载一份共用模型。确认后联网下载并进行离线推理检查。</p>
            <label class="filter-preset-name"><span>本次下载代理（可选）</span><input type="text" bind:value={modelProxy} placeholder="http://127.0.0.1:7890" autocomplete="off" spellcheck="false" disabled={preparing || !active || prepareDisabled} aria-invalid={!!modelProxyError} aria-describedby={`${uid}-proxy-help`} /></label>
            <p id={`${uid}-proxy-help`} class="filter-help">仅用于本次模型下载，不修改全局代理。</p>
            {#if modelProxyError}<p role="alert">{modelProxyError}</p>{/if}
            <div class="filter-toolbar"><button type="button" disabled={preparing || !active || prepareDisabled} onclick={() => void refreshModels(true)}>确认准备</button><button type="button" disabled={preparing} onclick={() => { modelConfirmation = false; modelProxy = ""; modelProxyError = ""; }}>取消准备</button></div>
          </div>
        {:else if requiredModels.length}
          <button type="button" disabled={preparing || !active || prepareDisabled} onclick={() => { modelConfirmation = true; modelProxyError = ""; }}>{modelError || setup?.phase === "failed" ? "重试准备模型" : "准备已选模型"}</button>
        {/if}
        <button type="button" disabled={modelLoading || !active} onclick={() => void refreshModels()}>刷新模型能力</button>
      </section>
    {/if}
    <fieldset disabled={disabled}><legend>人工辅助</legend>
      <label class="filter-toggle"><input type="checkbox" checked={options.similarity_groups} aria-describedby={`${uid}-similarity-help`} onchange={(event) => change("similarity_groups", event.currentTarget.checked)} /><span>{FILTER_LABELS.similarity_groups}</span></label>
      <p id={`${uid}-similarity-help`} class="filter-help">只分组供人工判断，不自动排除差分。</p>
    </fieldset>
    <section aria-labelledby={`${uid}-references-heading`}>
      <header class="filter-toolbar"><h3 id={`${uid}-references-heading`}>角色参考图</h3><output>{references.length} / 200</output></header>
      <p class="filter-help">执行角色过滤前需添加参考图；空参考图仍可保存为模板。</p>
      <div class="filter-toolbar"><button type="button" disabled={disabled} onclick={() => void openPicker()}>选择参考图…</button><button type="button" disabled={disabled || !references.length} onclick={() => onChange({ ...options, reference_asset_ids: [] })}>清空参考图</button></div>
      <ul class="filter-reference-grid" aria-label="已保存到配置的参考图">
        {#each references as id, index (id)}
          <li class="filter-reference"><img src={gallery.thumbnailUrl(id, 256)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" /><span id={`${uid}-reference-${index}`}>{id}</span><button type="button" disabled={disabled} aria-describedby={`${uid}-reference-${index}`} onclick={() => remove(id)}>移除参考图</button></li>
        {:else}<li class="filter-help">尚未添加参考图</li>{/each}
      </ul>
    </section>
  </div>
