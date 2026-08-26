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
    readonly viewerNext: () => Promise<boolean>;
    readonly viewerPrevious: () => Promise<boolean>;
    readonly onClose: () => void;
  }

  let { store, service, viewerNext, viewerPrevious, onClose }: ViewerProps = $props();

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

  function onViewerKeydown(event: KeyboardEvent) {
    if (isEditableTarget(event.target)) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (snapshot.viewerIndex < assetCount - 1) void viewerNext();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (snapshot.viewerIndex > 0) void viewerPrevious();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "0") {
      event.preventDefault();
      resetToFit();
    } else if (event.key === "1") {
      event.preventDefault();
      resetToOneToOne();
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
          <pre class="gallery-viewer__txt-raw">{annotation.content}</pre>
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
