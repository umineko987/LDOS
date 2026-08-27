<script lang="ts">
  import {
    GALLERY_TXT_STATE_LABELS,
    galleryFitViewport,
    galleryOneToOneViewport,
    galleryZoomAtPointer,
    parseGalleryTxtTags,
    type GalleryCanvasSize,
    type GalleryViewportState,
  } from "./model";
  import type { GalleryService } from "./service";
  import type { GalleryStore } from "./state";

  interface ViewerProps {
    readonly store: GalleryStore;
    readonly service: GalleryService;
    readonly controller: {
      readonly setTxtDraft: (draft: string) => boolean;
      readonly saveTxtAnnotation: (options: { advance: boolean }) => Promise<boolean>;
      readonly discardTxtDraft: () => boolean;
      readonly viewerNext: () => Promise<boolean>;
      readonly viewerPrevious: () => Promise<boolean>;
      readonly closeViewer: () => boolean;
    };
    readonly onClose?: () => void;
  }

  let { store, service, controller, onClose: onCloseProp }: ViewerProps = $props();
  const viewerNext = () => controller.viewerNext();
  const viewerPrevious = () => controller.viewerPrevious();
  const onClose = () => {
    if (isDirty) {
      unsavedGuardVisible = true;
      return;
    }
    if (onCloseProp) onCloseProp();
    else controller.closeViewer();
  };

  const snapshot = $derived($store);

  const asset = $derived(snapshot.viewerAssets[snapshot.viewerIndex] ?? null);
  const assetCount = $derived(snapshot.viewerAssets.length);
  const annotation = $derived(snapshot.viewerAnnotation);
  const tags = $derived(parseGalleryTxtTags(annotation?.content ?? null));

  // ---- 画布几何（缩放/平移；切图重置为适应画布，记忆 #57） ----
  let canvasElement = $state<HTMLElement | null>(null);
  let canvasSize = $state<GalleryCanvasSize>({ width: 0, height: 0 });
  let imageSize = $state<GalleryCanvasSize>({ width: 1, height: 1 });
  let viewport = $state<GalleryViewportState>({ scale: 1, offsetX: 0, offsetY: 0 });

  function fitViewport(): GalleryViewportState {
    if (canvasSize.width <= 0 || imageSize.width <= 0) {
      return { scale: 1, offsetX: 0, offsetY: 0 };
    }
    return galleryFitViewport({ canvas: canvasSize, image: imageSize });
  }

  function observeCanvas(element: HTMLElement) {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      canvasSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      viewport = fitViewport();
    });
    observer.observe(element);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  let geometryAssetId = "";
  $effect(() => {
    // 切换图片：重置为适应画布并居中；尺寸未知时先用资产记录值。
    if (asset === null) return;
    if (asset.asset_id === geometryAssetId) return;
    geometryAssetId = asset.asset_id;
    imageSize = { width: asset.width || 1, height: asset.height || 1 };
    viewport = fitViewport();
  });

  // ---- 滚轮缩放（指针位于画布时以指针为锚点）；TXT/片带区域自行滚动 ----
  function onCanvasWheel(event: WheelEvent) {
    if (asset === null || canvasSize.width <= 0) return;
    const rect = canvasElement?.getBoundingClientRect();
    if (!rect) return;
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
    event.preventDefault();
    viewport = galleryZoomAtPointer({
      canvas: canvasSize,
      image: imageSize,
      viewport,
      pointerX,
      pointerY,
      factor,
    });
  }

  // ---- 拖拽平移 ----
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartOffsetX = 0;
  let dragStartOffsetY = 0;

  function onPointerDown(event: PointerEvent) {
    if (dragPointerId !== null) return;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartOffsetX = viewport.offsetX;
    dragStartOffsetY = viewport.offsetY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragPointerId !== event.pointerId) return;
    if (canvasSize.width <= 0 || imageSize.width <= 0) return;
    const scaledWidth = imageSize.width * viewport.scale;
    const scaledHeight = imageSize.height * viewport.scale;
    let offsetX = dragStartOffsetX + (event.clientX - dragStartX);
    let offsetY = dragStartOffsetY + (event.clientY - dragStartY);
    if (scaledWidth <= canvasSize.width) offsetX = (canvasSize.width - scaledWidth) / 2;
    else offsetX = Math.min(0, Math.max(canvasSize.width - scaledWidth, offsetX));
    if (scaledHeight <= canvasSize.height) offsetY = (canvasSize.height - scaledHeight) / 2;
    else offsetY = Math.min(0, Math.max(canvasSize.height - scaledHeight, offsetY));
    viewport = { scale: viewport.scale, offsetX, offsetY };
  }

  function onPointerUp(event: PointerEvent) {
    if (dragPointerId !== event.pointerId) return;
    dragPointerId = null;
  }

  function resetToFit() {
    viewport = fitViewport();
  }

  function resetToOneToOne() {
    if (canvasSize.width <= 0 || imageSize.width <= 0) return;
    viewport = galleryOneToOneViewport({ canvas: canvasSize, image: imageSize });
  }

  // ---- 键盘：表单控件聚焦时不劫持（记忆 #30 契约） ----
  function isEditableTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    );
  }

  // ---- TXT 编辑（G3-3；记忆 #34 明确保存契约） ----
  let textareaElement = $state<HTMLTextAreaElement | null>(null);
  let unsavedGuardVisible = $state(false);

  const isEditing = $derived(snapshot.txtDraft !== null);
  const savedContent = $derived(annotation?.content ?? "");
  const displayContent = $derived(isEditing ? (snapshot.txtDraft ?? "") : savedContent);
  const isDirty = $derived(isEditing && snapshot.txtDraft !== savedContent);

  function enterEditMode() {
    if (annotation === null || snapshot.viewerPhase !== "ready") return;
    controller.setTxtDraft(savedContent);
  }

  function onDraftInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    controller.setTxtDraft(target.value);
  }

  async function saveTxt(advance: boolean) {
    unsavedGuardVisible = false;
    const ok = await controller.saveTxtAnnotation({ advance });
    if (ok) textareaElement?.focus();
    return ok;
  }

  function discardDraft() {
    unsavedGuardVisible = false;
    controller.discardTxtDraft();
  }

  /** 有未保存内容时阻止离开（导航/关闭），弹出三选一。 */
  function guardUnsaved(action: () => void): boolean {
    if (!isDirty) {
      action();
      return true;
    }
    unsavedGuardVisible = true;
    return false;
  }

  function onViewerKeydown(event: KeyboardEvent) {
    if (isEditableTarget(event.target)) {
      // Ctrl/Cmd+S / Ctrl/Cmd+Enter 在编辑态中仍然生效（保存契约）。
      if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        void saveTxt(false);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void saveTxt(true);
      } else if (event.key === "Escape" && isEditing) {
        event.preventDefault();
        if (isDirty) unsavedGuardVisible = true;
        else controller.discardTxtDraft();
      }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (snapshot.viewerIndex < assetCount - 1) {
        guardUnsaved(() => void viewerNext());
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (snapshot.viewerIndex > 0) {
        guardUnsaved(() => void viewerPrevious());
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      guardUnsaved(() => onClose());
    } else if (event.key === "0") {
      event.preventDefault();
      resetToFit();
    } else if (event.key === "1") {
      event.preventDefault();
      resetToOneToOne();
    } else if (event.key === "Enter" || event.key === " ") {
      // 网格卡片语义延续：Enter/Space 在查看器中进入 TXT 编辑。
      event.preventDefault();
      enterEditMode();
    }
  }

  function jumpTo(index: number) {
    if (index === snapshot.viewerIndex) return;
    if (index > snapshot.viewerIndex) void viewerNext();
    else void viewerPrevious();
  }

  // 底部片带：当前项滚动到可见区域。
  let stripElement = $state<HTMLElement | null>(null);
  $effect(() => {
    const index = snapshot.viewerIndex;
    if (!stripElement || index < 0) return;
    const active = stripElement.querySelector<HTMLElement>(`[data-strip-index="${index}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
  });
</script>

<svelte:window onkeydown={onViewerKeydown} />

{#if asset !== null}
  <div
    class="gallery-viewer"
    data-gallery-viewer
    role="dialog"
    aria-modal="true"
    aria-label={`沉浸式查看器：${asset.name}`}
  >
    <header class="gallery-viewer__bar">
      <button type="button" class="gallery-viewer__back" onclick={onClose}>返回</button>
      <span class="gallery-viewer__title" title={asset.relative_path}>{asset.name}</span>
      <span class="gallery-viewer__position">{snapshot.viewerIndex + 1} / {assetCount}</span>
      <span class="gallery-viewer__zoom">
        <button type="button" onclick={resetToFit} aria-label="适应画布（0）">适应</button>
        <button type="button" onclick={resetToOneToOne} aria-label="原始尺寸（1）">1:1</button>
        <span class="gallery-viewer__zoom-value">{Math.round(viewport.scale * 100)}%</span>
      </span>
    </header>

    <div class="gallery-viewer__main">
      <div
        class="gallery-viewer__canvas"
        bind:this={canvasElement}
        role="application"
        aria-label={`图片 ${asset.name}；方向键切换，0 适应画布，1 原始尺寸，滚轮缩放，拖拽平移`}
        onwheel={onCanvasWheel}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        use:observeCanvas
      >
        <img
          src={service.contentUrl(asset.asset_id)}
          alt={asset.name}
          draggable="false"
          style={`width: ${imageSize.width * viewport.scale}px; height: ${imageSize.height * viewport.scale}px; transform: translate(${viewport.offsetX}px, ${viewport.offsetY}px);`}
          onload={(event) => {
            const image = event.currentTarget as HTMLImageElement;
            if (image.naturalWidth > 0 && image.naturalHeight > 0 && asset !== null) {
              imageSize = { width: image.naturalWidth, height: image.naturalHeight };
              viewport = fitViewport();
            }
          }}
        />
      </div>

      <aside class="gallery-viewer__txt" aria-label="同名 TXT 标注">
        <div class="gallery-viewer__txt-head">
          <span class="gallery-viewer__txt-title">TXT 标注</span>
          <span class="gallery-viewer__txt-state" data-state={annotation?.txt_state ?? asset.txt_state}>
            {GALLERY_TXT_STATE_LABELS[annotation?.txt_state ?? asset.txt_state]}
          </span>
          <span class="gallery-viewer__txt-toggle">
            <button
              type="button"
              aria-pressed={snapshot.txtViewMode === "raw"}
              onclick={() => store.setTxtViewMode("raw")}
            >原文</button>
            <button
              type="button"
              aria-pressed={snapshot.txtViewMode === "tags"}
              onclick={() => store.setTxtViewMode("tags")}
            >标签</button>
          </span>
        {#if isEditing}
          <div class="gallery-viewer__txt-actions">
            <button
              type="button"
              class="gallery-viewer__txt-save"
              disabled={snapshot.txtSavePhase === "saving" || !isDirty}
              onclick={() => void saveTxt(false)}
            >保存（Ctrl+S）</button>
            <button
              type="button"
              class="gallery-viewer__txt-save-next"
              disabled={snapshot.txtSavePhase === "saving"}
              onclick={() => void saveTxt(true)}
            >保存并下一张（Ctrl+Enter）</button>
            <button
              type="button"
              disabled={snapshot.txtSavePhase === "saving"}
              onclick={discardDraft}
            >放弃修改</button>
          </div>
        {:else}
          <div class="gallery-viewer__txt-actions">
            <button
              type="button"
              disabled={annotation === null || snapshot.viewerPhase !== "ready"}
              onclick={enterEditMode}
            >编辑（Enter）</button>
          </div>
        {/if}
        {#if snapshot.txtSavePhase === "saving"}
          <p class="gallery-viewer__txt-banner" role="status">正在保存…</p>
        {:else if snapshot.txtSavePhase === "saved"}
          <p class="gallery-viewer__txt-banner" role="status">已保存。</p>
        {:else if snapshot.txtSavePhase === "conflict"}
          <p class="gallery-viewer__txt-banner gallery-viewer__txt-banner--error" role="alert">
            TXT 已被外部修改（{snapshot.txtSaveErrorCode ?? "txt_version_conflict"}），请重新加载后再试。
          </p>
        {:else if snapshot.txtSavePhase === "error"}
          <p class="gallery-viewer__txt-banner gallery-viewer__txt-banner--error" role="alert">
            保存失败（{snapshot.txtSaveErrorCode ?? "unknown"}）。草稿已保留。
          </p>
        {/if}
        {#if unsavedGuardVisible}
          <div class="gallery-viewer__txt-guard" role="alertdialog" aria-label="有未保存的 TXT 修改">
            <p>TXT 有未保存的修改。</p>
            <div class="gallery-viewer__txt-guard-actions">
              <button type="button" disabled={snapshot.txtSavePhase === "saving"} onclick={() => void saveTxt(false)}>保存</button>
              <button type="button" onclick={discardDraft}>放弃</button>
              <button type="button" onclick={() => (unsavedGuardVisible = false)}>取消</button>
            </div>
          </div>
        {/if}
        </div>
        {#if snapshot.viewerPhase === "loading"}
          <p class="gallery-viewer__txt-hint">正在读取 TXT…</p>
        {:else if snapshot.viewerPhase === "error"}
          <p class="gallery-viewer__txt-hint gallery-viewer__txt-hint--error" role="alert">
            TXT 读取失败（{snapshot.viewerErrorCode ?? "unknown"}）
          </p>
        {:else if annotation === null}
          <p class="gallery-viewer__txt-hint">暂无 TXT 数据。</p>
        {:else if annotation.content === null}
          <p class="gallery-viewer__txt-hint">该图片没有可显示的 TXT 内容。</p>
        {:else if snapshot.txtViewMode === "raw"}
          {#if isEditing}
            <textarea
              class="gallery-viewer__txt-editor"
              bind:this={textareaElement}
              value={displayContent}
              oninput={onDraftInput}
              spellcheck="false"
              aria-label="TXT 标注原文编辑"
            ></textarea>
          {:else}
            <pre class="gallery-viewer__txt-raw" ondblclick={enterEditMode}>{annotation.content}</pre>
          {/if}
        {:else}
          <ul class="gallery-viewer__txt-tags">
            {#each tags as tag (tag)}
              <li class="gallery-viewer__txt-tag">{tag}</li>
            {/each}
          </ul>
          {#if tags.length === 0}
            <p class="gallery-viewer__txt-hint">TXT 中没有可解析的逗号标签。</p>
          {/if}
        {/if}
      </aside>
    </div>

    <footer class="gallery-viewer__strip" bind:this={stripElement} aria-label="缩略图片带">
      {#each snapshot.viewerAssets as stripAsset, index (stripAsset.asset_id)}
        <button
          type="button"
          class="gallery-viewer__thumb"
          data-strip-index={index}
          aria-current={index === snapshot.viewerIndex}
          aria-label={`第 ${index + 1} 张：${stripAsset.name}`}
          onclick={() => jumpTo(index)}
        >
          <img src={service.thumbnailUrl(stripAsset.asset_id)} alt="" loading="lazy" decoding="async" />
        </button>
      {/each}
    </footer>
  </div>
{/if}
