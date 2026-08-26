import type { PersistenceService } from "../../core/persistence/service";
import type { PollingHandle, PollingService } from "../../core/polling/service";
import {
  REVIEW_FILTERS,
  REVIEW_POLL_INTERVAL_MS,
  buildReviewDecisionPayload,
  createReviewRequestGate,
  reviewCanList,
  reviewCompletionPresentation,
  reviewErrorPresentation,
  reviewStepIndex,
  shouldPollReview,
  splitReviewDecisionPayload,
  type ReviewFilter,
} from "./model";
import type { ReviewService, ReviewStatusOperation } from "./service";
import { focusedReviewGroup, type ReviewStore } from "./state";

export const REVIEW_POLL_KEY = "review.active";
export const REVIEW_SCOPE = "app:review";

const APPLY_CONFIRMATION = Object.freeze({
  action: "apply" as const,
  title: "应用并整理文件？",
  message: "将按当前审核结果移动待移除的图片。开始前请确认每组的保留项。",
  confirmLabel: "应用并整理文件",
  warning: "该操作会移动文件；请先确认所有审核组并保存待提交决策。",
});
const DISCARD_CONFIRMATION = Object.freeze({
  action: "discard-reload" as const,
  title: "放弃未保存的更改？",
  message: "审核状态已经变化，待提交组无法继续保存。可以放弃更改并重新加载最新内容。",
  confirmLabel: "放弃更改并重新加载",
  warning: "只会清除待提交组的未保存更改，不会修改文件或已确认结果。",
});

export interface ReviewController {
  activate(): void;
  selectBatch(batchId: string): boolean;
  loadSelected(): Promise<boolean>;
  refresh(): Promise<boolean>;
  setFilter(filter: ReviewFilter): Promise<boolean>;
  setFocusedGroup(groupId: string): boolean;
  setActiveImage(imageId: string): boolean;
  toggleImage(groupId: string, imageId: string): boolean;
  moveGroup(direction: -1 | 1): boolean;
  moveImage(direction: -1 | 1): boolean;
  confirmAndAdvance(): Promise<boolean>;
  save(): Promise<boolean>;
  run(operation: Exclude<ReviewStatusOperation, "apply">): Promise<boolean>;
  requestApply(): boolean;
  requestDiscardReload(): boolean;
  confirmAction(confirmed: boolean): Promise<boolean>;
  beforeLeave(): Promise<boolean>;
  beforeWindowHide(visibility: "minimized" | "closed"): Promise<boolean>;
  discardDraft(): void;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createReviewController({
  store,
  service,
  polling,
  persistence,
}: {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly polling: PollingService;
  readonly persistence: PersistenceService;
}): ReviewController {
  let active = false;
  let destroyed = false;
  const requestGate = createReviewRequestGate();
  let pollVersion = 0;
  let recentController: AbortController | null = null;
  let pageController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let pollHandle: PollingHandle | null = null;
  let savePromise: Promise<boolean> | null = null;

  const stopPolling = (): void => {
    pollVersion += 1;
    pollHandle?.stop();
    pollHandle = null;
  };

  const syncPolling = (): void => {
    stopPolling();
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!active || destroyed || state.busy || snapshot?.dirty || !snapshot || !shouldPollReview(snapshot.summary)) return;
    const version = pollVersion;
    pollHandle = polling.start({
      key: REVIEW_POLL_KEY,
      scope: REVIEW_SCOPE,
      intervalMs: REVIEW_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      task: (signal) => service.readPage(snapshot.batchId, snapshot.filter, signal),
      onResult: (next) => {
        const current = store.getState();
        if (!active || destroyed || version !== pollVersion || current.busy || current.snapshot?.dirty || current.snapshot?.batchId !== next.batchId || current.snapshot.filter !== next.filter) return;
        store.commitSnapshot(next, "审核状态已自动刷新。");
        syncPolling();
      },
      onError: (error) => {
        if (!active || destroyed || version !== pollVersion) return;
        store.fail(reviewErrorPresentation(error), "自动刷新失败；最后一次安全快照已保留。");
      },
    });
  };

  const readRecent = async ({ report = false }: { readonly report?: boolean } = {}): Promise<boolean> => {
    recentController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginRead("recent", "", "", 0);
    recentController = controller;
    try {
      const recent = await service.readRecent(controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket)) return false;
      store.commitRecent(recent);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isReadCurrent(ticket)) return false;
      if (report) store.fail(reviewErrorPresentation(error), "已结束批次读取失败；当前审核草稿未改变。");
      return false;
    } finally {
      if (recentController === controller) recentController = null;
    }
  };

  const readPage = async (
    batchId: string,
    filter: ReviewFilter,
    message = "当前筛选的全部审核组已加载。",
  ): Promise<boolean> => {
    pageController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginRead("page", batchId, filter, 0);
    pageController = controller;
    try {
      const snapshot = await service.readPage(batchId, filter, controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket)) return false;
      store.commitSnapshot(snapshot, message);
      syncPolling();
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isReadCurrent(ticket)) return false;
      store.fail(reviewErrorPresentation(error));
      return false;
    } finally {
      if (pageController === controller) pageController = null;
    }
  };

  const save = (): Promise<boolean> => {
    if (!active || destroyed) return Promise.resolve(false);
    if (savePromise) return savePromise;
    const snapshot = store.getState().snapshot;
    if (!snapshot?.dirty) return Promise.resolve(true);
    if (store.getState().busy || snapshot.summary.status !== "ready") return Promise.resolve(false);
    let chunks;
    try {
      chunks = splitReviewDecisionPayload(buildReviewDecisionPayload(snapshot));
    } catch (error) {
      store.fail(reviewErrorPresentation(Object.assign(new Error("invalid_review_decisions"), { code: "invalid_review_decisions", status: 422 })));
      return Promise.resolve(false);
    }
    if (!store.begin("save", "正在串行保存待提交组……")) return Promise.resolve(false);
    stopPolling();
    pageController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginWrite();
    operationController = controller;
    let promise!: Promise<boolean>;
    promise = (async () => {
      try {
        for (const chunk of chunks) await service.writeDecisions(snapshot.batchId, chunk, controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        const authority = await service.readPage(snapshot.batchId, snapshot.filter, controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        store.commitSnapshot(authority, "审核决策已保存，并已重新读取权威快照。");
        syncPolling();
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isWriteCurrent(ticket)) return false;
        store.fail(reviewErrorPresentation(error), "保存失败，完整草稿与待提交组已保留。请重试后再切换筛选、批次或离开。");
        return false;
      } finally {
        if (operationController === controller) operationController = null;
        if (savePromise === promise) savePromise = null;
      }
    })();
    savePromise = promise;
    return promise;
  };

  const loadSelected = async (): Promise<boolean> => {
    const state = store.getState();
    if (!active || destroyed || state.busy || !state.selectedBatchId) return false;
    if (state.snapshot?.dirty && !await save()) return false;
    const batchId = store.getState().selectedBatchId;
    if (!store.begin("load", "正在加载所选批次的审核工作区……")) return false;
    stopPolling();
    persistence.writeActiveBatchId(batchId);
    return readPage(batchId, "", "已加载结束批次；打开批次不会自动开始分析。");
  };

  const setFilter = async (filter: ReviewFilter): Promise<boolean> => {
    if (!REVIEW_FILTERS.some((item) => item.id === filter)) return false;
    const current = store.getState().snapshot;
    if (!active || destroyed || store.getState().busy || !current || current.filter === filter) return false;
    if (current.dirty && !await save()) return false;
    const authority = store.getState().snapshot;
    if (!authority || !store.begin("load", "正在切换审核筛选……")) return false;
    stopPolling();
    return readPage(authority.batchId, filter);
  };

  const runStatus = async (operation: ReviewStatusOperation): Promise<boolean> => {
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!active || destroyed || state.busy || !snapshot) return false;
    if (snapshot.dirty && !await save()) return false;
    const current = store.getState().snapshot;
    if (!current || !store.begin(operation, `正在${operation === "start" ? "启动分析" : operation === "retry" ? "重新排队" : "应用审核结果"}……`)) return false;
    stopPolling();
    pageController?.abort();
    operationController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginWrite();
    operationController = controller;
    try {
      await service.run(operation, current.batchId, controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
      const authority = await service.readPage(current.batchId, current.filter, controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
      store.commitSnapshot(authority, operation === "apply" ? "审核结果已应用，页面已读取最新状态。" : operation === "retry" ? "去重分析已重新排队。" : "去重分析已开始，状态将自动刷新。");
      void readRecent();
      syncPolling();
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isWriteCurrent(ticket)) return false;
      store.fail(reviewErrorPresentation(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  const discardDraft = (): void => {
    const snapshot = store.getState().snapshot;
    if (!snapshot?.dirty) return;
    const { batchId, filter } = snapshot;
    stopPolling();
    store.clearDraft();
    queueMicrotask(() => {
      if (active && !destroyed) void readPage(batchId, filter, "未保存的待提交组已放弃，权威审核状态已重新读取。");
    });
  };

  const controller: ReviewController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      void readRecent().then((loaded) => {
        if (!loaded || !active || destroyed || store.getState().snapshot) return;
        const activeBatchId = persistence.readActiveBatchId();
        if (activeBatchId && store.getState().recent.some((batch) => batch.id === activeBatchId && batch.terminal)) {
          store.selectBatch(activeBatchId);
          void loadSelected();
        }
      });
      const snapshot = store.getState().snapshot;
      if (snapshot?.dirty) {
        store.finish("存在未保存的待提交组，已恢复本地草稿。");
      } else if (snapshot) {
        void readPage(snapshot.batchId, snapshot.filter);
      }
    },
    selectBatch: (batchId) => store.selectBatch(batchId),
    loadSelected,
    async refresh() {
      const state = store.getState();
      if (!active || destroyed || state.busy) return false;
      if (state.snapshot?.dirty && !await save()) return false;
      const current = store.getState().snapshot;
      if (!store.begin("refresh", "正在刷新已结束批次与当前审核状态……")) return false;
      const recent = readRecent({ report: !current });
      const page = current ? readPage(current.batchId, current.filter, "审核状态已刷新。") : Promise.resolve(true);
      const [, pageLoaded] = await Promise.all([recent, page]);
      if (!current && active && !destroyed) store.finish("已结束批次已刷新；请选择一个批次。");
      return pageLoaded;
    },
    setFilter,
    setFocusedGroup: (groupId) => store.setFocusedGroup(groupId),
    setActiveImage: (imageId) => store.setActiveImage(imageId),
    toggleImage(groupId, imageId) {
      const changed = store.toggleImage(groupId, imageId);
      if (changed) stopPolling();
      return changed;
    },
    moveGroup(direction) {
      const state = store.getState();
      const snapshot = state.snapshot;
      if (!snapshot || state.busy || !reviewCanList(snapshot.summary)) return false;
      const index = snapshot.groupOrder.indexOf(state.focusedGroupId);
      const next = reviewStepIndex(index, snapshot.groupOrder.length, direction);
      return next === null ? false : store.setFocusedGroup(snapshot.groupOrder[next]);
    },
    moveImage(direction) {
      const state = store.getState();
      const group = focusedReviewGroup(state);
      if (!group || state.busy || !group.imageOrder.length) return false;
      const index = Math.max(0, group.imageOrder.indexOf(state.activeImageId));
      const next = reviewStepIndex(index, group.imageOrder.length, direction);
      return next === null ? false : store.setActiveImage(group.imageOrder[next]);
    },
    async confirmAndAdvance() {
      const state = store.getState();
      const snapshot = state.snapshot;
      const group = focusedReviewGroup(state);
      if (!snapshot || !group || (!group.decided && !store.confirmGroup(group.id))) return false;
      stopPolling();
      const index = snapshot.groupOrder.indexOf(group.id);
      const next = reviewStepIndex(index, snapshot.groupOrder.length, 1);
      if (next !== null) return store.setFocusedGroup(snapshot.groupOrder[next]);
      const saved = await save();
      if (saved) {
        const current = store.getState().snapshot;
        if (current) {
          const completion = reviewCompletionPresentation(current.summary, current.filter);
          store.finish(`${completion.title}：${completion.message}`);
        }
      }
      return saved;
    },
    save,
    run: (operation) => runStatus(operation),
    requestApply() {
      const snapshot = store.getState().snapshot;
      if (!snapshot || snapshot.dirty || snapshot.summary.decidedGroupCount < snapshot.summary.totalGroupCount || !["ready", "apply_failed"].includes(snapshot.summary.status)) return false;
      return store.requestConfirmation({ ...APPLY_CONFIRMATION, title: snapshot.summary.status === "apply_failed" ? "重试整理文件？" : APPLY_CONFIRMATION.title, confirmLabel: snapshot.summary.status === "apply_failed" ? "重试整理" : APPLY_CONFIRMATION.confirmLabel });
    },
    requestDiscardReload() {
      return Boolean(store.getState().snapshot?.dirty && store.getState().error?.conflict && store.requestConfirmation(DISCARD_CONFIRMATION));
    },
    async confirmAction(confirmed) {
      const confirmation = store.getState().confirmation;
      if (!confirmation) return false;
      if (!confirmed) return store.dismissConfirmation();
      store.dismissConfirmation("已确认操作。");
      if (confirmation.action === "apply") return runStatus("apply");
      const snapshot = store.getState().snapshot;
      if (!snapshot) return false;
      const { batchId, filter } = snapshot;
      store.clearDraft();
      return readPage(batchId, filter, "未保存更改已放弃，最新审核状态已加载。");
    },
    beforeLeave: save,
    beforeWindowHide: (_visibility) => save(),
    discardDraft,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      requestGate.advanceLifecycle();
      stopPolling();
      polling.stopScope(REVIEW_SCOPE);
      recentController?.abort();
      pageController?.abort();
      operationController?.abort();
      recentController = null;
      pageController = null;
      operationController = null;
      savePromise = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
