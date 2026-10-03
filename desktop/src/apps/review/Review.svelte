<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { ApplicationId } from "../../core/applications/definitions";
  import type { ApiClient } from "../../core/api/client";
  import type { PollingHandle, PollingService } from "../../core/polling/service";
  import { createReviewController } from "./controller";
  import {
    buildReviewEngineFrame,
    createReviewEngine,
    clampReviewPan,
    panReviewZoom,
    updateReviewZoom,
    type ReviewEngine,
  } from "./engine";
  import { FILTER_LABELS } from "../filter-presets/model";
  import {
    REVIEW_FILTERS,
    resolveReviewCommand,
    reviewCanList,
    reviewErrorPresentation,
    baseModelsReady,
    type ModelSetupSnapshot,
  } from "./model";
  import { createReviewService, normalizeModelProxyUrl } from "./service";
  import { createReviewStore, focusedReviewGroup, reviewGroupsFromState } from "./state";
  import "./review.css";

  let { api, polling, onNavigate, reviewId = "", active = true, registerUnsavedChanges }: {
    api: ApiClient;
    polling: PollingService;
    onNavigate: (appId: ApplicationId) => void;
    reviewId?: string;
    active?: boolean;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void, prepare?: () => Promise<boolean>) => () => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createReviewStore();
    const service = createReviewService(api);
    const controller = createReviewController({ store, service, polling });
    return { store, service, controller };
  });
  const { store, service, controller } = runtime;
  const snapshot = $derived($store);
  const groups = $derived(reviewGroupsFromState(snapshot));
  const focusedGroup = $derived(focusedReviewGroup(snapshot));
  const images = $derived(focusedGroup ? focusedGroup.imageOrder.map((id) => focusedGroup.images[id]) : []);
  const listable = $derived(reviewCanList(snapshot.snapshot?.summary ?? null));
  let engineHost = $state<HTMLElement>();
  let reviewDeck = $state<HTMLElement>();
  let reviewDeckStage = $state<HTMLElement>();
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;
  let modelConfirmationDialog = $state<HTMLDialogElement>();
  let modelReturnFocus: FocusTarget | null = null;
  let modelSetup = $state<ModelSetupSnapshot | null>(null);
  let modelSetupError = $state("");
  const baseReady = $derived(baseModelsReady(modelSetup));
  let modelProxy = $state("");
  let modelProxyError = $state("");
  let modelConfirmationOpen = $state(false);
  let modelRequest = $state<AbortController | null>(null);
  let modelPoll: PollingHandle | null = null;
  let zoom = $state({ scale: 1, offsetX: 0, offsetY: 0 });
  let panning = $state(false);
  let panMoved = false;
  let panPointer: number | null = null;
  let panLast = { x: 0, y: 0 };
  let engine: ReviewEngine | null = null;
  let engineSequence = 0;
  let mounted = $state(false);
  let receivedReviewId = "";

  $effect(() => {
    if (!mounted) return;
    const currentId = reviewId;
    if (active) {
      untrack(() => {
        controller.activate();
        if (currentId && currentId !== receivedReviewId) {
          receivedReviewId = currentId;
          void openReviewAndFocus(currentId);
        }
        void refreshModelSetup();
        updateEngine();
      });
    } else {
      untrack(() => { controller.deactivate(); stopModelPolling(); modelRequest?.abort(); modelRequest = null; });
    }
  });

  function displayMessage(message: string): string {
    return message
      .replaceAll("权威审核快照", "审核结果")
      .replaceAll("权威审核状态", "审核结果")
      .replaceAll("安全快照", "审核结果");
  }
  function selectValue(event: Event): string { return (event.currentTarget as HTMLSelectElement).value; }
  function currentState() { return store.getState(); }
  function updateEngine(state = currentState()): void {
    const sequence = ++engineSequence;
    void tick().then(() => {
      if (!engine || sequence !== engineSequence) return;
      if (!active) { engine.release(); return; }
      const frame = buildReviewEngineFrame(state.snapshot, state.focusedGroupId, state.activeImageId, service.imageUrl);
      if (frame) engine.update(frame);
      else engine.release();
    });
  }
  function focusActiveImage(): void {
    void tick().then(() => {
      if (!active) return;
      const target = reviewDeck?.querySelector<HTMLElement>('[data-review-engine-card][data-active="true"]') ?? reviewDeck;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  async function openReviewAndFocus(reviewId: string): Promise<void> {
    if (await controller.openReview(reviewId) && active) focusActiveImage();
  }
  async function setFilterAndFocus(filter: (typeof REVIEW_FILTERS)[number]["id"]): Promise<void> {
    if (await controller.setFilter(filter)) focusActiveImage();
  }
  function moveGroupAndFocus(direction: -1 | 1): void {
    if (controller.moveGroup(direction)) { resetZoom(); focusActiveImage(); }
  }
  function moveImageAndFocus(direction: -1 | 1): void {
    if (controller.moveImage(direction)) focusActiveImage();
  }
  async function adoptAndFocus(): Promise<void> {
    if (await controller.adoptFocused()) focusActiveImage();
  }
  function resetZoom(): void {
    zoom = { scale: 1, offsetX: 0, offsetY: 0 };
  }
  /** 以焦点图为基准做边缘约束：放大时图片盖住视口，适配时回到居中（视窗查看器手感）。 */
  function clampZoomToActive(state: Readonly<{ scale: number; offsetX: number; offsetY: number }>): Readonly<{ scale: number; offsetX: number; offsetY: number }> {
    const media = reviewDeckStage?.querySelector<HTMLElement>('[data-review-engine-card][data-active="true"] .review-image-media');
    const img = media?.querySelector<HTMLImageElement>("img");
    if (!media || !img || !img.naturalWidth || !img.naturalHeight) return state;
    return clampReviewPan(state, img.naturalWidth, img.naturalHeight, { width: media.clientWidth, height: media.clientHeight });
  }
  function onStageWheel(event: WheelEvent): void {
    if (!images.some((image) => image.readable)) return;
    event.preventDefault();
    const rect = reviewDeckStage?.getBoundingClientRect();
    if (!rect) return;
    zoom = clampZoomToActive(updateReviewZoom(
      zoom,
      { deltaY: event.deltaY, anchorX: event.clientX - rect.left - rect.width / 2, anchorY: event.clientY - rect.top - rect.height / 2 },
      { width: rect.width, height: rect.height },
    ));
  }
  function onStagePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target?.closest?.("[data-review-engine-card]")) return;
    panPointer = event.pointerId;
    panLast = { x: event.clientX, y: event.clientY };
    panMoved = false;
    panning = true;
  }
  function onStagePointerMove(event: PointerEvent): void {
    if (panPointer !== event.pointerId) return;
    // 主键已松开（原生拖拽/系统手势吞掉 pointerup 的场景）：立即结束平移。
    if ((event.buttons & 1) === 0) {
      panning = false;
      panPointer = null;
      return;
    }
    const delta = { x: event.clientX - panLast.x, y: event.clientY - panLast.y };
    panLast = { x: event.clientX, y: event.clientY };
    if (!panMoved && Math.abs(delta.x) + Math.abs(delta.y) < 2) return;
    if (!panMoved) {
      panMoved = true;
      reviewDeckStage?.setPointerCapture(event.pointerId);
    }
    zoom = clampZoomToActive(panReviewZoom(zoom, delta));
  }
  function onStagePointerUp(event: PointerEvent): void {
    if (panPointer !== event.pointerId) return;
    panning = false;
    panPointer = null;
  }
  function onStagePointerCancel(event: PointerEvent): void {
    if (panPointer !== event.pointerId) return;
    panning = false;
    panPointer = null;
  }
  function onImageClick(groupId: string, imageId: string): void {
    if (panMoved) return;
    toggleImage(groupId, imageId);
  }
  function toggleImage(groupId: string, imageId: string): void {
    controller.setActiveImage(imageId);
    controller.toggleImage(groupId, imageId);
  }
  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }
  function modelDialogItems(): HTMLElement[] {
    return [...(modelConfirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }
  function stopModelPolling(): void {
    modelPoll?.stop();
    modelPoll = null;
  }
  function describeSetupError(error: unknown): string {
    const presentation = reviewErrorPresentation(error);
    return `${presentation.message} ${presentation.nextStep}`.trim();
  }
  function syncModelPolling(): void {
    stopModelPolling();
    if (!active || modelSetup?.phase !== "installing") return;
    modelPoll = polling.start({
      key: "review.model-setup",
      scope: "app:review-model-setup",
      intervalMs: 750,
      immediate: false,
      critical: false,
      task: (signal) => service.readModelSetup(signal),
      onResult: (status) => {
        const completed = modelSetup?.phase === "installing" && baseModelsReady(status);
        modelSetup = status;
        modelSetupError = "";
        if (status.phase !== "installing") stopModelPolling();
        if (completed) void controller.refresh();
      },
      onError: (error) => {
        modelSetupError = describeSetupError(error);
        stopModelPolling();
      },
    });
  }
  async function refreshModelSetup(): Promise<void> {
    if (!active) return;
    stopModelPolling();
    modelRequest?.abort();
    const request = new AbortController();
    modelRequest = request;
    try {
      const status = await service.readModelSetup(request.signal);
      if (modelRequest !== request || request.signal.aborted) return;
      modelSetup = status;
      modelSetupError = "";
      syncModelPolling();
    } catch (error) {
      if (!request.signal.aborted) modelSetupError = describeSetupError(error);
    } finally {
      if (modelRequest === request) modelRequest = null;
    }
  }
  function openModelConfirmation(): void {
    if (modelSetup?.phase === "installing") return;
    modelReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modelProxyError = "";
    modelConfirmationOpen = true;
  }
  function closeModelConfirmation(): void {
    const target = modelReturnFocus;
    modelReturnFocus = null;
    modelConfirmationOpen = false;
    modelProxy = "";
    modelProxyError = "";
    modelConfirmationDialog?.close();
    void tick().then(() => restoreFocus(target));
  }
  async function installModels(): Promise<void> {
    let proxyUrl: string;
    try {
      proxyUrl = normalizeModelProxyUrl(modelProxy);
    } catch {
      modelProxyError = "代理地址格式不正确，请输入带协议和端口的地址，例如 http://127.0.0.1:7890。";
      return;
    }
    modelProxyError = "";
    modelProxy = "";
    modelConfirmationOpen = false;
    modelConfirmationDialog?.close();
    modelRequest?.abort();
    const request = new AbortController();
    modelRequest = request;
    modelSetupError = "";
    try {
      const status = await service.installModels(proxyUrl, request.signal);
      if (modelRequest !== request || request.signal.aborted) return;
      modelSetup = status;
      syncModelPolling();
    } catch (error) {
      if (!request.signal.aborted) modelSetupError = describeSetupError(error);
    } finally {
      if (modelRequest === request) modelRequest = null;
      const target = modelReturnFocus;
      modelReturnFocus = null;
      void tick().then(() => restoreFocus(target));
    }
  }
  function onModelDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); closeModelConfirmation(); return; }
    if (event.key !== "Tab") return;
    const items = modelDialogItems();
    const next = trappedTabIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
    if (next !== null) { event.preventDefault(); restoreFocus(items[next]); }
  }
  function formatMegabytes(bytes: number): string {
    return `${Math.round(bytes / 1_000_000)} MB`;
  }
  function resolveConfirmation(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    void controller.confirmAction(confirmed);
    void tick().then(() => restoreFocus(target));
  }
  function onConfirmationKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); resolveConfirmation(false); return; }
    if (event.key !== "Tab") return;
    const items = focusableDialogItems();
    const next = trappedTabIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
    if (next !== null) { event.preventDefault(); restoreFocus(items[next]); }
  }
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!snapshot.snapshot?.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  }
  function onDeckKeydown(event: KeyboardEvent): void {
    if (!active || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || snapshot.busy) return;
    const target = event.target as Element | null;
    if (target?.closest?.("input, select, textarea, a[href], [contenteditable]")) return;
    const imageCard = target?.closest?.("[data-review-engine-card]");
    if (!imageCard && (event.key === " " || event.key === "Enter")) return;
    const command = resolveReviewCommand(event.key, {
      editable: snapshot.snapshot?.summary.status === "ready" && Boolean(focusedGroup?.imageOrder.length),
      readOnly: Boolean(snapshot.snapshot && snapshot.snapshot.summary.status !== "ready"),
      hasImages: Boolean(focusedGroup?.imageOrder.length),
    });
    if (!command) return;
    event.preventDefault();
    if (command === "previous-group") moveGroupAndFocus(-1);
    else if (command === "focus-previous-image") moveImageAndFocus(-1);
    else if (command === "focus-next-image") moveImageAndFocus(1);
    else if (command === "toggle-active-image" && focusedGroup && snapshot.activeImageId) controller.toggleImage(focusedGroup.id, snapshot.activeImageId);
    else if (command === "accept-advance") void adoptAndFocus();
    else if (command === "browse-next-group") moveGroupAndFocus(1);
  }

  $effect(() => {
    if (!active || !snapshot.confirmation) { confirmationDialog?.close(); return; }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (confirmationDialog && !confirmationDialog.open && typeof confirmationDialog.showModal === "function") confirmationDialog.showModal();
      restoreFocus(focusableDialogItems()[0] ?? confirmationDialog);
    });
  });

  $effect(() => {
    if (!active || !modelConfirmationOpen) { modelConfirmationDialog?.close(); return; }
    void tick().then(() => {
      if (modelConfirmationDialog && !modelConfirmationDialog.open && typeof modelConfirmationDialog.showModal === "function") modelConfirmationDialog.showModal();
      restoreFocus(modelDialogItems()[0] ?? modelConfirmationDialog);
    });
  });

  onMount(() => {
    if (!engineHost) return;
    engine = createReviewEngine({ host: engineHost });
    const unsubscribe = store.subscribe((state) => updateEngine(state));
    const unregister = registerUnsavedChanges?.(
      () => Boolean(store.getState().snapshot?.dirty),
      controller.discardDraft,
      controller.beforeLeave,
    ) ?? (() => {});
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    mounted = true;
    return () => {
      engineSequence += 1;
      modelRequest?.abort();
      stopModelPolling();
      unregister();
      unsubscribe();
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      controller.destroy();
      engine?.destroy();
      engine = null;
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (application-level review shortcuts) -->
<section class="review-app" data-review-app data-domain-owner="review" data-mode={listable ? "deck" : "panel"} aria-labelledby="review-heading" aria-busy={Boolean(snapshot.busy)} onkeydown={onDeckKeydown}>
  <header class="review-header">
    <h1 id="review-heading">去重</h1>
    <span class="review-status" data-kind={snapshot.presentation.kind}>{snapshot.presentation.label}</span>
    <details class="review-model-setup" data-phase={baseReady ? "ready" : modelSetup?.phase === "ready" ? "idle" : modelSetup?.phase ?? "loading"} aria-labelledby="review-model-heading" aria-busy={modelSetup?.phase === "installing"} open={!baseReady || Boolean(modelSetupError)}>
      <summary><h2 id="review-model-heading">相似图片模型</h2><span>{baseReady ? "已启用" : modelSetup?.phase === "installing" ? "正在下载" : modelSetup?.installed ? "等待启用" : "下载并启用"}</span></summary>
      <div class="review-model-content">
        <div class="review-model-copy">
          <p>{baseReady ? "SSCD 与 DINOv2 已就绪，可在图库发起相似图片去重。" : "下载约 190 MB 的 SSCD 与 DINOv2 模型，用于发现相似图片。"}</p>
        </div>
        {#if modelSetup?.phase === "installing"}
          <div class="review-model-progress" role="status" aria-live="polite">
            <progress max={modelSetup.expectedBytes} value={modelSetup.downloadedBytes}></progress>
            <span>{formatMegabytes(modelSetup.downloadedBytes)} / {formatMegabytes(modelSetup.expectedBytes)}{modelSetup.usingProxy ? " · 使用本次代理" : ""}</span>
            <small>{modelSetup.message || "正在下载并检查模型"}</small>
          </div>
        {/if}
        {#if modelSetupError || modelSetup?.phase === "failed"}<p class="review-model-error" role="alert">{modelSetupError || modelSetup?.message || "模型准备失败，请重试。"}</p>{/if}
        <div class="review-model-actions">
          {#if !baseReady}<button type="button" class="review-button review-button--primary" disabled={!modelSetup || modelSetup.phase === "installing"} onclick={openModelConfirmation}>{modelSetup?.installed ? "启用模型" : modelSetup?.phase === "failed" ? "重新下载" : "下载并启用"}</button>{/if}
          <button type="button" disabled={Boolean(modelRequest)} onclick={() => void refreshModelSetup()}>刷新状态</button>
        </div>
      </div>
    </details>
  </header>

  {#if snapshot.error}
    <section class="review-error" role="alert" aria-labelledby="review-error-title">
      <div><strong id="review-error-title">{snapshot.error.title}</strong><p>{displayMessage(`${snapshot.error.message} ${snapshot.error.nextStep}`)}</p><small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small></div>
      <div><button type="button" onclick={() => onNavigate("diagnostics")}>打开系统诊断</button>{#if snapshot.error.conflict && snapshot.snapshot?.dirty}<button type="button" class="review-button review-button--dangerous" onclick={() => controller.discardDraft()}>放弃未采纳更改</button>{/if}</div>
    </section>
  {/if}

  <section class="review-picker" aria-label="审核任务操作">
    <div class="review-picker-actions">
      <button type="button" disabled={Boolean(snapshot.busy)} onclick={() => void controller.refresh()}>刷新</button>
      <button type="button" onclick={() => onNavigate("gallery")}>打开图库</button>
    </div>
  </section>

  {#if snapshot.pendingReviewId && snapshot.snapshot}
    <section class="review-switch" role="status" data-review-pending={snapshot.pendingReviewId}>
      <p>新去重任务已收到；切换将结束当前任务，未采纳的筛选结果会丢弃。</p>
      <button type="button" disabled={Boolean(snapshot.busy)} onclick={() => void controller.switchToPending()}>结束当前任务并切换</button>
      <button type="button" disabled={Boolean(snapshot.busy)} onclick={() => controller.stayOnTask()}>留在当前任务</button>
    </section>
  {/if}

  {#if snapshot.snapshot}
    <p class="review-directory-summary" data-review-directories>{#if snapshot.snapshot.directories.length}{snapshot.snapshot.directories.map((directory) => `${directory.sourceLabel} / ${directory.relativePath || "来源根目录"}`).join(" · ")} · 递归子目录，整组选区跨目录比较 · {:else}勾选图片 · {/if}{snapshot.snapshot.summary.totalImageCount} 张图片 · 机器初筛回收 {snapshot.snapshot.summary.automaticRejectedImageCount} 张{#if snapshot.snapshot.summary.filteredImageCount > 0}<span data-review-filtered-count> · <span>其中自动过滤</span> {snapshot.snapshot.summary.filteredImageCount} <span>张</span></span>{/if}</p>
    {#if snapshot.snapshot.filterConfig}
      {@const config = snapshot.snapshot.filterConfig}
      {#key snapshot.snapshot.reviewId}
        <details class="review-filter-config" data-review-filter-config>
          <summary><span>预设：</span>{config.preset_name} · <span>查看本次配置</span></summary>
          <div><p>本次任务的冻结配置；之后修改预设不会影响本次任务。</p>
            <dl>{#each Object.entries(FILTER_LABELS) as [key, label]}<div><dt>{label}</dt><dd>{config.options[key as keyof typeof FILTER_LABELS] ? "启用" : "未启用"}</dd></div>{/each}<div><dt>角色参考图</dt><dd data-review-reference-count>{config.options.reference_asset_ids.length}</dd></div></dl>
            {#if config.options.reference_asset_ids.length}<ul aria-label="本次参考图">{#each config.options.reference_asset_ids as id, index (`${index}:${id}`)}<li>{id}</li>{/each}</ul>{/if}
          </div>
        </details>
      {/key}
    {/if}
  {/if}

  <p class="review-operation-live" data-review-dirty={Boolean(snapshot.snapshot?.dirty)} role="status" aria-live="polite">{displayMessage(snapshot.message)}</p>

  <section class="review-engine-host" bind:this={engineHost}>
    {#if snapshot.snapshot}
      <section class="review-toolbar" aria-label="审核工具栏">
        <div class="review-tabs" role="tablist" aria-label="审核组筛选">{#each REVIEW_FILTERS as filter (filter.id)}<button type="button" role="tab" class:review-tab--active={snapshot.snapshot.filter === filter.id} aria-selected={snapshot.snapshot.filter === filter.id} disabled={Boolean(snapshot.busy)} onclick={() => void setFilterAndFocus(filter.id)}>{filter.label}</button>{/each}</div>
        <div class="review-toolbar-actions">
          <button type="button" class="review-button review-button--primary review-finish" data-review-finish disabled={Boolean(snapshot.busy)} onclick={() => void controller.finish()}>完成</button>
        </div>
      </section>
      <p class="filter-help">线稿/草图、单色仅辅助分类，不自动排除；命中任一图片时显示完整原组，各分类共用同一份采纳决定。</p>

      {#if listable && focusedGroup}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-operated review deck) -->
        <section class="review-deck" data-review-deck bind:this={reviewDeck} tabindex="0" aria-label="去重审核全高分拣台；左右键移动图片，空格切换保留，Enter 采纳并前进，Escape 返回上一组">
          <header class="review-deck-header">
            <h2>组 {focusedGroup.ordinal} · {focusedGroup.kind === "duplicate" ? "重复组" : focusedGroup.kind === "single" ? "独立图片" : "读取受限"}</h2>
            <div class="review-group-controls"><button type="button" disabled={Boolean(snapshot.busy) || snapshot.snapshot.groupOrder.indexOf(focusedGroup.id) === 0} onclick={() => moveGroupAndFocus(-1)}>上一组</button><label><span class="visually-hidden">当前筛选全量组选择器</span><select data-review-group-select aria-label="当前筛选全量组选择器" value={focusedGroup.id} disabled={Boolean(snapshot.busy)} onchange={(event) => { if (controller.setFocusedGroup(selectValue(event))) focusActiveImage(); }}>{#each groups as group (group.id)}<option value={group.id}>{group.ordinal}. {group.kind === "duplicate" ? "重复组" : group.kind === "single" ? "独立图片" : "读取受限"} · {group.selectedImageCount}/{group.imageCount} 保留{group.decided ? " · 已采纳" : ""}</option>{/each}</select></label><button type="button" disabled={Boolean(snapshot.busy) || snapshot.snapshot.groupOrder.indexOf(focusedGroup.id) === snapshot.snapshot.groupOrder.length - 1} onclick={() => moveGroupAndFocus(1)}>下一组</button></div>
          </header>

          <section class="review-deck-stage" aria-label={`组 ${focusedGroup.ordinal} 图片比较舞台`} bind:this={reviewDeckStage} data-review-panning={panning} data-review-zoomed={zoom.scale !== 1 || zoom.offsetX !== 0 || zoom.offsetY !== 0} onwheel={onStageWheel} onpointerdown={onStagePointerDown} onpointermove={onStagePointerMove} onpointerup={onStagePointerUp} onpointercancel={onStagePointerCancel} ondblclick={resetZoom}>
            <div class="review-deck-cards" data-review-engine-grid>
              {#each images as image (image.id)}
                <button type="button" class="review-image-card" data-review-engine-card={image.id} data-selected={image.selected} data-active={snapshot.activeImageId === image.id} data-failed={image.failed || undefined} aria-checked={image.selected} aria-current={snapshot.activeImageId === image.id} aria-disabled={snapshot.snapshot.summary.status !== "ready" || Boolean(snapshot.busy)} role="checkbox" onclick={() => onImageClick(focusedGroup.id, image.id)} onfocus={() => controller.setActiveImage(image.id)}>
                  <span class="review-image-media"><img data-review-engine-image draggable="false" data-review-engine-decoded="false" alt={`组 ${focusedGroup.ordinal} 图 ${image.ordinal}`} crossorigin="anonymous" decoding="async" style:transform={`translate(${zoom.offsetX}px, ${zoom.offsetY}px) scale(${zoom.scale})`} /><span class="review-image-fallback">{image.readable ? "预览加载失败" : "图片不可读"}</span></span>
                  <span class="review-image-card-copy"><strong>图 {image.ordinal}{image.recommended ? " · 推荐项" : ""}</strong><span title={`${image.sourceLabel} / ${image.relativePath}`}>{image.sourceLabel} / {image.relativePath}</span><span>{image.width} × {image.height}</span>{#if image.classification}<span data-review-classification>{image.classification === "rough" ? "线稿/草图" : "单色"}<span> · </span><span>辅助分类</span></span>{/if}<span class="review-image-stamp" data-state={image.selected ? "keep" : "drop"}>{image.selected ? "✓ 保留" : "✗ 回收"}</span>{#if image.failed}<span class="review-image-error-marker" role="status">落地失败</span>{/if}<span class="review-image-active-marker">当前检查</span></span>
                </button>
              {/each}
            </div>
            {#if !images.length}<p class="review-empty">当前组没有图片。</p>{/if}
          </section>

          <footer class="review-deck-statusbar">
            <div><span>{snapshot.snapshot.summary.decidedGroupCount} / {snapshot.snapshot.summary.totalGroupCount} 组已采纳</span><span>当前组 {focusedGroup.selectedImageCount} / {focusedGroup.imageCount} 保留</span><span data-review-zoom>缩放 {Math.round(zoom.scale * 100)}%</span></div>
            <details class="review-shortcut-hints"><summary>快捷键</summary><div><kbd>←/→</kbd> 图片 <kbd>Space</kbd> 保留/回收 <kbd>Enter</kbd> 采纳并前进 <kbd>Esc</kbd> 上一组 <kbd>滚轮</kbd> 同步缩放 <kbd>拖动</kbd> 平移 <kbd>双击</kbd> 复位</div></details>
            <button type="button" class="review-button review-button--primary" disabled={snapshot.snapshot.summary.status !== "ready" || Boolean(snapshot.busy)} onclick={() => void adoptAndFocus()}>采纳并前进</button>
          </footer>
        </section>
      {:else}
        <section class="review-panel" aria-labelledby="review-state-heading"><h2 id="review-state-heading">{snapshot.snapshot.summary.statusLabel}</h2><p>{displayMessage(snapshot.presentation.message)}</p><dl><div><dt>图片</dt><dd>{snapshot.snapshot.summary.totalImageCount}</dd></div><div><dt>审核组</dt><dd>{snapshot.snapshot.summary.totalGroupCount}</dd></div><div><dt>重复组</dt><dd>{snapshot.snapshot.summary.duplicateGroupCount}</dd></div><div><dt>读取失败</dt><dd>{snapshot.snapshot.summary.unreadableImageCount}</dd></div></dl></section>
      {/if}
    {:else}
      <section class="review-panel review-empty" aria-labelledby="review-empty-heading"><h2 id="review-empty-heading">尚无去重任务</h2><p>请在图库勾选图片或目录发起去重。</p><button type="button" onclick={() => onNavigate("gallery")}>打开图库</button></section>
    {/if}
  </section>
</section>

{#if modelConfirmationOpen}
  <dialog class="review-confirmation review-model-confirmation" aria-modal="true" aria-labelledby="review-model-confirmation-title" aria-describedby="review-model-confirmation-message" bind:this={modelConfirmationDialog} oncancel={(event) => { event.preventDefault(); closeModelConfirmation(); }} onkeydown={onModelDialogKeydown} onclick={(event) => { if (event.target === event.currentTarget) closeModelConfirmation(); }}>
    <section>
      <h2 id="review-model-confirmation-title">下载并启用相似图片模型？</h2>
      <p id="review-model-confirmation-message">将下载约 {formatMegabytes(190_000_000)} 的 SSCD 与 DINOv2 模型。下载完成后自动启用，不需要重启 LDOS。</p>
      <label class="review-model-proxy">
        <span>本次下载代理（可选）</span>
        <input
          type="text"
          maxlength="300"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          inputmode="url"
          aria-invalid={Boolean(modelProxyError)}
          aria-describedby={modelProxyError ? "review-model-proxy-help review-model-proxy-error" : "review-model-proxy-help"}
          placeholder="http://127.0.0.1:7890"
          bind:value={modelProxy}
          oninput={() => { modelProxyError = ""; }}
        />
        <small id="review-model-proxy-help">仅用于这次下载，不会保存。</small>
        {#if modelProxyError}<small id="review-model-proxy-error" class="review-model-proxy-error" role="alert">{modelProxyError}</small>{/if}
      </label>
      <p class="review-confirmation-warning">Release 版使用 CPU 运行模型，首次分析可能需要一些时间。</p>
      <div><button type="button" onclick={closeModelConfirmation}>取消</button><button type="button" class="review-button review-button--primary" onclick={() => void installModels()}>开始下载</button></div>
    </section>
  </dialog>
{/if}

{#if snapshot.confirmation}
  <dialog class="review-confirmation" data-review-confirmation={snapshot.confirmation.action} aria-modal="true" aria-labelledby="review-confirmation-title" aria-describedby="review-confirmation-message review-confirmation-warning" bind:this={confirmationDialog} oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }} onkeydown={onConfirmationKeydown} onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}>
    <section><h2 id="review-confirmation-title">{snapshot.confirmation.title}</h2><p id="review-confirmation-message">{snapshot.confirmation.message}</p><p id="review-confirmation-warning" class="review-confirmation-warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p><div><button type="button" onclick={() => resolveConfirmation(false)}>取消</button><button type="button" class="review-button review-button--dangerous" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button></div></section>
  </dialog>
{/if}
