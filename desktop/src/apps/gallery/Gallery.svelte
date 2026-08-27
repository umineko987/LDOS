<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { createGalleryController } from "./controller";
  import {
    GALLERY_AVAILABILITY_LABELS,
    GALLERY_DEDUP_STATE_LABELS,
    GALLERY_SOURCE_KIND_LABELS,
    GALLERY_TXT_STATE_LABELS,
    galleryBreadcrumb,
    galleryVisibleRange,
    type GalleryAssetEntry,
    type GalleryDirectoryEntry,
    type GalleryTxtState,
  } from "./model";
  import { createGalleryService } from "./service";
  import { createGalleryStore, type GalleryBrowseState } from "./state";
  import Viewer from "./Viewer.svelte";
  import "./gallery.css";

  let { api }: { api: ApiClient } = $props();

  const runtime = untrack(() => {
    const store = createGalleryStore();
    const service = createGalleryService(api);
    return { store, service, controller: createGalleryController({ store, service }) };
  });
  const { store, service, controller } = runtime;
  const snapshot: GalleryBrowseState = $derived($store);

  // ---- 虚拟化窗口状态（滚动驱动，非 store 事务） ----
  let contentScroll = $state(0);
  let contentHeight = $state(0);
  let gridColumns = $state(4);
  const GRID_CELL = 208;
  const GRID_ROW = 268;
  const LIST_ROW = 56;
  const OVERSCAN = 2;

  const rowHeight = $derived(snapshot.viewMode === "grid" ? GRID_ROW : LIST_ROW);
  const windowing = $derived(
    galleryVisibleRange({
      total: snapshot.assets.length,
      scrollTop: contentScroll,
      viewportHeight: contentHeight,
      columnCount: snapshot.viewMode === "grid" ? gridColumns : 1,
      rowHeight,
      overscanRows: OVERSCAN,
    }),
  );
  const visibleAssets = $derived(
    snapshot.assets.slice(windowing.startIndex, windowing.endIndex + 1),
  );

  const breadcrumb = $derived(
    snapshot.activeSourceId
      ? galleryBreadcrumb(
          snapshot.sources.find((item) => item.source_id === snapshot.activeSourceId)?.display_name
            ?? "来源",
          snapshot.path,
        )
      : [],
  );

  const txtStateOptions: readonly { value: string; label: string }[] = [
    { value: "", label: "全部 TXT 状态" },
    ...(Object.keys(GALLERY_TXT_STATE_LABELS) as GalleryTxtState[]).map((state) => ({
      value: state,
      label: GALLERY_TXT_STATE_LABELS[state],
    })),
  ];

  let searchDraft = $state("");

  function onContentScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    contentScroll = element.scrollTop;
    if (
      element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 3 &&
      (snapshot.directoryCursor !== null || snapshot.assetCursor !== null)
    ) {
      void controller.loadMore();
    }
  }

  function onContentResize(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      contentHeight = entry.contentRect.height;
      gridColumns = Math.max(1, Math.floor(entry.contentRect.width / GRID_CELL));
    }
  }

  // ---- 选择与查看器（G2-3） ----
  const selectedIds = $derived(new Set(snapshot.selectedAssetIds));

  function onAssetClick(event: MouseEvent, asset: GalleryAssetEntry): void {
    controller.clickAsset(asset.asset_id, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  }

  function onAssetActivate(asset: GalleryAssetEntry): void {
    controller.openViewer(asset.asset_id);
  }

  // ---- G3-3 文件操作 ----
  let renameDraft = $state("");

  const singleSelectedAsset = $derived(
    snapshot.selectedAssetIds.length === 1 ? snapshot.assets.find((item) => item.asset_id === snapshot.selectedAssetIds[0]) ?? null : null,
  );

  function requestDeleteSelection(): void {
    if (snapshot.selectedAssetIds.length === 0) return;
    controller.requestTrashSelection();
  }

  function requestRenameSelection(): void {
    if (singleSelectedAsset === null) return;
    const dot = singleSelectedAsset.name.lastIndexOf(".");
    renameDraft = dot > 0 ? singleSelectedAsset.name.slice(0, dot) : singleSelectedAsset.name;
    controller.openRenameDialog(singleSelectedAsset.asset_id);
  }

  function onGridKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select"))) return;
    if (event.key === "Delete") {
      event.preventDefault();
      requestDeleteSelection();
    } else if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      controller.selectAllAssets();
    } else if (event.key === "F2") {
      event.preventDefault();
      requestRenameSelection();
    }
  }


  function formatTrashTimestamp(epochMs: number): string {
    const parsed = new Date(epochMs);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("zh-Hans-CN");
  }

  let lastFocusedAssetId = "";

  function onCardKeydown(event: KeyboardEvent, asset: GalleryAssetEntry): void {
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onAssetActivate(asset);
    }
  }

  function closeViewer(): void {
    controller.closeViewer();
    // 返回网格：焦点回到活动图片（记忆 #30 契约——返回后恢复活动图片焦点）。
    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[data-gallery-asset="${CSS.escape(lastFocusedAssetId)}"]`);
      element?.focus();
    });
  }

  function submitSearch(event: SubmitEvent): void {
    event.preventDefault();
    void controller.submitQuery(searchDraft);
  }

  function clearSearch(): void {
    searchDraft = "";
    void controller.submitQuery("");
  }

  function txtBadge(asset: GalleryAssetEntry): string {
    return GALLERY_TXT_STATE_LABELS[asset.txt_state];
  }

  function txtBadgeKind(asset: GalleryAssetEntry): string {
    if (asset.txt_state === "normal") return "ok";
    if (asset.txt_state === "missing") return "muted";
    return "warn";
  }

  function directoryLabel(directory: GalleryDirectoryEntry): string {
    return directory.name.length > 0 ? directory.name : "根目录";
  }

  function formatCount(value: number): string {
    return value.toLocaleString("zh-Hans-CN");
  }

  function sourceSubtitle(source: GalleryBrowseState["sources"][number]): string {
    const parts = [GALLERY_SOURCE_KIND_LABELS[source.kind], GALLERY_AVAILABILITY_LABELS[source.availability]];
    if (source.dedup_required) parts.push(GALLERY_DEDUP_STATE_LABELS[source.dedup_state]);
    return parts.join(" · ");
  }

  onMount(() => {
    controller.activate();
    return () => controller.destroy();
  });

  /** 应用级快捷键：对话框/面板 Escape + 网格 Delete/Ctrl+A/F2（查看器打开时让位）。 */
  function onAppKeydown(event: KeyboardEvent): void {
    if (snapshot.viewerIndex >= 0) return;
    if (snapshot.renameDialogPhase !== "closed" || snapshot.trashConfirmPhase !== "closed" || snapshot.trashPanelPhase !== "closed") {
      if (event.key === "Escape") {
        event.preventDefault();
        if (snapshot.renameDialogPhase !== "closed") controller.cancelRename();
        else if (snapshot.trashConfirmPhase !== "closed") controller.cancelTrashConfirm();
        else controller.closeTrashPanel();
      }
      return;
    }
    onGridKeydown(event);
  }
</script>


<svelte:window onkeydown={onAppKeydown} />

<section class="gallery-app" data-gallery-app data-domain-owner="gallery" data-preview-availability="live" aria-labelledby="gallery-heading">
  <header class="gallery-header">
    <div><p>图片库</p><h1 id="gallery-heading">媒体浏览工作区</h1></div>
    <span class="gallery-status" data-kind={snapshot.sourcesPhase}>{snapshot.sourcesPhase === "ready" ? `${formatCount(snapshot.sources.length)} 个来源` : snapshot.sourcesPhase === "error" ? "来源加载失败" : "正在加载来源"}</span>
  </header>

  <div class="gallery-body">
    <aside class="gallery-tree" aria-labelledby="gallery-tree-heading">
      <h2 id="gallery-tree-heading">来源与目录</h2>
      {#if snapshot.sourcesPhase === "loading" || snapshot.sourcesPhase === "idle"}
        <p class="gallery-hint" role="status">正在加载来源…</p>
      {:else if snapshot.sourcesPhase === "error"}
        <p class="gallery-hint gallery-hint--error" role="alert">来源加载失败（{snapshot.sourcesErrorCode}）</p>
        <button type="button" class="gallery-link" onclick={() => void controller.refreshSources()}>重试加载来源</button>
      {:else if snapshot.sources.length === 0}
        <p class="gallery-hint">暂无图库来源。完成下载批次或导入本地目录后，这里会显示可浏览的来源。</p>
      {:else}
        <ul class="gallery-source-list">
          {#each snapshot.sources as source (source.source_id)}
            <li>
              <button
                type="button"
                class="gallery-source"
                aria-current={snapshot.activeSourceId === source.source_id ? "true" : undefined}
                onclick={() => void controller.openSource(source.source_id)}
              >
                <span class="gallery-source__name">{source.display_name}</span>
                <span class="gallery-source__meta">{sourceSubtitle(source)}</span>
                <span class="gallery-source__count">{formatCount(source.asset_count)} 张图片{source.root_directory_id === null ? " · 待扫描" : ""}</span>
              </button>
              {#if snapshot.activeSourceId === source.source_id && snapshot.path.length > 0}
                <ul class="gallery-pathlist" aria-label="当前目录路径">
                  {#each snapshot.path as segment (segment.directory_id)}
                    <li><button type="button" class="gallery-link" onclick={() => void controller.openDirectory(segment.directory_id)}>{segment.name}</button></li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <main class="gallery-content" aria-labelledby="gallery-content-heading">
      <h2 id="gallery-content-heading" class="gallery-visually-hidden">目录内容</h2>
      {#if snapshot.activeSourceId === null}
        <div class="gallery-empty" role="status">
          <strong>选择一个来源开始浏览</strong>
          <p>左侧选择下载批次或导入目录；这里会显示目录树和图片网格。</p>
        </div>
      {:else}
        <nav class="gallery-toolbar" aria-label="目录浏览工具">
          <ol class="gallery-breadcrumb" aria-label="目录路径">
            {#each breadcrumb as segment, index (index)}
              <li>
                {#if index < breadcrumb.length - 1}
                  <button type="button" class="gallery-link" onclick={() => void controller.navigateToBreadcrumb(index)}>{segment.label}</button>
                {:else}
                  <span aria-current="page">{segment.label}</span>
                {/if}
              </li>
            {/each}
          </ol>
          <form class="gallery-search" onsubmit={submitSearch} role="search">
            <label class="gallery-visually-hidden" for="gallery-search-input">搜索当前范围</label>
            <input
              id="gallery-search-input"
              type="search"
              placeholder="搜索文件名、相对路径或 TXT 原文"
              maxlength="256"
              autocomplete="off"
              bind:value={searchDraft}
            />
            <button type="submit">搜索</button>
            {#if snapshot.query.length > 0}
              <button type="button" onclick={clearSearch}>清除</button>
            {/if}
          </form>
          <div class="gallery-toolbar-controls" role="group" aria-label="范围与筛选">
            <label>
              <span>范围</span>
              <select value={snapshot.searchScope} onchange={(event) => void controller.setSearchScope((event.currentTarget as HTMLSelectElement).value as typeof snapshot.searchScope)}>
                <option value="directory">当前目录</option>
                <option value="source">整个来源</option>
              </select>
            </label>
            <label>
              <span>包含子目录</span>
              <input
                type="checkbox"
                checked={snapshot.includeDescendants}
                disabled={snapshot.searchScope === "source"}
                onchange={(event) => void controller.setIncludeDescendants((event.currentTarget as HTMLInputElement).checked)}
              />
            </label>
            <label>
              <span>TXT 状态</span>
              <select value={snapshot.txtStateFilter ?? ""} onchange={(event) => { const value = (event.currentTarget as HTMLSelectElement).value; void controller.setTxtStateFilter(value === "" ? null : (value as GalleryTxtState)); }}>
                {#each txtStateOptions as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            <div class="gallery-viewtoggle" role="group" aria-label="视图方式">
              <button type="button" aria-pressed={snapshot.viewMode === "grid"} onclick={() => controller.setViewMode("grid")}>网格</button>
              <button type="button" aria-pressed={snapshot.viewMode === "list"} onclick={() => controller.setViewMode("list")}>列表</button>
            </div>
            {#if snapshot.selectedAssetIds.length > 0}
              <span class="gallery-toolbar-selection">已选 {formatCount(snapshot.selectedAssetIds.length)} 张</span>
              <button type="button" onclick={requestRenameSelection} disabled={singleSelectedAsset === null}>重命名…</button>
              <button type="button" class="gallery-toolbar-danger" onclick={requestDeleteSelection}>删除…</button>
            {/if}
            <button
              type="button"
              aria-pressed={snapshot.trashPanelPhase !== "closed"}
              onclick={() => {
                if (snapshot.trashPanelPhase === "closed") void controller.openTrashPanel();
                else controller.closeTrashPanel();
              }}
            >回收区</button>
          </div>
        </nav>

        {#if snapshot.pagePhase === "loading" && snapshot.directories.length === 0 && snapshot.assets.length === 0}
          <p class="gallery-hint" role="status">正在加载目录内容…</p>
        {:else if snapshot.pagePhase === "error"}
          <p class="gallery-hint gallery-hint--error" role="alert">目录加载失败（{snapshot.pageErrorCode}）</p>
          <button type="button" class="gallery-link" onclick={() => void controller.navigateToBreadcrumb(-1)}>重试</button>
        {:else if snapshot.directories.length === 0 && snapshot.assets.length === 0}
          <div class="gallery-empty" role="status">
            <strong>此目录为空{snapshot.query ? "或没有匹配的搜索结果" : ""}</strong>
            {#if snapshot.query}<p>搜索词：{snapshot.query}</p>{/if}
          </div>
        {:else}
          {#if snapshot.directories.length > 0}
            <ul class="gallery-folders" aria-label="子目录">
              {#each snapshot.directories as directory (directory.directory_id)}
                <li>
                  <button type="button" class="gallery-folder" onclick={() => void controller.openDirectory(directory.directory_id)}>
                    <span class="gallery-folder__cover" data-count={Math.min(directory.recursive_asset_count, 4)} aria-hidden="true">
                      {#each directory.cover_asset_ids.slice(0, 4) as coverId (coverId)}
                        <img src={service.thumbnailUrl(coverId)} alt="" loading="lazy" decoding="async" />
                      {/each}
                    </span>
                    <span class="gallery-folder__name">{directoryLabel(directory)}</span>
                    <span class="gallery-folder__meta">{formatCount(directory.recursive_asset_count)} 张 · {formatCount(directory.direct_asset_count)} 张直属</span>
                  </button>
                </li>
              {/each}
              {#if snapshot.directoryCursor !== null}
                <li class="gallery-folders__more"><button type="button" class="gallery-link" onclick={() => void controller.loadMore()}>加载更多目录</button></li>
              {/if}
            </ul>
          {/if}
          {#if snapshot.assets.length > 0}
            {#if snapshot.viewMode === "grid"}
              <div
                class="gallery-grid-scroll"
                aria-label="图片网格"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-grid" style={`grid-template-columns: repeat(${gridColumns}, minmax(0, 1fr)); height: ${windowing.totalHeight}px;`}>
                  <div class="gallery-grid-window" style={`transform: translateY(${windowing.startOffsetY}px);`}>
                    {#each visibleAssets as asset (asset.asset_id)}
                      <button
                        type="button"
                        class="gallery-card"
                        class:selected={selectedIds.has(asset.asset_id)}
                        data-gallery-asset={asset.asset_id}
                        title={asset.relative_path}
                        aria-pressed={selectedIds.has(asset.asset_id)}
                        onclick={(event) => onAssetClick(event, asset)}
                        ondblclick={() => onAssetActivate(asset)}
                        onkeydown={(event) => onCardKeydown(event, asset)}
                        onfocus={() => (lastFocusedAssetId = asset.asset_id)}
                      >
                        <span class="gallery-card__media">
                          <img src={service.thumbnailUrl(asset.asset_id)} alt={asset.name} loading="lazy" decoding="async" />
                        </span>
                        <span class="gallery-card__name">{asset.name}</span>
                        <span class="gallery-card__badges">
                          <span class="gallery-badge" data-kind={txtBadgeKind(asset)}>{txtBadge(asset)}</span>
                          {#if asset.dedup_visibility === "excluded"}<span class="gallery-badge" data-kind="muted">已排除</span>{/if}
                        </span>
                      </button>
                    {/each}
                  </div>
                </div>
              </div>
            {:else}
              <div
                class="gallery-list-scroll"
                aria-label="图片列表"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-list" role="table" aria-label="当前目录图片明细">
                  <div class="gallery-list-head" role="row">
                    <span role="columnheader">文件名</span>
                    <span role="columnheader">相对路径</span>
                    <span role="columnheader">TXT 状态</span>
                    <span role="columnheader">大小</span>
                    <span role="columnheader">尺寸</span>
                  </div>
                  <div class="gallery-list-body" style={`height: ${windowing.totalHeight}px;`}>
                    <div class="gallery-list-window" style={`transform: translateY(${windowing.startOffsetY}px);`}>
                      {#each visibleAssets as asset (asset.asset_id)}
                        <div
                          class="gallery-list-row"
                          class:selected={selectedIds.has(asset.asset_id)}
                          role="row"
                          data-gallery-asset={asset.asset_id}
                          tabindex="0"
                          aria-selected={selectedIds.has(asset.asset_id)}
                          onclick={(event) => onAssetClick(event, asset)}
                          ondblclick={() => onAssetActivate(asset)}
                          onkeydown={(event) => onCardKeydown(event, asset)}
                          onfocus={() => (lastFocusedAssetId = asset.asset_id)}
                        >
                          <span class="gallery-list-row__thumb" role="cell"><img src={service.thumbnailUrl(asset.asset_id)} alt="" loading="lazy" decoding="async" /></span>
                          <span class="gallery-list-row__name" role="cell">{asset.name}</span>
                          <span class="gallery-list-row__path" role="cell">{asset.relative_path}</span>
                          <span role="cell"><span class="gallery-badge" data-kind={txtBadgeKind(asset)}>{txtBadge(asset)}</span></span>
                          <span class="gallery-list-row__size" role="cell">{formatCount(asset.size_bytes)} B</span>
                          <span class="gallery-list-row__dims" role="cell">{asset.width}×{asset.height}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          {/if}
        {/if}
      {/if}
    </main>
  </div>
</section>

{#if snapshot.viewerIndex >= 0 && snapshot.viewerAssets.length > 0}
  <Viewer {store} {service} controller={controller} onClose={closeViewer} />
{/if}

{#if snapshot.trashConfirmPhase !== "closed"}
  {@const imageCount = snapshot.trashConfirmAssetIds.length}
  {@const txtCount = snapshot.assets.filter((item) => snapshot.trashConfirmAssetIds.includes(item.asset_id) && item.txt_relative_path !== null).length}
  {@const abnormalCount = snapshot.assets.filter((item) => snapshot.trashConfirmAssetIds.includes(item.asset_id) && item.txt_state !== "normal" && item.txt_state !== "missing").length}
  <div class="gallery-dialog-backdrop">
    <div
      class="gallery-dialog"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="gallery-trash-confirm-title"
    >
      <h2 id="gallery-trash-confirm-title">移入回收区</h2>
      <p>
        将删除 <strong>{formatCount(imageCount)}</strong> 张图片、
        <strong>{formatCount(txtCount)}</strong> 个同名 TXT、
        <strong>{formatCount(abnormalCount)}</strong> 项 TXT 异常。
        整组操作可撤销；任何单项失败都会回滚整组。
      </p>
      {#if snapshot.trashConfirmError !== null}
        <p class="gallery-dialog__error">{snapshot.trashConfirmError}</p>
      {/if}
      <div class="gallery-dialog__actions">
        <button type="button" onclick={controller.cancelTrashConfirm}>取消</button>
        <button
          type="button"
          class="gallery-dialog__danger"
          disabled={snapshot.trashConfirmPhase === "busy"}
          onclick={() => void controller.confirmTrashSelection()}
        >移入回收区</button>
      </div>
    </div>
  </div>
{/if}

{#if snapshot.renameDialogPhase !== "closed"}
  {@const renameAsset = snapshot.assets.find((item) => item.asset_id === snapshot.renameAssetId) ?? null}
  {@const renameBusy = snapshot.renameDialogPhase === "busy"}
  <div class="gallery-dialog-backdrop">
    <form
      class="gallery-dialog"
      aria-labelledby="gallery-rename-title"
      onsubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector<HTMLInputElement>("input[type=text]");
        void controller.submitRename(input?.value ?? "");
      }}
    >
      <h2 id="gallery-rename-title">成对重命名</h2>
      {#if renameAsset !== null}
        <p>{renameAsset.relative_path} → 同目录内新文件名（图片与同名 TXT 成对重命名）。</p>
      {/if}
      <input
        class="gallery-dialog__input"
        type="text"
        value={renameDraft}
        maxlength="255"
        autocomplete="off"
        aria-label="新文件名（不含扩展名）"
        oninput={(event) => (renameDraft = (event.currentTarget as HTMLInputElement).value)}
      />
      {#if snapshot.renameDialogError !== null}
        <p class="gallery-dialog__error">{snapshot.renameDialogError}</p>
      {/if}
      <div class="gallery-dialog__actions">
        <button type="button" onclick={controller.cancelRename}>取消</button>
        <button type="submit" class="gallery-dialog__primary" disabled={renameBusy}>重命名</button>
      </div>
    </form>
  </div>
{/if}

{#if snapshot.undoToastVisible}
  <div class="gallery-undo-toast" role="status">
    <p>已移入回收区 {formatCount(snapshot.trashConfirmAssetIds.length)} 项。</p>
    <button
      type="button"
      disabled={snapshot.undoBusy}
      onclick={() => void controller.undoLastTrash()}
    >撤销</button>
  </div>
{/if}

{#if snapshot.trashPanelPhase !== "closed"}
  <aside class="gallery-trash-panel" aria-label="图库回收区">
    <div class="gallery-trash-panel__head">
      <h2>回收区</h2>
      <button type="button" onclick={() => controller.closeTrashPanel()}>关闭</button>
    </div>
    <div class="gallery-trash-panel__list">
      {#if snapshot.trashPanelPhase === "loading"}
        <p class="gallery-trash-panel__hint" role="status">正在加载回收区…</p>
      {:else if snapshot.trashPanelPhase === "error"}
        <p class="gallery-trash-panel__hint" role="alert">回收区加载失败（{snapshot.trashPanelError ?? "unknown"}）。</p>
      {:else if snapshot.trashOperations.length === 0}
        <p class="gallery-trash-panel__empty">回收区为空。文件将保留至手动恢复或彻底删除。</p>
      {:else}
        {#each snapshot.trashOperations as operation (operation.operation_id)}
          <div class="gallery-trash-item">
            <div class="gallery-trash-item__meta">
              <span class="gallery-trash-item__title">{formatTrashTimestamp(operation.created_at)} · {formatCount(operation.item_count)} 项</span>
              <span class="gallery-trash-item__detail">
                {formatCount(operation.disk_usage_bytes)} B
                {#if operation.has_txt_count > 0} · 含 TXT {formatCount(operation.has_txt_count)}{/if}
                {#if operation.item_error_count > 0} · 异常 {formatCount(operation.item_error_count)}{/if}
              </span>
            </div>
            <div class="gallery-trash-item__actions">
              <button
                type="button"
                disabled={snapshot.trashPanelBusyOperationId === operation.operation_id}
                onclick={() => void controller.restoreTrashOperation(operation.operation_id)}
              >全部恢复</button>
              <button
                type="button"
                disabled={snapshot.trashPanelBusyOperationId === operation.operation_id}
                onclick={() => void controller.purgeTrashOperation(operation.operation_id)}
              >彻底删除</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    <div class="gallery-trash-panel__foot">
      <span class="gallery-trash-panel__summary">
        {#if snapshot.trashNextCursor !== null}
          <button type="button" onclick={() => void controller.loadMoreTrash()}>加载更多</button>
        {:else}
          回收区不自动清理；文件保留至手动恢复或彻底删除。
        {/if}
      </span>
      <button type="button" onclick={() => void controller.refreshDirectory()}>重新扫描</button>
    </div>
  </aside>
{/if}

<script module lang="ts">
  // ResizeObserver 指令：观察内容滚动视口高度以驱动虚拟化窗口。
  import type { Action } from "svelte/action";

  export const resizeObserver: Action<HTMLElement, { onContentResize: (entries: ResizeObserverEntry[]) => void }> =
    (element, parameters) => {
      let observer: ResizeObserver | null = null;
      const observe = (callback: (entries: ResizeObserverEntry[]) => void) => {
        observer?.disconnect();
        observer = new ResizeObserver(callback);
        observer.observe(element);
      };
      if (parameters) observe(parameters.onContentResize);
      return {
        update(next: { onContentResize: (entries: ResizeObserverEntry[]) => void }) {
          observe(next.onContentResize);
        },
        destroy() {
          observer?.disconnect();
        },
      };
    };
</script>
