import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  buildReviewDecisionPayload,
  createReviewRequestGate,
  splitReviewDecisionPayload,
  REVIEW_DECISION_BATCH_LIMIT,
  deckAdvanceTarget,
  deckImageStepTarget,
  deckStepTarget,
  resolveDeckCommand,
  reviewCanList,
  reviewCompletionPresentation,
  reviewErrorGuidance,
  sanitizeReviewPage,
  sanitizeReviewSummary,
  shouldPollReview,
  REVIEW_POLL_INTERVAL_MS,
} from "../core/review-model.js";
import { actionCreators } from "../core/store.js";
import { TERMINAL_BATCH_STATUSES } from "../core/tasks-model.js";
import { createReviewView } from "../components/review-view.js";

export const REVIEW_ENDPOINTS = Object.freeze({
  crawls: "/api/v1/crawls",
});

const REVIEW_POLL_KEY = "review.active";

function requireBatchId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("审核批次 ID 无效");
  }
  return value;
}

function reviewPath(batchId, suffix = "") {
  return `${REVIEW_ENDPOINTS.crawls}/${encodeURIComponent(requireBatchId(batchId))}/review${suffix}`;
}

function reviewWorkspacePath(batchId, filter) {
  const kind = filter ? `&kind=${encodeURIComponent(filter)}` : "";
  return `${reviewPath(batchId)}?all=true${kind}`;
}

export function createReviewController(context, {
  createView = createReviewView,
} = {}) {
  const { root, api, store, polling, actions, dialogs } = context;
  const view = createView(context);
  if (!view || typeof view !== "object") throw new TypeError("审核视图无效");
  const requestGate = createReviewRequestGate();
  let active = false;
  let destroyed = false;
  let busy = "";
  let pageRead = null;
  let recentRead = null;
  let operationController = null;
  let operationSequence = 0;
  let leaveSave = null;

  const reviewState = () => store.getState().review;
  const deckEditable = () => reviewState().summary?.status === "ready" && !busy && Boolean(
    reviewState().groups[view.getFocusedIndex()]?.images.length,
  );
  const abortRead = (entry) => entry?.controller.abort();

  const readRecent = async ({ replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (recentRead) {
      if (!replace) return recentRead.promise;
      abortRead(recentRead);
      try { await recentRead.promise; } catch { /* 原调用方负责错误。 */ }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const ticket = requestGate.beginRead("recent");
    const promise = api.get(`${REVIEW_ENDPOINTS.crawls}?limit=30`, { signal: controller.signal })
      .then((response) => {
        if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket, {
          channel: "recent",
          batchId: "",
          filter: "",
          offset: 0,
        })) return false;
        store.dispatch(actionCreators.recentBatchesReceived(response));
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(reviewErrorGuidance(error));
        throw error;
      })
      .finally(() => {
        if (recentRead?.promise === promise) recentRead = null;
      });
    recentRead = { controller, promise };
    return promise;
  };

  const syncPolling = () => {
    polling.stop(REVIEW_POLL_KEY);
    const review = reviewState();
    if (!active || destroyed || busy || review.dirty || !review.batchId || !shouldPollReview(review.summary)) return;
    polling.start({
      key: REVIEW_POLL_KEY,
      scope: context.pollingScope,
      intervalMs: REVIEW_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      resume: "immediate",
      task(signal) {
        return readPage({
          batchId: reviewState().batchId,
          filter: reviewState().filter,
          offset: 0,
          externalSignal: signal,
          replace: false,
          report: false,
        });
      },
    });
  };

  const readPage = async ({
    batchId,
    filter = "",
    offset = 0,
    externalSignal = null,
    replace = false,
    report = true,
  }) => {
    if (!active || destroyed) return false;
    requireBatchId(batchId);
    if (pageRead) {
      if (!replace && pageRead.batchId === batchId && pageRead.filter === filter && pageRead.offset === offset) {
        return pageRead.promise;
      }
      abortRead(pageRead);
      try { await pageRead.promise; } catch { /* 原调用方负责错误。 */ }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const ticket = requestGate.beginRead("page", batchId, filter, offset);
    const promise = api.get(reviewWorkspacePath(batchId, filter), { signal: controller.signal })
      .then((response) => {
        if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket, {
          channel: "page",
          batchId: reviewState().batchId || batchId,
          filter,
          offset,
        })) return false;
        const projected = sanitizeReviewPage(response, { batchId, filter, requestedOffset: offset });
        store.dispatch(actionCreators.reviewWorkspaceReceived(projected));
        view.clearError();
        syncPolling();
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(reviewErrorGuidance(error));
        throw error;
      })
      .finally(() => {
        externalSignal?.removeEventListener("abort", abort);
        if (pageRead?.promise === promise) pageRead = null;
      });
    pageRead = { batchId, filter, offset, controller, promise };
    return promise;
  };

  const refreshSummaryOnly = async (batchId, signal) => {
    const filter = reviewState().filter;
    const ticket = requestGate.beginRead("summary", batchId, filter, 0);
    try {
      const response = await api.get(reviewWorkspacePath(batchId, filter), { signal });
      if (!signal.aborted && active && reviewState().batchId === batchId &&
          reviewState().filter === filter && requestGate.isReadCurrent(ticket, {
            channel: "summary",
            batchId,
            filter,
            offset: 0,
          })) {
        store.dispatch(actionCreators.reviewSummaryReceived(
          batchId,
          sanitizeReviewSummary(response, batchId),
        ));
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return false;
      throw error;
    }
    return true;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
    if (kind) polling.stop(REVIEW_POLL_KEY);
    else syncPolling();
  };

  const persistPendingGroups = async ({ announce = true } = {}) => {
    const review = reviewState();
    if (!review.dirty) return true;
    if (review.summary?.status !== "ready" || !review.groups.length || !review.dirtyGroupIds.length) return false;
    if (leaveSave) return leaveSave;
    let payload;
    let chunks;
    try {
      payload = buildReviewDecisionPayload(review);
      chunks = splitReviewDecisionPayload(payload);
    } catch (error) {
      view.showError(reviewErrorGuidance({ code: "invalid_review_decisions", status: 422 }));
      return false;
    }
    if (!chunks.length || chunks.some((chunk) => chunk.groups.length > REVIEW_DECISION_BATCH_LIMIT)) {
      view.showError(reviewErrorGuidance({ code: "invalid_review_decisions", status: 422 }));
      return false;
    }
    if (active) view.setOperationMessage("正在保存待提交的审核决策……");
    const writeTicket = requestGate.beginWrite();
    abortRead(pageRead);
    const controller = new AbortController();
    operationController = controller;
    const batchId = review.batchId;
    let captured = chunks;
    chunks = null;
    const savePromise = (async () => {
      try {
        for (const chunk of captured) {
          await api.put(reviewPath(batchId, "/decisions"), chunk, { signal: controller.signal });
        }
        captured = null;
        if (destroyed || controller.signal.aborted || reviewState().batchId !== batchId ||
            !requestGate.isWriteCurrent(writeTicket)) return false;
        const loaded = await readPage({
          batchId,
          filter: reviewState().filter,
          offset: 0,
          replace: true,
          report: false,
        });
        if (!loaded || destroyed || controller.signal.aborted || reviewState().batchId !== batchId ||
            !requestGate.isWriteCurrent(writeTicket)) return false;
        if (announce && active) view.setOperationMessage("审核决策已保存，并已重新读取权威快照。");
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || destroyed) return false;
        if (active) {
          try { await refreshSummaryOnly(batchId, controller.signal); } catch { /* 保留原保存错误。 */ }
          view.showError(reviewErrorGuidance(error));
          view.setOperationMessage("保存失败，完整草稿与待提交组已保留。请重试后再切换筛选、批次或离开。");
        }
        return false;
      } finally {
        captured = null;
        if (operationController === controller) operationController = null;
        leaveSave = null;
      }
    })();
    leaveSave = savePromise;
    return savePromise;
  };

  const switchReviewContext = async ({
    filter = reviewState().filter,
    focus = "first",
  } = {}) => {
    if (busy || !reviewState().batchId) return false;
    setBusy("workspace");
    try {
      if (reviewState().dirty && !await persistPendingGroups({ announce: false })) return false;
      view.releaseImages();
      const loaded = await readPage({
        batchId: reviewState().batchId,
        filter,
        offset: 0,
        replace: true,
        report: true,
      });
      if (loaded && active) {
        const nextIndex = focus === "last" ? Math.max(0, reviewState().groups.length - 1) : 0;
        view.resetWorkspaceState(nextIndex, { focus: true });
        view.setOperationMessage("当前筛选的全部审核组已加载。");
      }
      return loaded;
    } catch {
      return false;
    } finally {
      setBusy("");
    }
  };

  const loadBatch = async (batchId) => {
    requireBatchId(batchId);
    if (busy) return false;
    setBusy("load");
    try {
      if (reviewState().dirty && !await persistPendingGroups({ announce: false })) {
        return false;
      }
      requestGate.beginWrite();
      actions.setActiveBatchId(batchId);
      store.dispatch(actionCreators.reviewCleared(batchId));
      view.releaseImages();
      view.clearError();
      const loaded = await readPage({ batchId, filter: "", offset: 0, replace: true, report: true });
      if (loaded && active) {
        view.resetWorkspaceState(0, { focus: true });
        view.setOperationMessage("已加载结束批次；打开批次不会自动开始分析。");
      }
      return loaded;
    } catch {
      return false;
    } finally {
      setBusy("");
    }
  };

  const runStatusOperation = async ({ kind, suffix, successMessage }) => {
    const review = reviewState();
    if (!review.batchId || busy) return false;
    requestGate.beginWrite();
    abortRead(pageRead);
    const controller = new AbortController();
    operationController = controller;
    const operation = ++operationSequence;
    view.hideCompletion();
    setBusy(kind);
    view.clearError();
    try {
      const summary = await api.post(reviewPath(review.batchId, suffix), {}, { signal: controller.signal });
      if (!active || destroyed || controller.signal.aborted || operation !== operationSequence) return false;
      store.dispatch(actionCreators.reviewSummaryReceived(review.batchId, summary));
      await readPage({
        batchId: review.batchId,
        filter: reviewState().filter,
        offset: 0,
        replace: true,
        report: false,
      });
      if (reviewCanList(reviewState().summary)) {
        view.resetWorkspaceState(0, { focus: true });
      }
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      try { await refreshSummaryOnly(review.batchId, controller.signal); } catch { /* 保留原错误。 */ }
      view.showError(reviewErrorGuidance(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const applyReview = async () => {
    if (busy || !reviewState().batchId) return;
    if (reviewState().dirty) {
      setBusy("save");
      let saved = false;
      try {
        saved = await persistPendingGroups({ announce: false });
      } finally {
        setBusy("");
      }
      if (!saved) return;
    }
    const review = reviewState();
    if (review.summary.status === "ready" && review.summary.decidedGroupCount < review.summary.totalGroupCount) {
      view.setOperationMessage("仍有未确认分组，请确认并保存待提交组后再应用结果。");
      return;
    }
    const choice = await dialogs.open({
      title: review.summary.status === "apply_failed" ? "重试整理文件？" : "应用并整理文件？",
      message: view.applyConfirmationText(),
      confirmLabel: review.summary.status === "apply_failed" ? "重试整理" : "应用并整理文件",
      dangerous: true,
      confirmationText: "将按当前审核结果移动待移除的图片。开始前请确认每组的保留项。",
    });
    if (choice !== "confirm" || !active || destroyed) return;
    view.hideCompletion();
    await runStatusOperation({
      kind: "apply",
      suffix: "/apply",
      successMessage: "审核结果已应用，页面已重新读取最新状态。",
    });
    await readRecent({ replace: true, report: false }).catch(() => {});
  };

  const discardStaleAndReload = async () => {
    const review = reviewState();
    if (!review.dirty || !review.batchId) return false;
    const choice = await dialogs.open({
      title: "放弃未保存的更改？",
      message: "审核状态已经变化，待提交组无法继续保存。可以放弃更改并重新加载最新内容。",
      confirmLabel: "放弃更改并重新加载",
      dangerous: true,
      confirmationText: "只会清除待提交组的未保存更改，不会修改文件或已确认结果。",
    });
    if (choice !== "confirm" || !active || destroyed) return false;
    const batchId = review.batchId;
    requestGate.beginWrite();
    store.dispatch(actionCreators.reviewCleared(batchId));
    return switchReviewContext({ filter: review.filter });
  };

  const manualRefresh = async () => {
    if (busy) return;
    setBusy("refresh");
    try {
      if (reviewState().dirty && !await persistPendingGroups({ announce: false })) return;
      const [, workspaceLoaded] = await Promise.all([
        readRecent({ replace: true, report: false }),
        reviewState().batchId
          ? readPage({
              batchId: reviewState().batchId,
              filter: reviewState().filter,
              offset: 0,
              replace: true,
              report: true,
            })
          : Promise.resolve(false),
      ]);
      if (workspaceLoaded && reviewCanList(reviewState().summary)) {
        view.resetWorkspaceState(0, { focus: true });
      }
      if (active) view.setOperationMessage("已结束批次和当前审核状态已刷新。");
    } catch {
      // 读取函数已显示安全错误。
    } finally {
      setBusy("");
    }
  };

  const focusedGroup = () => reviewState().groups[view.getFocusedIndex()] || null;

  const deckPosition = () => ({
    focusedIndex: view.getFocusedIndex(),
    groupCount: reviewState().groups.length,
  });

  const announceFocusedGroup = (prefix = "已切换") => {
    const group = focusedGroup();
    if (group) view.setOperationMessage(`${prefix}组 ${group.ordinal}。`);
  };

  const toggleImage = (groupId, imageId, { focus = false } = {}) => {
    if (!deckEditable()) return false;
    const group = focusedGroup();
    if (!group || group.id !== groupId) return false;
    const image = group.images.find((candidate) => candidate.id === imageId);
    if (!image) return false;
    view.hideCompletion();
    view.setActiveImage(image.id, { focus });
    store.dispatch(actionCreators.reviewImageSelectionChanged(group.id, image.id, !image.selected));
    view.setOperationMessage(`组 ${group.ordinal}：图 ${image.ordinal} ${image.selected ? "移除" : "保留"}。`);
    return true;
  };

  const moveActiveImage = (direction) => {
    const group = focusedGroup();
    if (busy || !reviewCanList(reviewState().summary) || !group?.images.length) return false;
    const currentIndex = Math.max(
      0,
      group.images.findIndex((image) => image.id === view.getActiveImageId()),
    );
    const target = deckImageStepTarget(direction, {
      activeIndex: currentIndex,
      imageCount: group.images.length,
    });
    const nextImage = target.type === "image" ? group.images[target.index] : null;
    if (!nextImage || !view.setActiveImage(nextImage.id, { focus: true })) return false;
    view.setOperationMessage(`组 ${group.ordinal}：已聚焦图 ${nextImage.ordinal}。`);
    return true;
  };

  const toggleActiveImage = () => {
    const group = focusedGroup();
    const imageId = view.getActiveImageId();
    return Boolean(group && imageId && toggleImage(group.id, imageId, { focus: true }));
  };

  const toggleLoupe = () => {
    const enabled = view.toggleLoupe();
    if (enabled === null) return false;
    view.setOperationMessage(enabled
      ? "放大镜已启动；在图片内移动鼠标即可同步检查。"
      : "放大镜已关闭；倍率会保留到下次启动。");
    return true;
  };

  const navigateGroup = async (direction) => {
    if (busy || !reviewCanList(reviewState().summary) || !reviewState().groups.length) return false;
    const target = deckStepTarget(direction, deckPosition());
    if (target.type === "group") {
      view.setFocusedIndex(target.index);
      announceFocusedGroup();
      return true;
    }
    view.setOperationMessage(direction < 0 ? "已经是当前筛选第一组。" : "已经是当前筛选最后一组。");
    return false;
  };

  const acceptAndAdvance = async () => {
    if (!deckEditable()) return false;
    const review = reviewState();
    const group = focusedGroup();
    if (!group) return false;
    view.hideCompletion();
    store.dispatch(actionCreators.reviewGroupConfirmed(group.id));
    view.markConfirmed(group.id);
    const target = deckAdvanceTarget({
      focusedIndex: view.getFocusedIndex(),
      groupCount: review.groups.length,
    });
    if (target.type === "group") {
      view.setFocusedIndex(target.index);
      const next = focusedGroup();
      view.setOperationMessage(`已采纳组 ${group.ordinal}，前进到组 ${next?.ordinal || target.index + 1}。`);
      return true;
    }
    setBusy("save");
    let saved = false;
    try {
      saved = await persistPendingGroups({ announce: false });
    } finally {
      setBusy("");
    }
    if (!saved || !active || destroyed) return false;
    const completion = reviewCompletionPresentation(
      reviewState().summary,
      reviewState().filter,
    );
    view.showCompletion();
    view.setOperationMessage(completion.operationMessage);
    return true;
  };

  const executeDeckCommand = async (command) => {
    if (!command || busy || !reviewCanList(reviewState().summary)) return false;
    if (command === "previous-group") return navigateGroup(-1);
    if (command === "focus-previous-image") return moveActiveImage(-1);
    if (command === "focus-next-image") return moveActiveImage(1);
    if (command === "toggle-active-image") return toggleActiveImage();
    if (command === "accept-advance") return acceptAndAdvance();
    if (command === "browse-next-group") return navigateGroup(1);
    if (command === "toggle-loupe") return toggleLoupe();
    return false;
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const actionButton = event.target.closest("[data-review-action]");
    if (actionButton instanceof HTMLButtonElement) {
      if (actionButton.disabled) return;
      const action = actionButton.dataset.reviewAction;
      if (action === "load-batch") {
        const id = view.selectedBatchId();
        if (id) await loadBatch(id);
        else view.setOperationMessage("请选择一个已结束批次。");
      } else if (action === "refresh") await manualRefresh();
      else if (action === "open-tasks") actions.navigateToApp("tasks");
      else if (action === "start") await runStatusOperation({
        kind: "start", suffix: "/start", successMessage: "去重分析已开始，状态将自动刷新。",
      });
      else if (action === "retry") await runStatusOperation({
        kind: "retry", suffix: "/retry", successMessage: "去重分析已重新排队。",
      });
      else if (action === "filter") {
        await switchReviewContext({ filter: actionButton.dataset.reviewFilter || "", focus: "first" });
      } else if (action === "apply") await applyReview();
      else if (action === "discard-reload") await discardStaleAndReload();
      else if (action === "prev-group") await navigateGroup(-1);
      else if (action === "next-group") await navigateGroup(1);
      else if (action === "loupe-toggle") toggleLoupe();
      else if (action === "loupe-pin") {
        const state = view.toggleLoupePin();
        if (state) view.setOperationMessage(state === "pinned"
          ? "同步坐标已锁定。"
          : "同步坐标已解除锁定。");
      } else if (action === "return-review") {
        view.hideCompletion();
        view.setFocusedIndex(Math.max(0, reviewState().groups.length - 1));
        announceFocusedGroup("已返回复查：");
      }
      return;
    }

    const card = event.target.closest("[data-review-image]");
    if (!card || !root.contains(card)) return;
    const imageId = card.dataset.reviewImage || "";
    toggleImage(
      card.dataset.reviewImageGroup || "",
      imageId,
      { focus: true },
    );
  };

  const onChange = (event) => {
    if (!(event.target instanceof HTMLSelectElement) || !event.target.matches("[data-review-group-select]")) return;
    const index = Number(event.target.value);
    if (Number.isInteger(index) && view.setFocusedIndex(index)) announceFocusedGroup("已选择");
  };

  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || busy) return;
    const review = reviewState();
    if (!reviewCanList(review.summary)) return;
    if (event.target instanceof Element &&
        event.target.closest("input, select, textarea, button, a[href], [contenteditable]")) return;
    const command = resolveDeckCommand(event.key, {
      editable: deckEditable(),
      readOnly: review.summary.status !== "ready",
      hasImages: Boolean(focusedGroup()?.images.length),
      loupeAvailable: view.isLoupeAvailable(),
    });
    if (!command) return;
    event.preventDefault();
    void executeDeckCommand(command);
  };

  const onBeforeUnload = (event) => {
    if (!reviewState().dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", onKeyDown);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);

  const onReviewStateChanged = (review) => {
    if (!active || destroyed) return;
    if (review.dirty) polling.stop(REVIEW_POLL_KEY);
    else syncPolling();
  };
  const unsubscribeReview = store.subscribe((state) => state.review, onReviewStateChanged);

  const saveBeforeVisibilityChange = async (message) => {
    if (!reviewState().dirty) return true;
    if (busy && !leaveSave) return false;
    view.setOperationMessage(message);
    return Boolean(await persistPendingGroups({ announce: false }));
  };

  return Object.freeze({
    beforeLeave() {
      return saveBeforeVisibilityChange("正在保存待提交组，完成前不会切换页面……");
    },
    beforeWindowHide(visibility) {
      const purpose = visibility === "closed" ? "关闭窗口" : "最小化窗口";
      return saveBeforeVisibilityChange(`正在保存待提交组，完成前不会${purpose}……`);
    },
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.activate();
      void readRecent({ replace: true, report: false }).catch(() => {});
      const current = reviewState();
      if (current.dirty) {
        if (reviewCanList(current.summary)) view.setFocusedIndex(view.getFocusedIndex());
        view.setOperationMessage("存在未保存的待提交组，已恢复本地草稿。");
        return;
      }
      if (current.batchId) {
        void readPage({
          batchId: current.batchId,
          filter: current.filter,
          offset: 0,
          replace: true,
          report: true,
        }).then((loaded) => {
          if (loaded && active && reviewCanList(reviewState().summary)) {
            view.resetWorkspaceState(0, { focus: true });
          }
        }).catch(() => {});
        return;
      }
      const activeBatch = store.getState().batches.active;
      if (activeBatch && TERMINAL_BATCH_STATUSES.has(activeBatch.status)) {
        queueMicrotask(() => {
          if (active && !destroyed && !reviewState().batchId) void loadBatch(activeBatch.id);
        });
      } else {
        view.setOperationMessage("选择一个已结束批次；打开批次不会自动开始分析。");
      }
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      operationController?.abort();
      operationController = null;
      polling.stop(REVIEW_POLL_KEY);
      abortRead(pageRead);
      abortRead(recentRead);
      busy = "";
      view.setBusy("");
      view.deactivate();
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      operationController?.abort();
      polling.stop(REVIEW_POLL_KEY);
      abortRead(pageRead);
      abortRead(recentRead);
      view.deactivate();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("keydown", onKeyDown);
      globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
      unsubscribeReview();
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("去重审核已挂载");
    controller = createReviewController(context);
  },
  activate() {
    controller?.activate();
  },
  beforeLeave() {
    return controller?.beforeLeave() ?? true;
  },
  beforeWindowHide(_context, visibility) {
    return controller?.beforeWindowHide(visibility) ?? true;
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
