<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import XIcon from "@lucide/svelte/icons/x";
  import MaximizeIcon from "@lucide/svelte/icons/maximize";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import { clampReviewPan } from "../review/engine";
  import { parseGalleryTxtTagView, type GalleryAssetEntry } from "./model";
  import type {
    GalleryBrowseState,
    GalleryTxtViewMode,
  } from "./state";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import { enqueueThumbnailPrefetch } from "./thumbnailPrefetch";

  interface Props {
    readOnly?: boolean;
    snapshot: GalleryBrowseState;
    currentAsset: GalleryAssetEntry | null;
    contentUrl: (asset: { asset_id: string; source_id: string | null; relative_path: string }) => string;
    thumbnailUrl: (assetId: string, size: 256 | 512) => string;
    onMove: (delta: number) => void;
    onJump: (index: number) => void;
    onClose: () => void;
    onSetTxtViewMode: (mode: GalleryTxtViewMode) => void;
    onSetTxtDraft: (draft: string) => void;
    onSave: (advance: boolean) => void;
    onDiscard: () => void;
    onTrash: () => void;
    onResolvePending: (decision: "save" | "discard" | "cancel") => void;
  }

  let {
    readOnly = false,
    snapshot,
    currentAsset,
    contentUrl,
    thumbnailUrl,
    onMove,
    onJump,
    onClose,
    onSetTxtViewMode,
    onSetTxtDraft,
    onSave,
    onDiscard,
    onTrash,
    onResolvePending,
  }: Props = $props();

  let viewerRoot: HTMLElement | null = $state(null);
  let closeButton: HTMLButtonElement | null = $state(null);
  let focusExitButton: HTMLButtonElement | null = $state(null);
  let pendingCancelButton: HTMLButtonElement | null = $state(null);
  let returnFocus: FocusTarget | null = null;
  let scale = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;
  let chromeHidden = $state(false);
  let imageFailed = $state(false);
  let imageLoaded = $state(false);
  let failedThumbnailIds = $state(new Set<string>());
  let panelWidth = $state(380);
  let stopPanelResize: (() => void) | null = null;

  const currentAnnotation = $derived(snapshot.viewerAnnotation);
  const draftContent = $derived(
    snapshot.txtDraft ?? currentAnnotation?.content ?? "",
  );
  const annotationEditable = $derived(
    currentAnnotation !== null && ["normal", "blank", "missing"].includes(currentAnnotation.txt_state),
  );
  const rawDisplayContent = $derived.by(() => {
    if (currentAnnotation?.content !== null && currentAnnotation?.content !== undefined) {
      return currentAnnotation.content.length > 0 ? currentAnnotation.content : "（TXT 为空）";
    }
    if (currentAnnotation?.txt_state === "invalid_encoding") return "TXT 不是有效的 UTF-8，未解码或改写原文件。";
    if (currentAnnotation?.txt_state === "pair_conflict") return "检测到同名 TXT 配对冲突，未选择其中任何文件。";
    if (currentAnnotation?.txt_state === "io_error") return "读取 TXT 时发生文件系统错误。";
    return "（缺少 TXT；首次成功保存时创建）";
  });
  const tagView = $derived(parseGalleryTxtTagView(currentAnnotation?.content ?? null));
  const hasPrevious = $derived(snapshot.viewerIndex > 0);
  const hasNext = $derived(
    snapshot.viewerIndex >= 0 &&
      (snapshot.viewerIndex < snapshot.viewerAssets.length - 1 || snapshot.viewerAssetCursor !== null),
  );
  const interactionBusy = $derived(
    snapshot.viewerPagePhase === "loading" || snapshot.viewerOperationPhase === "trashing",
  );

  $effect(() => {
    // 预热相邻资产的缩略图条，左右翻页时直接命中缓存。
    const index = snapshot.viewerIndex;
    if (index < 0) return;
    const urls: string[] = [];
    for (const offset of [-2, -1, 1, 2]) {
      const neighbor = snapshot.viewerAssets[index + offset];
      if (neighbor) urls.push(thumbnailUrl(neighbor.asset_id, 256));
    }
    enqueueThumbnailPrefetch(urls);
  });

  $effect(() => {
    currentAsset?.asset_id;
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    imageFailed = false;
    imageLoaded = false;
    void tick().then(() => {
      viewerRoot
        ?.querySelector<HTMLElement>('[data-gallery-viewer-thumbnail][aria-current="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "center" });
    });
  });

  $effect(() => {
    if (snapshot.viewerPendingAction !== null) {
      void tick().then(() => restoreFocus(pendingCancelButton));
    }
  });

  onMount(() => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => restoreFocus(closeButton ?? viewerRoot));
    return () => {
      stopPanelResize?.();
      restoreFocus(returnFocus);
      returnFocus = null;
    };
  });


  function toggleChrome(): void {
    const nextHidden = !chromeHidden;
    chromeHidden = nextHidden;
    void tick().then(() => restoreFocus(nextHidden ? focusExitButton ?? viewerRoot : closeButton ?? viewerRoot));
  }
  function isEditableTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function focusableItems(): HTMLElement[] {
    if (!viewerRoot) return [];
    const scope = snapshot.viewerPendingAction === null
      ? viewerRoot
      : viewerRoot.querySelector<HTMLElement>(".gallery-viewer__guard") ?? viewerRoot;
    return [...scope.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
    )].filter((item) => item.offsetParent !== null && item.getAttribute("aria-hidden") !== "true");
  }

  function trapTab(event: KeyboardEvent): boolean {
    if (event.key !== "Tab") return false;
    const items = focusableItems();
    const activeIndex = document.activeElement instanceof HTMLElement
      ? items.indexOf(document.activeElement)
      : -1;
    const next = trappedTabIndex(activeIndex < 0 ? 0 : activeIndex, items.length, event.shiftKey);
    if (next === null && activeIndex >= 0) return false;
    event.preventDefault();
    restoreFocus(items[next ?? 0] ?? viewerRoot);
    return true;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (trapTab(event)) return;
    if (snapshot.viewerPendingAction !== null) {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolvePending("cancel");
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!interactionBusy) onMove(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (!interactionBusy) onMove(1);
    } else if (event.key === "Delete") {
      event.preventDefault();
      if (!readOnly && !interactionBusy) onTrash();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleChrome();
    }
  }

  /** 与去重审核一致的视窗查看器手感：缩放下限为适配，平移被图片边缘约束。 */
  function clampZoomToImage(state: { scale: number; offsetX: number; offsetY: number }): { scale: number; offsetX: number; offsetY: number } {
    const img = viewerRoot?.querySelector<HTMLImageElement>(".gallery-viewer__stage img");
    const stage = img?.parentElement;
    if (!img || !stage || !img.naturalWidth || !img.naturalHeight) return state;
    return clampReviewPan(state, img.naturalWidth, img.naturalHeight, { width: stage.clientWidth, height: stage.clientHeight });
  }
  function resetZoom(): void {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
  }
  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextScale = Math.min(8, Math.max(1, scale * factor));
    const ratio = nextScale / scale;
    const next = clampZoomToImage({
      scale: nextScale,
      offsetX: pointerX - (pointerX - offsetX) * ratio,
      offsetY: pointerY - (pointerY - offsetY) * ratio,
    });
    scale = next.scale;
    offsetX = next.offsetX;
    offsetY = next.offsetY;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    // 主键已松开（原生拖拽/系统手势吞掉 pointerup 的场景）：立即结束平移。
    if ((event.buttons & 1) === 0) {
      dragging = false;
      return;
    }
    const next = clampZoomToImage({
      scale,
      offsetX: startOffsetX + event.clientX - dragStartX,
      offsetY: startOffsetY + event.clientY - dragStartY,
    });
    offsetX = next.offsetX;
    offsetY = next.offsetY;
  }

  function stopDragging(): void {
    dragging = false;
  }
  function markThumbnailFailed(assetId: string): void {
    failedThumbnailIds = new Set(failedThumbnailIds).add(assetId);
  }


  function startPanelResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const move = (moveEvent: PointerEvent) => {
      const maximum = Math.max(320, Math.min(680, window.innerWidth - 480));
      panelWidth = Math.round(Math.min(maximum, Math.max(300, startWidth + startX - moveEvent.clientX)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      stopPanelResize = null;
    };
    stopPanelResize?.();
    stopPanelResize = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function onTextareaKeydown(event: KeyboardEvent): void {
    if (readOnly) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onSave(true);
    }
  }

  function pendingActionLabel(): string {
    const action = snapshot.viewerPendingAction;
    if (action?.kind === "close") return "关闭查看器";
    if (action?.kind === "trash") return "移入回收区";
    if (action?.kind === "previous") return "查看上一张";
    if (action?.kind === "next") return "查看下一张";
    return "切换图片";
  }
</script>

<div
  class="gallery-viewer"
  data-gallery-viewer-asset={currentAsset?.asset_id}
  class:gallery-viewer--readonly={readOnly}
  class:gallery-viewer--focus={chromeHidden}
  role="dialog"
  aria-modal="true"
  aria-label={currentAsset ? `查看 ${currentAsset.name}` : "图片查看器"}
  tabindex="-1"
  bind:this={viewerRoot}
  onkeydown={onKeydown}
  style={`--gallery-viewer-panel-width: ${panelWidth}px`}
>
  {#if !chromeHidden}
    <header
      class="gallery-viewer__toolbar"
      inert={snapshot.viewerPendingAction !== null ? true : undefined}
      aria-hidden={snapshot.viewerPendingAction !== null ? "true" : undefined}
    >
      <div class="gallery-viewer__identity">
        <strong>{currentAsset?.name ?? "图片"}</strong>
        <span>{snapshot.viewerIndex + 1} / {snapshot.viewerAssets.length}{snapshot.viewerAssetCursor ? "+" : ""}</span>
      </div>
      <div class="gallery-viewer__actions">
        {#if !readOnly}
        <Button
          variant="ghost"
          class="gallery-viewer__button gallery-viewer__button--danger"
          disabled={!currentAsset || interactionBusy}
          onclick={onTrash}
        >{snapshot.viewerOperationPhase === "trashing" ? "正在移入…" : "移入回收区"}</Button>
        {/if}
        <Button variant="outline" class="gallery-viewer__button" onclick={toggleChrome}><MaximizeIcon aria-hidden="true" />专注模式 <kbd>F</kbd></Button>
        <Button variant="secondary" class="gallery-viewer__button" bind:ref={closeButton} onclick={onClose}><XIcon aria-hidden="true" />关闭 <kbd>Esc</kbd></Button>
      </div>
    </header>
  {/if}

  {#if snapshot.viewerOperationPhase === "error"}
    <p class="gallery-viewer__banner gallery-viewer__banner--error" role="alert">
      移入回收区失败：{snapshot.viewerOperationErrorCode ?? "gallery_request_failed"}。原文件未从当前视图移除。
    </p>
  {/if}
  {#if snapshot.viewerPagePhase === "error"}
    <p class="gallery-viewer__banner gallery-viewer__banner--error" role="alert">
      无法继续加载结果：{snapshot.viewerPageErrorCode ?? "gallery_request_failed"}。可以再次使用下一张重试。
    </p>
  {/if}

  <div
    class="gallery-viewer__body"
    inert={snapshot.viewerPendingAction !== null ? true : undefined}
    aria-hidden={snapshot.viewerPendingAction !== null ? "true" : undefined}
  >
    <div
      class="gallery-viewer__stage"
      class:gallery-viewer__stage--dragging={dragging}
      role="group"
      aria-label="图片画布；滚轮缩放，拖动平移，双击复位"
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={stopDragging}
      onpointercancel={stopDragging}
      ondblclick={resetZoom}
    >
      {#if currentAsset && currentAsset.read_state === "ok" && !imageFailed}
        <img
          src={contentUrl(currentAsset)}
          alt=""
          crossorigin="anonymous"
          draggable="false"
          onload={() => (imageLoaded = true)}
          style:background-image={imageLoaded ? undefined : `url("${thumbnailUrl(currentAsset.asset_id, 512)}")`}
          onerror={() => (imageFailed = true)}
          style={`transform: translate(${offsetX}px, ${offsetY}px) scale(${scale})`}
        />
      {:else if currentAsset}
        <div class="gallery-viewer__stage-error" role="alert">
          <strong>无法显示 {currentAsset.name}</strong>
          <span>{currentAsset.error_code || "image_decode_failed"}</span>
        </div>
      {/if}
      <div class="gallery-viewer__zoom" aria-live="polite">{Math.round(scale * 100)}%</div>
      {#if chromeHidden}
        <button type="button" class="gallery-viewer__focus-exit" bind:this={focusExitButton} onclick={toggleChrome}>显示工具 <kbd>F</kbd></button>
      {/if}
    </div>

    {#if !chromeHidden && !readOnly}
      <button
        type="button"
        class="gallery-viewer__panel-resizer"
        aria-label={`调整 TXT 面板宽度；当前 ${panelWidth} 像素`}
        role="slider"
        aria-orientation="horizontal"
        aria-valuemin="300"
        aria-valuemax="680"
        aria-valuenow={panelWidth}
        onpointerdown={startPanelResize}
        onkeydown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            panelWidth = Math.min(680, Math.max(300, panelWidth + (event.key === "ArrowLeft" ? 20 : -20)));
          }
        }}
      ></button>
      <aside class="gallery-viewer__txt" aria-label="TXT 标注面板">
        <div class="gallery-viewer__txt-head">
          <div>
            <strong>同名 TXT</strong>
            <span>{currentAnnotation?.txt_state ?? currentAsset?.txt_state ?? "missing"}</span>
          </div>
          <div class="gallery-viewer__mode" role="group" aria-label="TXT 展示方式">
            <button type="button" class:active={snapshot.txtViewMode === "raw"} aria-pressed={snapshot.txtViewMode === "raw"} onclick={() => onSetTxtViewMode("raw")}>原文</button>
            <button type="button" class:active={snapshot.txtViewMode === "tags"} aria-pressed={snapshot.txtViewMode === "tags"} onclick={() => onSetTxtViewMode("tags")}>逗号标签</button>
          </div>
        </div>

        {#if snapshot.viewerPhase === "loading"}
          <p class="gallery-viewer__status" role="status">正在读取 TXT…</p>
        {:else if snapshot.viewerPhase === "error"}
          <p class="gallery-viewer__status gallery-viewer__status--error" role="alert">TXT 读取失败：{snapshot.viewerErrorCode}</p>
        {:else if currentAnnotation}
          {#if snapshot.txtDraft !== null}
            <textarea
              class="gallery-viewer__txt-editor"
              aria-label="TXT 原文编辑器"
              value={draftContent}
              oninput={(event) => onSetTxtDraft(event.currentTarget.value)}
              onkeydown={onTextareaKeydown}
              spellcheck="false"
            ></textarea>
            <div class="gallery-viewer__save-row">
              <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={() => onSave(false)}>保存 <kbd>Ctrl/⌘ S</kbd></button>
              <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={() => onSave(true)}>保存并下一张 <kbd>Ctrl/⌘ ↵</kbd></button>
              <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={onDiscard}>放弃编辑</button>
            </div>
          {:else if snapshot.txtViewMode === "raw"}
            <pre class="gallery-viewer__raw">{rawDisplayContent}</pre>
            {#if annotationEditable}
              <button type="button" class="gallery-viewer__edit" onclick={() => onSetTxtDraft(currentAnnotation.content ?? "")}>编辑原文</button>
            {/if}
          {:else}
            <div class="gallery-viewer__tag-view" aria-label="逗号标签辅助视图">
              {#if tagView.tags.length === 0}
                <p>没有可显示的标签。</p>
              {:else}
                <div class="gallery-viewer__tags">
                  {#each tagView.tags as tag, index (`${index}:${tag.raw}`)}
                    <span
                      class:gallery-viewer__tag--warning={tag.empty || tag.duplicate || tag.excess_whitespace}
                      title={tag.empty ? "空标签" : tag.duplicate ? "重复标签" : tag.excess_whitespace ? "含多余空白" : tag.value}
                    >{tag.empty ? "（空标签）" : tag.value}</span>
                  {/each}
                </div>
                {#if tagView.empty_count || tagView.duplicate_count || tagView.whitespace_count}
                  <p class="gallery-viewer__tag-warning" role="status">
                    仅提示，不会改写原文：空标签 {tagView.empty_count}，重复 {tagView.duplicate_count}，含多余空白 {tagView.whitespace_count}。
                  </p>
                {/if}
              {/if}
            </div>
            {#if annotationEditable}
              <button type="button" class="gallery-viewer__edit" onclick={() => onSetTxtDraft(currentAnnotation.content ?? "")}>编辑原文</button>
            {/if}
          {/if}

          {#if snapshot.txtSavePhase === "saved"}
            <p class="gallery-viewer__save-status" role="status">已保存。</p>
          {:else if snapshot.txtSavePhase === "conflict" || snapshot.txtSavePhase === "error"}
            <p class="gallery-viewer__save-status gallery-viewer__status--error" role="alert">
              保存失败：{snapshot.txtSaveErrorCode ?? "gallery_request_failed"}。草稿仍保留。
            </p>
          {/if}
        {/if}
      </aside>
    {/if}
  </div>

  {#if !chromeHidden}
    <nav
      class="gallery-viewer__strip"
      aria-label="当前结果图片导航"
      inert={snapshot.viewerPendingAction !== null ? true : undefined}
      aria-hidden={snapshot.viewerPendingAction !== null ? "true" : undefined}
    >
      <Button variant="ghost" size="icon" disabled={!hasPrevious || interactionBusy} onclick={() => onMove(-1)} aria-label="上一张"><ArrowLeftIcon aria-hidden="true" /></Button>
      <div class="gallery-viewer__thumbs">
        {#each snapshot.viewerAssets as asset, index (asset.asset_id)}
          <button
            type="button"
            data-gallery-viewer-thumbnail
            class:active={index === snapshot.viewerIndex}
            aria-current={index === snapshot.viewerIndex ? "true" : undefined}
            aria-label={`查看 ${asset.name}`}
            disabled={interactionBusy}
            onclick={() => onJump(index)}
          >
            {#if failedThumbnailIds.has(asset.asset_id)}
              <span class="gallery-thumbnail-fallback" aria-hidden="true">!</span>
            {:else}
              <img src={thumbnailUrl(asset.asset_id, 256)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" onerror={() => markThumbnailFailed(asset.asset_id)} />
            {/if}
          </button>
        {/each}
        {#if snapshot.viewerPagePhase === "loading"}
          <span class="gallery-viewer__strip-status" role="status">正在加载更多…</span>
        {/if}
      </div>
      <Button variant="ghost" size="icon" disabled={!hasNext || interactionBusy} onclick={() => onMove(1)} aria-label="下一张"><ArrowRightIcon aria-hidden="true" /></Button>
    </nav>
  {/if}

  {#if snapshot.viewerPendingAction !== null}
    <div class="gallery-viewer__guard-backdrop">
      <div class="gallery-viewer__guard" role="alertdialog" aria-modal="true" aria-labelledby="gallery-viewer-guard-title">
        <strong id="gallery-viewer-guard-title">TXT 有未保存更改</strong>
        <p>要先保存再{pendingActionLabel()}吗？保存失败时草稿会继续保留。</p>
        <div>
          <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={() => onResolvePending("save")}>保存后继续</button>
          <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={() => onResolvePending("discard")}>放弃更改</button>
          <button type="button" bind:this={pendingCancelButton} disabled={snapshot.txtSavePhase === "saving"} onclick={() => onResolvePending("cancel")}>取消</button>
        </div>
      </div>
    </div>
  {/if}
</div>
