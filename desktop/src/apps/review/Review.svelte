<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { ApplicationId } from "../../core/applications/definitions";
  import type { ApiClient } from "../../core/api/client";
  import type { PersistenceService } from "../../core/persistence/service";
  import type { PollingService } from "../../core/polling/service";
  import { createReviewController } from "./controller";
  import {
    REVIEW_DEFAULT_MAGNIFICATION,
    buildReviewEngineFrame,
    createReviewEngine,
    formatReviewMagnification,
    type ReviewEngine,
    type ReviewLoupeState,
  } from "./engine";
  import { REVIEW_FILTERS, resolveReviewCommand, reviewCanList } from "./model";
  import { createReviewService } from "./service";
  import { createReviewStore, focusedReviewGroup, reviewGroupsFromState } from "./state";
  import "./review.css";

  let { api, polling, persistence, onNavigate, registerUnsavedChanges }: {
    api: ApiClient;
    polling: PollingService;
    persistence: PersistenceService;
    onNavigate: (appId: ApplicationId) => void;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void, prepare?: () => Promise<boolean>) => () => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createReviewStore();
    const service = createReviewService(api);
    const controller = createReviewController({ store, service, polling, persistence });
    return { store, service, controller };
  });
  const { store, service, controller } = runtime;
  const snapshot = $derived($store);
  const groups = $derived(reviewGroupsFromState(snapshot));
  const focusedGroup = $derived(focusedReviewGroup(snapshot));
  const images = $derived(focusedGroup ? focusedGroup.imageOrder.map((id) => focusedGroup.images[id]) : []);
  const listable = $derived(reviewCanList(snapshot.snapshot?.summary ?? null));
  let engineHost = $state<HTMLElement>();
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;
  let loupeEnabled = $state(false);
  let loupeState = $state<ReviewLoupeState>({ active: false, pinned: false, magnification: REVIEW_DEFAULT_MAGNIFICATION });
  let engine: ReviewEngine | null = null;
  let engineSequence = 0;

  function selectValue(event: Event): string { return (event.currentTarget as HTMLSelectElement).value; }
  function currentState() { return store.getState(); }
  function updateEngine(state = currentState()): void {
    const sequence = ++engineSequence;
    void tick().then(() => {
      if (!engine || sequence !== engineSequence) return;
      const frame = buildReviewEngineFrame(state.snapshot, state.focusedGroupId, state.activeImageId, loupeEnabled, service.imageUrl);
      if (frame) engine.update(frame);
      else engine.release();
    });
  }
  function toggleLoupe(): void {
    loupeEnabled = !loupeEnabled;
    if (!loupeEnabled) engine?.setPinned(false);
    updateEngine();
  }
  function toggleLoupePin(): void {
    engine?.setPinned(!loupeState.pinned);
  }
  function toggleImage(groupId: string, imageId: string): void {
    controller.setActiveImage(imageId);
    controller.toggleImage(groupId, imageId);
  }
  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
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
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || snapshot.busy) return;
    if ((event.target as Element | null)?.closest?.("input, select, textarea, button, a[href], [contenteditable]")) return;
    const command = resolveReviewCommand(event.key, {
      editable: snapshot.snapshot?.summary.status === "ready" && Boolean(focusedGroup?.imageOrder.length),
      readOnly: Boolean(snapshot.snapshot && snapshot.snapshot.summary.status !== "ready"),
      hasImages: Boolean(focusedGroup?.imageOrder.length),
      loupeAvailable: images.some((image) => image.readable),
    });
    if (!command) return;
    event.preventDefault();
    if (command === "previous-group") controller.moveGroup(-1);
    else if (command === "focus-previous-image") controller.moveImage(-1);
    else if (command === "focus-next-image") controller.moveImage(1);
    else if (command === "toggle-active-image" && focusedGroup && snapshot.activeImageId) controller.toggleImage(focusedGroup.id, snapshot.activeImageId);
    else if (command === "accept-advance") void controller.confirmAndAdvance();
    else if (command === "browse-next-group") controller.moveGroup(1);
    else if (command === "toggle-loupe") toggleLoupe();
  }
  function formatTime(value: number | null): string {
    return value === null ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(new Date(value * 1_000));
  }

  $effect(() => {
    if (!snapshot.confirmation) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (confirmationDialog && !confirmationDialog.open && typeof confirmationDialog.showModal === "function") confirmationDialog.showModal();
      restoreFocus(focusableDialogItems()[0] ?? confirmationDialog);
    });
  });

  onMount(() => {
    if (!engineHost) return;
    engine = createReviewEngine({ host: engineHost, onLoupeState: (state) => { loupeState = state; } });
    const unsubscribe = store.subscribe((state) => updateEngine(state));
    const unregister = registerUnsavedChanges?.(
      () => Boolean(store.getState().snapshot?.dirty),
      controller.discardDraft,
      controller.beforeLeave,
    ) ?? (() => {});
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    controller.activate();
    return () => {
      engineSequence += 1;
      unregister();
      unsubscribe();
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      controller.destroy();
      engine?.destroy();
      engine = null;
    };
  });
</script>

<section class="review-app" data-review-app data-domain-owner="review" data-mode={listable ? "deck" : "panel"} aria-labelledby="review-heading" aria-busy={Boolean(snapshot.busy)}>
  <header class="review-header">
    <div><p>去重审核</p><h1 id="review-heading">比较、确认与文件整理</h1></div>
    <span class="review-status" data-kind={snapshot.presentation.kind}>{snapshot.presentation.label}</span>
  </header>

  {#if snapshot.error}
    <section class="review-error" role="alert" aria-labelledby="review-error-title">
      <div><strong id="review-error-title">{snapshot.error.title}</strong><p>{snapshot.error.message} {snapshot.error.nextStep}</p><small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small></div>
      <div><button type="button" onclick={() => onNavigate("diagnostics")}>打开系统诊断</button>{#if snapshot.error.conflict && snapshot.snapshot?.dirty}<button type="button" class="review-button review-button--dangerous" onclick={() => controller.requestDiscardReload()}>放弃草稿并重读</button>{/if}</div>
    </section>
  {/if}

  <section class="review-picker" aria-labelledby="review-picker-heading">
    <div><p>批次</p><h2 id="review-picker-heading">已结束批次</h2></div>
    <label><span class="visually-hidden">已结束批次</span><select aria-label="已结束批次" value={snapshot.selectedBatchId} disabled={Boolean(snapshot.busy)} onchange={(event) => controller.selectBatch(selectValue(event))}><option value="">{snapshot.recent.some((batch) => batch.terminal) ? "选择已结束批次" : "暂无已结束批次"}</option>{#each snapshot.recent.filter((batch) => batch.terminal) as batch (batch.id)}<option value={batch.id}>{batch.statusLabel} · {formatTime(batch.createdAt)} · {batch.id.slice(0, 12)}</option>{/each}</select></label>
    <div class="review-picker-actions"><button type="button" class="review-button review-button--primary" disabled={Boolean(snapshot.busy || !snapshot.selectedBatchId)} onclick={() => void controller.loadSelected()}>打开审核</button><button type="button" disabled={Boolean(snapshot.busy)} onclick={() => void controller.refresh()}>刷新</button><button type="button" onclick={() => onNavigate("tasks")}>打开批次管理</button></div>
  </section>

  <p class="review-operation-live" data-review-dirty={Boolean(snapshot.snapshot?.dirty)} role="status" aria-live="polite">{snapshot.message}</p>

  <section class="review-engine-host" bind:this={engineHost}>
    {#if snapshot.snapshot}
      <section class="review-toolbar" aria-label="审核工具栏">
        <div class="review-tabs" role="tablist" aria-label="审核组筛选">{#each REVIEW_FILTERS as filter (filter.id)}<button type="button" role="tab" class:review-tab--active={snapshot.snapshot.filter === filter.id} aria-selected={snapshot.snapshot.filter === filter.id} disabled={Boolean(snapshot.busy)} onclick={() => void controller.setFilter(filter.id)}>{filter.label}</button>{/each}</div>
        <div class="review-toolbar-actions">
          <button type="button" disabled={Boolean(snapshot.busy || !snapshot.snapshot.dirty)} onclick={() => void controller.save()}>保存待提交组</button>
          <button type="button" aria-pressed={loupeEnabled} disabled={!images.some((image) => image.readable)} onclick={toggleLoupe}>{loupeEnabled ? "关闭放大镜" : "开启放大镜"}</button>
          <button type="button" aria-pressed={loupeState.pinned} disabled={!loupeEnabled || !images.some((image) => image.readable)} onclick={toggleLoupePin}>{loupeState.pinned ? "解除锁定" : "锁定坐标"}</button>
          {#if snapshot.snapshot.summary.status === "not_started" || snapshot.snapshot.summary.status === "waiting_for_crawl"}<button type="button" class="review-button review-button--primary" disabled={Boolean(snapshot.busy)} onclick={() => void controller.run("start")}>开始分析</button>{/if}
          {#if snapshot.snapshot.summary.status === "failed"}<button type="button" class="review-button review-button--primary" disabled={Boolean(snapshot.busy)} onclick={() => void controller.run("retry")}>重试分析</button>{/if}
          {#if snapshot.snapshot.summary.status === "ready" || snapshot.snapshot.summary.status === "apply_failed"}<button type="button" class="review-button review-button--dangerous" disabled={Boolean(snapshot.busy || snapshot.snapshot.dirty || snapshot.snapshot.summary.decidedGroupCount < snapshot.snapshot.summary.totalGroupCount)} onclick={() => controller.requestApply()}>{snapshot.snapshot.summary.status === "apply_failed" ? "重试整理" : "应用并整理文件"}</button>{/if}
        </div>
      </section>

      {#if listable && focusedGroup}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-operated review deck) -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard-operated review deck) -->
        <section class="review-deck" tabindex="0" onkeydown={onDeckKeydown} aria-label="去重审核全高分拣台；方向键移动图片，空格切换保留，Enter 采纳并前进，X 切换放大镜">
          <header class="review-deck-header">
            <div><p>当前筛选全量组选择器</p><h2>组 {focusedGroup.ordinal} · {focusedGroup.kind === "duplicate" ? "重复组" : focusedGroup.kind === "single" ? "独立图片" : "读取受限"}</h2></div>
            <div class="review-group-controls"><button type="button" disabled={Boolean(snapshot.busy) || snapshot.snapshot.groupOrder.indexOf(focusedGroup.id) === 0} onclick={() => controller.moveGroup(-1)}>上一组</button><label><span class="visually-hidden">当前筛选全量组选择器</span><select data-review-group-select aria-label="当前筛选全量组选择器" value={focusedGroup.id} disabled={Boolean(snapshot.busy)} onchange={(event) => controller.setFocusedGroup(selectValue(event))}>{#each groups as group (group.id)}<option value={group.id}>{group.ordinal}. {group.kind} · {group.selectedImageCount}/{group.imageCount} 保留{group.decided ? " · 已确认" : ""}</option>{/each}</select></label><button type="button" disabled={Boolean(snapshot.busy) || snapshot.snapshot.groupOrder.indexOf(focusedGroup.id) === snapshot.snapshot.groupOrder.length - 1} onclick={() => controller.moveGroup(1)}>下一组</button></div>
          </header>

          <section class="review-deck-stage" aria-label={`组 ${focusedGroup.ordinal} 图片比较舞台`}>
            <div class="review-deck-cards" data-review-engine-grid>
              {#each images as image (image.id)}
                <button type="button" class="review-image-card" data-review-engine-card={image.id} data-selected={image.selected} data-active={snapshot.activeImageId === image.id} aria-checked={image.selected} aria-current={snapshot.activeImageId === image.id} aria-disabled={snapshot.snapshot.summary.status !== "ready" || Boolean(snapshot.busy)} role="checkbox" onclick={() => toggleImage(focusedGroup.id, image.id)} onfocus={() => controller.setActiveImage(image.id)}>
                  <span class="review-image-media"><img data-review-engine-image data-review-engine-decoded="false" alt={`组 ${focusedGroup.ordinal} 图 ${image.ordinal}`} crossorigin="anonymous" decoding="async" /><span class="review-image-fallback">{image.readable ? "预览加载失败" : "图片不可读"}</span><span class="review-image-crosshair" data-review-engine-crosshair hidden></span><canvas class="review-loupe-lens" data-review-engine-lens width="1" height="1" hidden aria-hidden="true"></canvas></span>
                  <span class="review-image-card-copy"><strong>图 {image.ordinal}{image.recommended ? " · 推荐项" : ""}</strong><span>{image.width} × {image.height}</span><span class="review-image-stamp" data-state={image.selected ? "keep" : "drop"}>{image.selected ? "✓ 保留" : "✗ 移除"}</span><span class="review-image-active-marker">当前检查</span></span>
                </button>
              {/each}
            </div>
            {#if !images.length}<p class="review-empty">当前组没有图片。</p>{/if}
          </section>

          <footer class="review-deck-statusbar">
            <div><span>{snapshot.snapshot.summary.decidedGroupCount} / {snapshot.snapshot.summary.totalGroupCount} 组已确认</span><span>当前组 {focusedGroup.selectedImageCount} / {focusedGroup.imageCount} 保留</span><span>{loupeEnabled ? `同步放大镜 ${formatReviewMagnification(loupeState.magnification)}${loupeState.pinned ? " · 坐标已锁定" : loupeState.active ? " · 正在检查" : ""}` : "放大镜已关闭"}</span></div>
            <div class="review-shortcut-hints"><kbd>←/→</kbd> 图片 <kbd>Space</kbd> 保留/移除 <kbd>Enter</kbd> 采纳并前进 <kbd>X</kbd> 放大镜</div>
            <button type="button" class="review-button review-button--primary" disabled={snapshot.snapshot.summary.status !== "ready" || Boolean(snapshot.busy)} onclick={() => void controller.confirmAndAdvance()}>采纳并前进</button>
          </footer>
        </section>
      {:else}
        <section class="review-panel" aria-labelledby="review-state-heading"><h2 id="review-state-heading">{snapshot.snapshot.summary.statusLabel}</h2><p>{snapshot.presentation.message}</p><dl><div><dt>图片</dt><dd>{snapshot.snapshot.summary.totalImageCount}</dd></div><div><dt>审核组</dt><dd>{snapshot.snapshot.summary.totalGroupCount}</dd></div><div><dt>重复组</dt><dd>{snapshot.snapshot.summary.duplicateGroupCount}</dd></div><div><dt>读取失败</dt><dd>{snapshot.snapshot.summary.unreadableImageCount}</dd></div></dl></section>
      {/if}
    {:else}
      <section class="review-panel review-empty" aria-labelledby="review-empty-heading"><h2 id="review-empty-heading">尚未打开审核批次</h2><p>{snapshot.presentation.message}</p><p>打开已结束批次不会自动开始分析，也不会读取或显示本机文件路径。</p></section>
    {/if}
  </section>
</section>

{#if snapshot.confirmation}
  <dialog class="review-confirmation" data-review-confirmation={snapshot.confirmation.action} aria-modal="true" aria-labelledby="review-confirmation-title" aria-describedby="review-confirmation-message review-confirmation-warning" bind:this={confirmationDialog} oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }} onkeydown={onConfirmationKeydown} onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}>
    <section><h2 id="review-confirmation-title">{snapshot.confirmation.title}</h2><p id="review-confirmation-message">{snapshot.confirmation.message}</p><p id="review-confirmation-warning" class="review-confirmation-warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p><div><button type="button" onclick={() => resolveConfirmation(false)}>取消</button><button type="button" class="review-button review-button--dangerous" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button></div></section>
  </dialog>
{/if}
