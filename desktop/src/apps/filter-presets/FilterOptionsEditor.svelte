<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import type { ApiClient } from "../../core/api/client";
  import { createGalleryService } from "../gallery/service";
  import type { GalleryDirectoryPage, GallerySourceSummary } from "../gallery/model";
  import { FILTER_CAPABILITY_KEYS, FILTER_LABELS, FILTER_MODELS, requiredFilterModels, type FilterOptions, type FilterCapabilities } from "./model";
  import { createFilterPresetService } from "./service";
  import { createReviewService, normalizeModelProxyUrl } from "../review/service";
  import type { ModelSetupSnapshot } from "../review/model";
  import { ApiError } from "../../core/api/client";
  import "./filter-presets.css";

  let { api, options, onChange, capabilities, setup, onModelSetup, active = true, prepareDisabled = false, disabled = false }: {
    api: ApiClient;
    options: FilterOptions;
    onChange: (next: FilterOptions) => void;
    capabilities: FilterCapabilities | null;
    setup: ModelSetupSnapshot | null;
    onModelSetup: (next: ModelSetupSnapshot | null) => void;
    active?: boolean;
    prepareDisabled?: boolean;
    disabled?: boolean;
  } = $props();
  const gallery = untrack(() => createGalleryService(api));
  const uid = $props.id();
  let picking = $state(false);
  let selected = $state<string[]>([]);
  let sources = $state<readonly GallerySourceSummary[]>([]);
  let page = $state<GalleryDirectoryPage | null>(null);
  let directoryId = $state<string | null>(null);
  let loading = $state(false);
  let error = $state("");
  let request: AbortController | null = null;
  let addButton = $state<HTMLButtonElement>();
  let pickerHeading = $state<HTMLHeadingElement>();
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
  function abort(): void { request?.abort(); request = null; loading = false; }
  function begin(): AbortController {
    abort();
    const next = new AbortController(); request = next; loading = true; error = "";
    return next;
  }
  async function loadSources(): Promise<void> {
    if (disabled) return;
    const next = begin(); page = null; directoryId = null;
    try {
      const items = await gallery.listSources(next.signal);
      if (request === next && !next.signal.aborted) sources = items;
    } catch {
      if (request === next && !next.signal.aborted) error = "参考图库加载失败，请重试。";
    } finally { if (request === next) { request = null; loading = false; } }
  }
  async function loadDirectory(id: string, more: "directories" | "assets" | null = null): Promise<void> {
    if (disabled) return;
    directoryId = id;
    const previous = page;
    const next = begin();
    if (!more) page = null;
    try {
      const result = await gallery.listDirectoryEntries({
        directoryId: id, includeDescendants: false, txtState: null, query: "",
        directoryCursor: more === "directories" ? previous?.directory_cursor ?? null : null,
        assetCursor: more === "assets" ? previous?.asset_cursor ?? null : null,
      }, next.signal);
      if (request !== next || next.signal.aborted) return;
      if (more && previous) {
        page = {
          ...previous,
          ...(more === "directories" ? {
            directories: Array.from(new Map([...previous.directories, ...result.directories].map((item) => [item.directory_id, item])).values()),
            directory_cursor: result.directory_cursor,
          } : {
            assets: Array.from(new Map([...previous.assets, ...result.assets].map((item) => [item.asset_id, item])).values()),
            asset_cursor: result.asset_cursor,
          }),
        };
      } else page = result;
    } catch {
      if (request === next && !next.signal.aborted) error = "参考图库加载失败，请重试。";
    } finally { if (request === next) { request = null; loading = false; } }
  }
  async function openPicker(): Promise<void> {
    if (disabled) return;
    selected = [...references]; picking = true;
    void loadSources();
    await tick(); pickerHeading?.focus({ preventScroll: true });
  }
  async function closePicker(apply: boolean): Promise<void> {
    if (apply && !disabled) onChange({ ...options, reference_asset_ids: [...selected] });
    abort(); picking = false; error = "";
    await tick(); addButton?.focus({ preventScroll: true });
  }
  function toggleReference(id: string): void {
    if (disabled) return;
    if (selected.includes(id)) selected = selected.filter((value) => value !== id);
    else if (selected.length < 200) selected = [...selected, id];
  }
  function change(key: keyof typeof FILTER_LABELS, checked: boolean): void {
    if (!disabled) onChange({ ...options, [key]: checked });
  }
  function remove(id: string): void {
    if (!disabled) onChange({ ...options, reference_asset_ids: options.reference_asset_ids.filter((value) => value !== id) });
  }
  $effect(() => { if (disabled) untrack(abort); });
  onDestroy(abort);
</script>

{#if picking}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape exits the internal picker, not the caller's dialog) -->
  <section class="filter-reference-picker" data-filter-reference-picker aria-label="参考图选取" onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void closePicker(false); } }}>
    <header class="filter-toolbar"><h3 tabindex="-1" bind:this={pickerHeading}>从图库选择参考图</h3><button type="button" onclick={() => void closePicker(false)}>取消选图</button></header>
    <p class="filter-help">这里只选择角色参考图，不改变待处理图片的选区。点击“使用所选参考图”后写入配置。</p>
    <div class="filter-toolbar">
      <button type="button" disabled={loading} onclick={() => void loadSources()}>来源列表</button>
      {#if page}<button type="button" disabled={loading} onclick={() => page?.directory.parent_id ? void loadDirectory(page.directory.parent_id) : void loadSources()}>返回上级</button><strong>{page.directory.name}</strong>{/if}
      <span>已选参考图</span><output>{selected.length} / 200</output>
    </div>
    {#if loading}<p role="status">正在加载参考图库…</p>{/if}
    {#if error}<p role="alert">{error}</p><button type="button" disabled={loading} onclick={() => directoryId ? void loadDirectory(directoryId) : void loadSources()}>重试</button>{/if}
    {#if !page && !loading && !error}
      <ul class="filter-source-list" aria-label="参考图来源">
        {#each sources as source (source.source_id)}
          <li><button type="button" disabled={disabled || source.availability !== "available" || !source.root_directory_id} onclick={() => source.root_directory_id && void loadDirectory(source.root_directory_id)}>{source.display_name}</button>{#if source.availability !== "available" || !source.root_directory_id}<span>来源暂不可浏览</span>{/if}</li>
        {:else}<li>暂无图库来源</li>{/each}
      </ul>
    {:else if page}
      <ul class="filter-directory-list" aria-label="参考图目录">
        {#each page.directories as directory (directory.directory_id)}
          <li><button type="button" disabled={loading || disabled} onclick={() => void loadDirectory(directory.directory_id)}>{directory.name}</button></li>
        {/each}
      </ul>
      {#if page.directory_cursor}<button type="button" disabled={loading || disabled} onclick={() => page && void loadDirectory(page.directory.directory_id, "directories")}>加载更多目录</button>{/if}
      <div class="filter-reference-grid" role="group" aria-label="可选参考图">
        {#each page.assets as asset (asset.asset_id)}
          <label class="filter-image-choice" data-selected={selected.includes(asset.asset_id)}>
            <img src={gallery.thumbnailUrl(asset.asset_id, 256)} alt="" loading="lazy" />
            <span>{asset.name}</span>
            <input type="checkbox" aria-label={asset.name} checked={selected.includes(asset.asset_id)} disabled={disabled || (!selected.includes(asset.asset_id) && selected.length >= 200)} onchange={() => toggleReference(asset.asset_id)} />
          </label>
        {:else}<p>此目录暂无图片</p>{/each}
      </div>
      {#if page.asset_cursor}<button type="button" disabled={loading || disabled} onclick={() => page && void loadDirectory(page.directory.directory_id, "assets")}>加载更多图片</button>{/if}
    {/if}
    <h3>已选参考图</h3>
    <ul class="filter-reference-grid" aria-label="待使用的参考图">
      {#each selected as id, index (id)}
        <li class="filter-reference"><img src={gallery.thumbnailUrl(id, 256)} alt="" loading="lazy" /><span id={`${uid}-selected-${index}`}>{id}</span><button type="button" disabled={disabled} aria-describedby={`${uid}-selected-${index}`} onclick={() => { toggleReference(id); void tick().then(() => pickerHeading?.focus({ preventScroll: true })); }}>移除参考图</button></li>
      {/each}
    </ul>
    <div class="filter-toolbar"><button type="button" disabled={disabled} onclick={() => void closePicker(true)}>使用所选参考图</button><button type="button" onclick={() => void closePicker(false)}>取消选图</button></div>
  </section>
{:else}
  <div class="filter-options-editor" data-filter-options-editor>
    <fieldset disabled={disabled}><legend>自动去重</legend>
      <label class="filter-toggle"><input type="checkbox" checked={options.basic_dedup} onchange={(event) => change("basic_dedup", event.currentTarget.checked)} /><span>{FILTER_LABELS.basic_dedup}</span></label>
    </fieldset>
    <fieldset disabled={disabled}><legend>自动过滤</legend>
      {#each FILTER_CAPABILITY_KEYS as key}
        <label class="filter-toggle"><input type="checkbox" checked={options[key]} aria-describedby={`${uid}-${key}-capability`} onchange={(event) => change(key, event.currentTarget.checked)} /><span>{FILTER_LABELS[key]}</span></label>
        <p id={`${uid}-${key}-capability`} class="filter-help" data-filter-capability={key}>
          {#if capabilities?.[key]?.available === true}过滤能力已就绪
          {:else}<strong>暂不可执行</strong><span> · </span><span>{capabilities?.[key]?.reason || "过滤能力未加载，暂不可执行。"}</span>{/if}
        </p>
      {/each}
      <p class="filter-help">单色模型基于动漫图训练。CCIP 角色过滤偏保守，多人图不保证准确；请使用清晰参考图。</p>
      <p class="filter-help">素描暂缓，不能准备；请明确取消勾选后再执行。不可用选项仍可保存为预设。</p>
    </fieldset>
    {#if requiredModels.length || preparing || modelError || setup?.phase === "failed"}
      <section class="filter-model-setup" data-filter-model-setup aria-labelledby={`${uid}-models-heading`} aria-busy={preparing}>
        <h3 id={`${uid}-models-heading`}>准备已选过滤模型</h3>
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
            <p class="filter-help">不会下载素描或 SSCD/DINO；确认后联网下载并进行离线推理检查。</p>
            <label class="filter-preset-name"><span>本次下载代理（可选）</span><input type="text" bind:value={modelProxy} placeholder="http://127.0.0.1:7890" autocomplete="off" spellcheck="false" disabled={preparing || !active || prepareDisabled} aria-invalid={!!modelProxyError} aria-describedby={`${uid}-proxy-help`} /></label>
            <p id={`${uid}-proxy-help`} class="filter-help">仅用于本次模型下载，不修改全局代理。</p>
            {#if modelProxyError}<p role="alert">{modelProxyError}</p>{/if}
            <div class="filter-toolbar"><button type="button" disabled={preparing || !active || prepareDisabled} onclick={() => void refreshModels(true)}>确认准备</button><button type="button" disabled={preparing} onclick={() => { modelConfirmation = false; modelProxy = ""; modelProxyError = ""; }}>取消准备</button></div>
          </div>
        {:else if requiredModels.length}
          <button type="button" disabled={preparing || !active || prepareDisabled} onclick={() => { modelConfirmation = true; modelProxyError = ""; }}>{modelError || setup?.phase === "failed" ? "重试准备模型" : "准备已选过滤模型"}</button>
        {/if}
        <button type="button" disabled={modelLoading || !active} onclick={() => void refreshModels()}>刷新过滤能力</button>
      </section>
    {/if}
    <fieldset disabled={disabled}><legend>人工辅助</legend>
      <label class="filter-toggle"><input type="checkbox" checked={options.similarity_groups} aria-describedby={`${uid}-similarity-help`} onchange={(event) => change("similarity_groups", event.currentTarget.checked)} /><span>{FILTER_LABELS.similarity_groups}</span></label>
      <p id={`${uid}-similarity-help`} class="filter-help">只分组供人工判断，不自动排除差分。</p>
    </fieldset>
    <section aria-labelledby={`${uid}-references-heading`}>
      <header class="filter-toolbar"><h3 id={`${uid}-references-heading`}>角色参考图</h3><output>{references.length} / 200</output></header>
      <p class="filter-help">执行角色过滤前需添加参考图；空参考图仍可保存为模板。</p>
      <div class="filter-toolbar"><button type="button" bind:this={addButton} disabled={disabled} onclick={() => void openPicker()}>从图库添加</button><button type="button" disabled={disabled || !references.length} onclick={() => onChange({ ...options, reference_asset_ids: [] })}>清空参考图</button></div>
      <ul class="filter-reference-grid" aria-label="已保存到配置的参考图">
        {#each references as id, index (id)}
          <li class="filter-reference"><img src={gallery.thumbnailUrl(id, 256)} alt="" loading="lazy" /><span id={`${uid}-reference-${index}`}>{id}</span><button type="button" disabled={disabled} aria-describedby={`${uid}-reference-${index}`} onclick={() => remove(id)}>移除参考图</button></li>
        {:else}<li class="filter-help">尚未添加参考图</li>{/each}
      </ul>
    </section>
  </div>
{/if}
