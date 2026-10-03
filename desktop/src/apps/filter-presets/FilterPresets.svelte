<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ApiClient } from "../../core/api/client";
  import { translateCurrentUiText } from "../../core/i18n";
  import { createFilterPresetService } from "./service";
  import { cloneFilterOptions, EMPTY_FILTER_OPTIONS, validateFilterName, type FilterPreset, type FilterOptions, type FilterCapabilities } from "./model";
  import type { ModelSetupSnapshot } from "../review/model";
  import FilterOptionsEditor from "./FilterOptionsEditor.svelte";
  import "./filter-presets.css";

  let { api, active = true, registerUnsavedChanges }: {
    api: ApiClient;
    active?: boolean;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void) => () => void;
  } = $props();
  const service = untrack(() => createFilterPresetService(api));
  let items = $state<readonly FilterPreset[]>([]);
  let selectedId = $state<string | null>(null);
  let name = $state("");
  let options = $state<FilterOptions>(cloneFilterOptions(EMPTY_FILTER_OPTIONS));
  let creating = $state(false);
  let loaded = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let message = $state("");
  let loadError = $state("");
  let capabilities = $state<FilterCapabilities | null>(null);
  let modelSetup = $state<ModelSetupSnapshot | null>(null);
  function updateModelSetup(next: ModelSetupSnapshot | null): void {
    capabilityRequest?.abort(); capabilityRequest = null;
    modelSetup = next; capabilities = next?.reviewFilters ?? null; capabilityError = "";
  }
  let capabilityError = $state("");
  let editorRevision = $state(0);
  let request: AbortController | null = null;
  let capabilityRequest: AbortController | null = null;
  let destroyed = false;
  const selected = $derived(items.find(({ id }) => id === selectedId) ?? null);
  const dirty = $derived(creating || !!selected && (name !== selected.name || JSON.stringify(options) !== JSON.stringify(selected.options)));
  const validName = $derived.by(() => { try { validateFilterName(name); return true; } catch { return false; } });

  function label(item: FilterPreset): string {
    if (item.id === "builtin-style") return "画风 LoRA";
    if (item.id === "builtin-character") return "角色 LoRA";
    return item.name;
  }
  function select(item: FilterPreset | null): void {
    editorRevision += 1;
    selectedId = item?.id ?? null; creating = false;
    name = item?.name ?? ""; options = cloneFilterOptions(item?.options ?? EMPTY_FILTER_OPTIONS);
  }
  function discard(): void { select(selected ?? items[0] ?? null); message = "已取消预设修改。"; }
  function mayDiscard(): boolean {
    return !dirty || window.confirm(translateCurrentUiText("放弃当前预设的未保存修改？"));
  }
  function choose(item: FilterPreset): void {
    if (busy || item.id === selectedId && !creating || !mayDiscard()) return;
    select(item); message = "";
  }
  function newPreset(copy: boolean): void {
    if (busy || !loaded || !mayDiscard()) return;
    const copied = copy ? cloneFilterOptions(options) : cloneFilterOptions(EMPTY_FILTER_OPTIONS);
    const copiedName = copy ? name : "";
    editorRevision += 1; selectedId = null; creating = true; name = copiedName; options = copied;
    message = "新预设尚未保存。";
  }
  async function load(): Promise<void> {
    if (!active || request) return;
    const next = new AbortController(); request = next; loading = true; loadError = "";
    try {
      const result = await service.list(next.signal);
      if (request !== next || next.signal.aborted || destroyed) return;
      items = result; loaded = true;
      if (!dirty && !creating) select(result.find(({ id }) => id === selectedId) ?? result[0] ?? null);
    } catch {
      if (request === next && !next.signal.aborted && !destroyed) loadError = "筛选预设加载失败，请重试。";
    } finally { if (request === next) { request = null; loading = false; } }
  }
  async function loadCapabilities(): Promise<void> {
    if (!active) return;
    capabilityRequest?.abort();
    const next = new AbortController(); capabilityRequest = next; capabilities = null; modelSetup = null; capabilityError = "";
    try {
      const result = await service.readModelSetup(next.signal);
      if (capabilityRequest === next && !next.signal.aborted && !destroyed) { modelSetup = result; capabilities = result.reviewFilters; }
    } catch {
      if (capabilityRequest === next && !next.signal.aborted && !destroyed) capabilityError = "过滤能力加载失败；未加载的过滤项不可执行。";
    } finally { if (capabilityRequest === next) capabilityRequest = null; }
  }
  async function save(): Promise<void> {
    if (busy || !active || !validName || !dirty || selected?.builtin) return;
    busy = true; message = "";
    const revision = editorRevision;
    const id = selectedId;
    try {
      const saved = id ? await service.update(id, name, options) : await service.create(name, options);
      if (destroyed) return;
      items = id ? items.map((item) => item.id === id ? saved : item) : [...items, saved];
      if (revision === editorRevision) { select(saved); message = "筛选预设已保存。"; }
    } catch {
      if (!destroyed && revision === editorRevision) message = "筛选预设保存失败，请重试。";
    } finally { if (!destroyed) busy = false; }
  }
  async function remove(): Promise<void> {
    if (busy || !selected || selected.builtin || !active) return;
    if (!window.confirm(translateCurrentUiText("删除此自定义预设？此操作不可撤销，不会删除参考图片。"))) return;
    const id = selected.id;
    const revision = editorRevision;
    busy = true; message = "";
    try {
      await service.remove(id);
      if (destroyed) return;
      items = items.filter((item) => item.id !== id);
      if (revision === editorRevision) { select(items[0] ?? null); message = "自定义预设已删除。"; }
    } catch {
      if (!destroyed && revision === editorRevision) message = "筛选预设删除失败，请重试。";
    } finally { if (!destroyed) busy = false; }
  }
  $effect(() => {
    if (active) untrack(() => { if (!loaded) void load(); void loadCapabilities(); });
    else untrack(() => {
      request?.abort(); request = null; loading = false;
      capabilityRequest?.abort(); capabilityRequest = null; capabilities = null;
    });
  });
  onMount(() => {
    const unregister = registerUnsavedChanges?.(() => dirty || busy, discard) ?? (() => {});
    return () => { destroyed = true; request?.abort(); capabilityRequest?.abort(); unregister(); };
  });
</script>

<section class="filter-presets-app" data-filter-presets-app aria-labelledby="filter-presets-heading" aria-busy={busy || loading}>
  <header class="filter-presets-header"><h1 id="filter-presets-heading">筛选预设</h1><span role="status">{busy ? "正在保存…" : dirty ? "有未保存的更改" : ""}</span></header>
  <p class="filter-help">各功能可自由组合；未就绪的自动过滤可保存配置，但不能执行。</p>
  {#if loadError}<p role="alert">{loadError}</p><button type="button" disabled={loading || !active} onclick={() => void load()}>重试</button>{/if}
  {#if loading}<p role="status">正在加载筛选预设…</p>{/if}
  <div class="filter-presets-layout">
    <aside class="filter-presets-list" aria-label="筛选预设列表">
      <button type="button" disabled={busy || !loaded} onclick={() => newPreset(false)}>新建预设</button>
      <h2>内置预设</h2>
      <ul>{#each items.filter((item) => item.builtin) as item (item.id)}<li><button type="button" disabled={busy} aria-current={selectedId === item.id ? "true" : undefined} onclick={() => choose(item)}>{label(item)}</button></li>{/each}</ul>
      <h2>自定义预设</h2>
      <ul>{#each items.filter((item) => !item.builtin) as item (item.id)}<li><button type="button" disabled={busy} aria-current={selectedId === item.id ? "true" : undefined} onclick={() => choose(item)}>{item.name}</button></li>{:else}<li class="filter-help">暂无自定义预设</li>{/each}</ul>
    </aside>
    <section class="filter-preset-detail" aria-label="筛选预设编辑">
      {#if selected || creating}
        <div class="filter-toolbar">
          <button type="button" disabled={busy} onclick={() => newPreset(true)}>{selected?.builtin ? "另存为自定义" : "复制预设"}</button>
          {#if selected && !selected.builtin}<button type="button" disabled={busy} onclick={() => void remove()}>删除预设</button>{/if}
        </div>
        {#if selected?.builtin}<p class="filter-help">内置预设只读；请另存为自定义后编辑。</p>{/if}
        <label class="filter-preset-name"><span>预设名称</span><input type="text" value={name} maxlength="80" disabled={busy || selected?.builtin || !active} oninput={(event) => { name = event.currentTarget.value; }} aria-describedby="filter-name-help" /></label>
        <p id="filter-name-help" class="filter-help">名称需为 1–80 个字符，不能包含控制字符。</p>
        {#if capabilityError}<p role="alert">{capabilityError}</p><button type="button" disabled={busy || !active} onclick={() => void loadCapabilities()}>重试过滤能力</button>{/if}
        {#key editorRevision}
          <FilterOptionsEditor {api} {options} {capabilities} {active} setup={modelSetup} onModelSetup={updateModelSetup} prepareDisabled={busy} disabled={busy || !!selected?.builtin || !active} onChange={(next) => { options = cloneFilterOptions(next); }} />
        {/key}
        {#if !selected?.builtin}
          <div class="filter-toolbar filter-preset-actions"><button type="button" disabled={busy || !dirty || !validName || !active} onclick={() => void save()}>保存预设</button><button type="button" disabled={busy || !dirty} onclick={discard}>取消修改</button></div>
        {/if}
      {:else if loaded}<p>新建预设或选择一个已有预设。</p>{/if}
      <p role="status" aria-live="polite">{message}</p>
    </section>
  </div>
</section>
