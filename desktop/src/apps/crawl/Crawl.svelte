<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import type { ApplicationId } from "../../core/applications/definitions";
  import type { ApiClient } from "../../core/api/client";
  import type { PersistenceService } from "../../core/persistence/service";
  import { createCrawlController } from "./controller";
  import {
    CRAWL_SITE_DEFINITIONS,
    validateCrawlDraft,
    validateSearchDraft,
    visibleCandidateKeys,
    type CrawlDraft,
    type CrawlFilterMode,
    type CrawlProxyMode,
    type CrawlSiteId,
    type SearchDraft,
  } from "./model";
  import { createCrawlService } from "./service";
  import {
    crawlCandidates,
    crawlSources,
    createCrawlStore,
    selectedCrawlCandidates,
    visibleEhFacets,
  } from "./state";
  import CandidateRow from "./CandidateRow.svelte";
  import "./crawl.css";

  let { api, persistence, onNavigate }: {
    api: ApiClient;
    persistence: PersistenceService;
    onNavigate: (appId: ApplicationId) => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createCrawlStore();
    return {
      store,
      controller: createCrawlController({
        store,
        service: createCrawlService(api),
        persistence,
        onNavigate,
      }),
    };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const sources = $derived(crawlSources(snapshot));
  const activeSource = $derived(snapshot.activeSourceKey ? snapshot.sources[snapshot.activeSourceKey] : null);
  const candidates = $derived(crawlCandidates(snapshot));
  const selected = $derived(selectedCrawlCandidates(snapshot));

  let root = $state<HTMLElement>();
  let keyword = $state("");
  let sites = $state<CrawlSiteId[]>(CRAWL_SITE_DEFINITIONS.map(({ id }) => id));
  let searchLimit = $state(20);
  let searchProxy = $state<CrawlProxyMode>("required");
  let sourceProxyModes = $state<Record<CrawlSiteId, CrawlProxyMode | "">>({
    danbooru: "",
    twitter: "",
    pixiv: "",
    exhentai: "",
    pawchive: "",
  });
  let concurrency = $state(20);
  let maxTasks = $state(10_000);
  let crawlProxy = $state<CrawlProxyMode>("required");
  let outputDir = $state("");
  let outputDirInvalid = $state(false);
  let imageMode = $state<"original" | "resample">("original");
  let gpPolicy = $state<"stop" | "resized">("stop");
  let ehQuery = $state("");
  let suggestionIndex = $state(-1);

  const searchDraft = $derived<SearchDraft>({
    keyword,
    sites,
    limit: Number(searchLimit),
    proxyMode: searchProxy,
    sourceProxyModes,
  });
  const crawlDraft = $derived<CrawlDraft>({
    concurrency: Number(concurrency),
    maxTasks: Number(maxTasks),
    proxyMode: crawlProxy,
    outputDir,
    outputDirInvalid,
    sourceProxyModes,
    ehDownload: { image_mode: imageMode, gp_policy: gpPolicy },
  });
  const searchValidation = $derived(validateSearchDraft(searchDraft));
  const crawlValidation = $derived(validateCrawlDraft(crawlDraft));
  const ehFacets = $derived(visibleEhFacets(snapshot, ehQuery));
  const canCreate = $derived(
    !snapshot.busy
    && snapshot.operationalAvailable
    && selected.length > 0
    && crawlValidation.valid,
  );

  function selectedInSource(sourceKey: (typeof sources)[number]["key"]): number {
    return (snapshot.candidateOrder[sourceKey] ?? [])
      .filter((key) => snapshot.candidates[key]?.selected).length;
  }

  function toggleSite(site: CrawlSiteId, enabled: boolean): void {
    sites = enabled
      ? CRAWL_SITE_DEFINITIONS.map(({ id }) => id).filter((id) => id === site || sites.includes(id))
      : sites.filter((id) => id !== site);
  }

  function chooseSuggestion(value: string): void {
    keyword = value;
    suggestionIndex = -1;
    store.setSuggestions([]);
    void tick().then(() => root?.querySelector<HTMLInputElement>("[data-crawl-keyword]")?.focus({ preventScroll: true }));
  }

  function onKeywordInput(value: string): void {
    keyword = value;
    suggestionIndex = -1;
    controller.requestAutocomplete(value);
  }

  function onSuggestionKeydown(event: KeyboardEvent): void {
    const count = snapshot.suggestions.length;
    if (event.key === "Escape") {
      if (!count) return;
      event.preventDefault();
      store.setSuggestions([]);
      suggestionIndex = -1;
      root?.querySelector<HTMLInputElement>("[data-crawl-keyword]")?.focus({ preventScroll: true });
      return;
    }
    if (!count || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") suggestionIndex = 0;
    else if (event.key === "End") suggestionIndex = count - 1;
    else if (event.key === "ArrowDown") suggestionIndex = Math.min(count - 1, suggestionIndex + 1);
    else suggestionIndex = Math.max(0, suggestionIndex < 0 ? count - 1 : suggestionIndex - 1);
    void tick().then(() => root?.querySelector<HTMLButtonElement>(`#crawl-suggestion-${suggestionIndex}`)?.focus({ preventScroll: true }));
  }

  async function runSearch(): Promise<void> {
    if (!searchValidation.valid) {
      store.setMessage(searchValidation.reason);
      return;
    }
    await controller.search(searchDraft);
  }

  async function createBatch(): Promise<void> {
    if (!canCreate) {
      store.setMessage(crawlValidation.valid ? "请先选择至少一个候选地址。" : crawlValidation.reason);
      return;
    }
    const request = controller.create(crawlDraft);
    outputDir = "";
    outputDirInvalid = false;
    await request;
  }

  function cycleTag(key: string): void {
    const current: CrawlFilterMode | "" = Object.hasOwn(snapshot.ehTagFilter, key)
      ? snapshot.ehTagFilter[key]
      : "";
    store.setEhTagFilter(key, current === "" ? "include" : current === "include" ? "exclude" : "");
  }

  function preventUnsafeOutput(event: InputEvent): void {
    if (typeof event.data !== "string" || !/[\u0000-\u001f\u007f]/.test(event.data)) return;
    event.preventDefault();
    outputDirInvalid = true;
  }

  function onFocusOut(event: FocusEvent): void {
    const field = event.target instanceof Element ? event.target.closest(".crawl-field--keyword") : null;
    if (!field || (event.relatedTarget instanceof Node && field.contains(event.relatedTarget))) return;
    queueMicrotask(() => {
      if (!(document.activeElement instanceof Node) || !field.contains(document.activeElement)) {
        store.setSuggestions([]);
        suggestionIndex = -1;
      }
    });
  }

  onMount(() => {
    controller.activate();
    return () => {
      outputDir = "";
      outputDirInvalid = false;
      controller.destroy();
    };
  });
</script>

<section
  class="crawl-app"
  data-crawl-app
  data-domain-owner="crawl"
  aria-labelledby="crawl-heading"
  aria-busy={Boolean(snapshot.busy)}
  bind:this={root}
  onfocusout={onFocusOut}
>
  <header class="crawl-header">
    <div>
      <h1 id="crawl-heading">采集</h1>
    </div>
    <span class="crawl-status" data-kind={snapshot.phase === "error" ? "error" : snapshot.busy ? "running" : "ready"}>
      {snapshot.busy === "search" ? "正在搜索" : snapshot.busy === "crawl" ? "正在创建" : snapshot.phase === "error" ? "需要处理" : "就绪"}
    </span>
  </header>

  {#if snapshot.error}
    <section class="crawl-error" role="alert" aria-labelledby="crawl-error-title">
      <div>
        <strong id="crawl-error-title">{snapshot.error.title}</strong>
        <p>{snapshot.error.message} {snapshot.error.nextStep}</p>
        <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
      </div>
      <button type="button" onclick={() => onNavigate(snapshot.error!.targetApp)}>打开恢复工具</button>
    </section>
  {/if}

  <p class="crawl-live" role="status" aria-live="polite">{snapshot.message.replaceAll("操作地址已安全清理，需要重新搜索后才能创建批次。", "请重新搜索，再创建批次。")}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable workspace) -->
  <section class="crawl-workspace" tabindex="0" aria-label="图片采集工作区">
    <div class="crawl-workspace__track">
      <aside class="crawl-column crawl-column--sources" aria-labelledby="crawl-sources-heading">
        <header><h2 id="crawl-sources-heading">来源与顺序</h2></header>
        <div class="crawl-column__scroll">
          {#if sources.length}
            <nav class="crawl-source-list" aria-label="采集来源顺序与当前来源">
              {#each sources as source, index (source.key)}
                <section class:active={source.key === snapshot.activeSourceKey} data-source-key={source.key}>
                  <button
                    type="button"
                    class="crawl-source-select"
                    aria-current={source.key === snapshot.activeSourceKey ? "page" : undefined}
                    aria-label={`第 ${index + 1} 个来源，${source.label}，${selectedInSource(source.key)} 个已选地址`}
                    onclick={() => store.setActiveSource(source.key)}
                  >{index + 1}. {source.label}</button>
                  <small>{source.status === "succeeded" ? "完整" : source.status === "partial" ? "部分" : "失败"} · {selectedInSource(source.key)} 已选</small>
                  <span class="crawl-order-actions">
                    <button type="button" disabled={index === 0} aria-label={`将来源 ${source.label} 上移一位`} onclick={() => store.moveSource(source.key, -1)}>上移</button>
                    <button type="button" disabled={index === sources.length - 1} aria-label={`将来源 ${source.label} 下移一位`} onclick={() => store.moveSource(source.key, 1)}>下移</button>
                  </span>
                </section>
              {/each}
            </nav>
          {/if}
          <fieldset class="crawl-panel crawl-source-settings" aria-describedby="crawl-source-discovery-note">
            <legend>搜索来源</legend>
            <details class="crawl-discovery-note"><summary>来源发现范围</summary><p id="crawl-source-discovery-note">Danbooru、EH 与 Pawchive / Pawoo 支持站内搜索；X / Twitter 与 Pixiv 从 Danbooru 画师目录查找关联账户，采集时需要相应授权。</p></details>
            {#each CRAWL_SITE_DEFINITIONS as site (site.id)}
              <div class="crawl-source-setting">
                <label>
                  <input
                    type="checkbox"
                    checked={sites.includes(site.id)}
                    aria-label={`启用 ${site.label}`}
                    onchange={(event) => toggleSite(site.id, (event.currentTarget as HTMLInputElement).checked)}
                  />
                  <strong>{site.label}</strong>
                </label>
              </div>
            {/each}
          </fieldset>
          <details class="crawl-advanced">
            <summary>各来源代理设置</summary>
            <div class="crawl-advanced__body">
              {#each CRAWL_SITE_DEFINITIONS as site (site.id)}
                <label class="crawl-field">
                  <span>{site.label} 代理覆盖</span>
                  <select aria-label={`${site.label} 代理覆盖`} bind:value={sourceProxyModes[site.id]}>
                    <option value="">使用全局设置</option>
                    <option value="required">仅使用代理</option>
                    <option value="prefer">优先代理，不可用时直连</option>
                    <option value="direct">不使用代理</option>
                  </select>
                </label>
              {/each}
            </div>
          </details>


          {#if activeSource?.site === "exhentai" && activeSource.tagFacets.length}
            <section class="crawl-eh" aria-labelledby="crawl-eh-heading">
              <h3 id="crawl-eh-heading">EH 标签</h3>
              <p>只基于当前可见候选计算；同分类任选，跨分类同时满足，排除优先。</p>
              <label><span>标签检索</span><input type="search" aria-label="检索 EH 标签" bind:value={ehQuery} /></label>
              {#each ehFacets as facet (`${facet.namespace}:${facet.label}`)}
                <details open={Boolean(ehQuery) || facet.tags.some(({ key }) => Boolean(snapshot.ehTagFilter[key]))}>
                  <summary>{facet.label} · {facet.galleryCount} 画廊</summary>
                  <div class="crawl-tag-list">
                    {#each facet.tags as tag (tag.key)}
                      <button
                        type="button"
                        data-mode={snapshot.ehTagFilter[tag.key] ?? "none"}
                        aria-label={`${facet.label} ${tag.value}，${snapshot.ehTagFilter[tag.key] === "include" ? "包含" : snapshot.ehTagFilter[tag.key] === "exclude" ? "排除" : "未筛选"}，按下切换筛选模式`}
                        onclick={() => cycleTag(tag.key)}
                      >{tag.value} · {tag.count} · {snapshot.ehTagFilter[tag.key] === "include" ? "包含" : snapshot.ehTagFilter[tag.key] === "exclude" ? "排除" : "未筛选"}</button>
                    {/each}
                  </div>
                </details>
              {/each}
              <button type="button" onclick={() => { store.clearEhTagFilter(); ehQuery = ""; }}>清空标签筛选</button>
            </section>
          {/if}
        </div>
      </aside>

      <section class="crawl-column crawl-column--candidates" aria-labelledby="crawl-candidates-heading">
        <header><h2 id="crawl-candidates-heading">搜索与候选地址</h2><span>勾选要采集的地址，可用上移、下移调整顺序。</span></header>
        <div class="crawl-column__scroll">
          <form class="crawl-search" onsubmit={(event) => { event.preventDefault(); void runSearch(); }}>
            <label class="crawl-field crawl-field--keyword">
              <span>关键词</span>
              <input
                data-crawl-keyword
                type="search"
                maxlength="1000"
                required
                autocomplete="off"
                placeholder="画师、角色或作品关键词"
                role="combobox"
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-expanded={snapshot.suggestions.length > 0}
                aria-controls="crawl-suggestions"
                aria-activedescendant={suggestionIndex >= 0 ? `crawl-suggestion-${suggestionIndex}` : undefined}
                aria-invalid={keyword.length > 0 && !searchValidation.valid && searchValidation.field === "keyword"}
                value={keyword}
                oninput={(event) => onKeywordInput((event.currentTarget as HTMLInputElement).value)}
                onkeydown={onSuggestionKeydown}
              />
              {#if snapshot.suggestions.length}
                <div class="crawl-suggestions" id="crawl-suggestions" role="listbox">
                  {#each snapshot.suggestions as suggestion, index (suggestion.key)}
                    <button
                      type="button"
                      id={`crawl-suggestion-${index}`}
                      role="option"
                      aria-selected={suggestionIndex === index}
                      tabindex="-1"
                      onpointerdown={(event) => event.preventDefault()}
                      onkeydown={onSuggestionKeydown}
                      onclick={() => chooseSuggestion(suggestion.value)}
                    >
                      <strong>{suggestion.category}</strong><span>{suggestion.label}</span>
                      {#if suggestion.antecedent}<small>别名 {suggestion.antecedent}</small>{/if}
                      {#if suggestion.postCount}<small>{suggestion.postCount} 图</small>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </label>
            <div class="crawl-search__controls">
              <label class="crawl-field"><span>结果上限</span><input type="number" min="1" max="200" bind:value={searchLimit} /></label>
              <label class="crawl-field"><span>全局搜索代理</span><select bind:value={searchProxy}><option value="required">仅使用代理</option><option value="prefer">优先代理，不可用时直连</option><option value="direct">不使用代理</option></select></label>
            </div>
            {#if !searchValidation.valid && (searchValidation.field !== "keyword" || keyword.length > 0)}<p class="crawl-validation" role="status">{searchValidation.reason}</p>{/if}
            <button type="submit" class="primary" disabled={Boolean(snapshot.busy) || !searchValidation.valid}>{snapshot.busy === "search" ? "正在搜索…" : "搜索来源"}</button>
          </form>

          <section class="crawl-result" aria-labelledby="crawl-current-source-heading">
            <div class="crawl-section-heading">
              <div><h3 id="crawl-current-source-heading">{activeSource ? `${activeSource.label} 候选地址` : "尚无来源结果"}</h3><p>{candidates.length} 个当前显示 · {activeSource ? selectedInSource(activeSource.key) : 0} 个已选</p></div>
              <span class="crawl-toolbar">
                <label><input type="checkbox" checked={snapshot.showWeakEvidence} onchange={(event) => store.setWeakEvidenceVisible((event.currentTarget as HTMLInputElement).checked)} />显示待核实候选</label>
                <button type="button" onclick={() => activeSource && store.setCandidatesSelected(visibleCandidateKeys(snapshot, activeSource.key), true)}>全选当前显示</button>
                <button type="button" onclick={() => activeSource && store.setCandidatesSelected(snapshot.candidateOrder[activeSource.key] ?? [], false)}>清空当前来源</button>
              </span>
            </div>
            {#if activeSource?.errorCode}<p class="crawl-source-warning">来源搜索失败（{activeSource.errorCode}）{activeSource.errorMessage ? `：${activeSource.errorMessage}` : ""}。请检查授权或代理后重试。</p>{/if}
            {#if activeSource?.auth.known && !activeSource.auth.authorized && activeSource.auth.state === "required"}
              <p class="crawl-source-warning">{activeSource.label} 需要授权。<button type="button" onclick={() => onNavigate("vault")}>打开授权管理</button></p>
            {/if}
            <div class="crawl-candidate-list">
              {#each candidates as candidate, index (candidate.key)}
                <CandidateRow
                  {candidate}
                  first={index === 0}
                  last={index === candidates.length - 1}
                  onSelected={(value) => store.setCandidateSelected(candidate.key, value)}
                  onMove={(direction) => store.moveCandidate(candidate.key, direction)}
                />
              {:else}
                <p class="crawl-empty">{activeSource ? "当前来源没有可显示地址；调整筛选、关键词、授权或代理后重试。" : "输入关键词并搜索，候选会显示在这里。"}</p>
              {/each}
            </div>
            {#if snapshot.relatedProfiles.length}
              <details class="crawl-profiles">
                <summary>Danbooru 维护的关联主页（{snapshot.relatedProfiles.length}）</summary>
                <ul>{#each snapshot.relatedProfiles as profile (profile.key)}<li><a href={profile.url} target="_blank" rel="noreferrer noopener">{profile.artist} · {profile.platform} · {profile.host}</a></li>{/each}</ul>
              </details>
            {/if}
          </section>
        </div>
      </section>

      <aside class="crawl-column crawl-column--submit" aria-labelledby="crawl-submit-heading">
        <div class="crawl-submit-summary">
          <h2 id="crawl-submit-heading">创建批次</h2>
          <section class="crawl-selection" aria-labelledby="crawl-selection-heading">
            <h3 id="crawl-selection-heading">当前选择</h3>
            <strong>{new Set(selected.map(({ sourceKey }) => sourceKey)).size} 个来源</strong><span>{selected.length} 个地址</span>
          </section>
          <details class="crawl-advanced crawl-order-preview">
            <summary id="crawl-order-heading">预览执行顺序</summary>
            <ol class="crawl-execution">
              {#each sources.filter((source) => selectedInSource(source.key) > 0) as source (source.key)}
                <li><strong>{source.label}</strong><ol>{#each (snapshot.candidateOrder[source.key] ?? []).filter((key) => snapshot.candidates[key]?.selected) as key (key)}<li>{snapshot.candidates[key].label} · {snapshot.candidates[key].displayEndpoint}</li>{/each}</ol></li>
              {:else}<li>选择候选后在此预览执行顺序。</li>{/each}
            </ol>
          </details>
        </div>
        <form class="crawl-create" onsubmit={(event) => { event.preventDefault(); void createBatch(); }}>
          <details class="crawl-advanced crawl-batch-settings">
            <summary>批次设置 · 并发 {concurrency} · {selected.some(({ site }) => site === "exhentai") ? "代理、目录与 EH 选项" : "代理与输出目录"}</summary>
            <div class="crawl-advanced__body">
              <fieldset class="crawl-panel crawl-batch-fields">
                <legend>批次设置</legend>
                <label class="crawl-field"><span>单地址并发</span><input type="number" min="1" max="128" bind:value={concurrency} /></label>
                <label class="crawl-field"><span>最多任务数</span><input type="number" min="1" max="100000" bind:value={maxTasks} /></label>
                <label class="crawl-field"><span>下载代理</span><select bind:value={crawlProxy}><option value="required">仅使用代理</option><option value="prefer">优先代理，不可用时直连</option><option value="direct">不使用代理</option></select></label>
                <label class="crawl-field crawl-field--output"><span>输出目录（可选）</span><input type="text" maxlength="2048" autocomplete="off" placeholder="留空使用默认目录" value={outputDir} onbeforeinput={preventUnsafeOutput} oninput={(event) => { outputDir = (event.currentTarget as HTMLInputElement).value; outputDirInvalid = /[\u0000-\u001f\u007f]/.test(outputDir); }} /><small>仅用于本次提交，离开采集页后清空。</small></label>
              </fieldset>
              {#if selected.some(({ site }) => site === "exhentai")}
                <fieldset class="crawl-panel crawl-eh-download">
                  <legend>EH 下载选项</legend>
                  <label><input type="radio" name="eh-image-mode" value="original" bind:group={imageMode} />原图</label>
                  <label><input type="radio" name="eh-image-mode" value="resample" bind:group={imageMode} onchange={() => { gpPolicy = "stop"; }} />1280 查看图</label>
                  <label class="crawl-field"><span>原图 GP 不足时</span><select bind:value={gpPolicy} disabled={imageMode === "resample"}><option value="stop">停止该地址</option><option value="resized">降级到 1280 查看图</option></select></label>
                </fieldset>
              {/if}
            </div>
          </details>
          {#if !crawlValidation.valid}<p class="crawl-validation" role="status">{crawlValidation.reason}</p>{/if}
          {#if !snapshot.operationalAvailable}<p class="crawl-validation" role="alert">请重新搜索，再创建批次。</p>{/if}
          <div class="crawl-create-actions">
            <p class="crawl-submit-reason" aria-live="polite">{canCreate ? "按当前选择和顺序开始采集。" : selected.length ? crawlValidation.reason || "当前暂不可创建。" : "请先选择至少一个候选地址。"}</p>
            <button type="submit" class="primary" disabled={!canCreate}>{snapshot.busy === "crawl" ? "正在创建批次…" : "创建批次"}</button>
          </div>
        </form>
      </aside>
    </div>
  </section>
</section>
