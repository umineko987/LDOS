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
  validateReviewId,
  type ReviewFilter,
} from "./model";
import type { ReviewService, ReviewStatusOperation } from "./service";
import { focusedReviewGroup, type ReviewStore } from "./state";

export const REVIEW_POLL_KEY = "review.active";
export const REVIEW_SCOPE = "app:review";

const APPLY_CONFIRMATION = Object.freeze({
  action: "apply" as const,
  title: "将剔除图片送入回收区？",
  message: "保留图片原地不动，人工剔除的图片及配对 TXT 将进入图库回收区。",
  confirmLabel: "确认送入回收区",
  warning: "不会永久删除；永久删除仅能在图库回收区主动操作。请先确认所有组并保存决策。",
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
  deactivate(): void;
  openReview(reviewId: string): Promise<boolean>;
  selectReview(reviewId: string): boolean;
  loadSelected(): Promise<boolean>;
  listTasks(offset: number): Promise<boolean>;
  saveAndSwitch(): Promise<boolean>;
  requestDiscardSwitch(): boolean;
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
      task: (signal) => service.readPage(snapshot.reviewId, snapshot.filter, signal),
      onResult: (next) => {
        const current = store.getState();
        if (!active || destroyed || version !== pollVersion || current.busy || current.snapshot?.dirty || current.snapshot?.reviewId !== next.reviewId || current.snapshot.filter !== next.filter) return;
        store.commitSnapshot(next, "审核状态已自动刷新。");
        syncPolling();
      },
      onError: (error) => {
        if (!active || destroyed || version !== pollVersion) return;
        store.fail(reviewErrorPresentation(error), "自动刷新失败；最后一次安全快照已保留。");
      },
    });
  };

  const readRecent = async ({ offset = store.getState().recentOffset }: { readonly offset?: number } = {}): Promise<boolean> => {
    if (!active || destroyed) return false;
    recentController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginRead("recent", "", "", 0);
    recentController = controller;
    try {
      const recent = await service.readRecent(controller.signal, offset);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket)) return false;
      store.commitRecent(recent);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isReadCurrent(ticket)) return false;
      store.fail(reviewErrorPresentation(error), "审核任务列表读取失败；当前草稿未改变。请刷新重试。");
      return false;
    } finally {
      if (recentController === controller) recentController = null;
    }
  };

  const readPage = async (
    reviewId: string,
    filter: ReviewFilter,
    message = "当前筛选的全部审核组已加载。",
  ): Promise<boolean> => {
    pageController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginRead("page", reviewId, filter, 0);
    pageController = controller;
    try {
      const snapshot = await service.readPage(reviewId, filter, controller.signal);
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
        let version = snapshot.version;
        for (const chunk of chunks) {
          const result = await service.writeDecisions(snapshot.reviewId, { ...chunk, version }, controller.signal);
          if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
          if (result.reviewId !== snapshot.reviewId || result.version <= version) throw Object.assign(new Error("review_state_conflict"), { code: "review_state_conflict", status: 409 });
          version = result.version;
          store.updateDraftVersion(version);
        }
        const authority = await service.readPage(snapshot.reviewId, snapshot.filter, controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        store.commitSnapshot(authority, "审核决策已保存。");
        syncPolling();
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isWriteCurrent(ticket)) return false;
        store.fail(reviewErrorPresentation(error), "保存失败，完整草稿与待提交组已保留。请重试后再切换筛选、任务或离开。");
        return false;
      } finally {
        if (operationController === controller) operationController = null;
        if (savePromise === promise) savePromise = null;
      }
    })();
    savePromise = promise;
    return promise;
  };

  const openReview = async (value: string): Promise<boolean> => {
    const reviewId = validateReviewId(value);
    const state = store.getState();
    if (!active || destroyed) return false;
    if (state.snapshot?.reviewId === reviewId && !state.pendingReviewId) return true;
    if (state.busy || state.snapshot?.dirty) {
      store.queueReview(reviewId);
      return false;
    }
    store.selectReview(reviewId);
    if (!store.begin("load", "正在加载审核任务……")) return false;
    stopPolling();
    const loaded = await readPage(reviewId, "", "审核任务已打开；保留图片原位，剔除图片进入回收区。");
    if (loaded) persistence.writeActiveReviewId(reviewId);
    return loaded;
  };

  const loadSelected = (): Promise<boolean> => {
    const reviewId = store.getState().selectedReviewId;
    return reviewId ? openReview(reviewId) : Promise.resolve(false);
  };

  const setFilter = async (filter: ReviewFilter): Promise<boolean> => {
    if (!REVIEW_FILTERS.some((item) => item.id === filter)) return false;
    const current = store.getState().snapshot;
    if (!active || destroyed || store.getState().busy || !current || current.filter === filter) return false;
    if (current.dirty && !await save()) return false;
    const authority = store.getState().snapshot;
    if (!authority || !store.begin("load", "正在切换审核筛选……")) return false;
    stopPolling();
    return readPage(authority.reviewId, filter);
  };

  const runStatus = async (operation: ReviewStatusOperation): Promise<boolean> => {
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!active || destroyed || state.busy || !snapshot) return false;
    if (snapshot.dirty && !await save()) return false;
    const current = store.getState().snapshot;
    if (!current || (operation === "retry" && !["failed", "blocked"].includes(current.summary.status)) || !store.begin(operation, `正在${operation === "retry" ? "重新排队" : "应用审核结果"}……`)) return false;
    stopPolling();
    pageController?.abort();
    operationController?.abort();
    const controller = new AbortController();
    const ticket = requestGate.beginWrite();
    operationController = controller;
    try {
      await service.run(operation, current.reviewId, current.version, controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
      const authority = await service.readPage(current.reviewId, current.filter, controller.signal);
      if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
      store.commitSnapshot(authority, operation === "apply"
        ? authority.summary.status === "applied" ? "审核结果已应用；剔除图片已进入图库回收区。" : "部分图片未能进入回收区；请检查审核状态后重试。"
        : "去重分析已重新排队。");
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
    const { reviewId, filter } = snapshot;
    stopPolling();
    store.clearDraft();
    queueMicrotask(() => {
      if (active && !destroyed) void readPage(reviewId, filter, "未保存的待提交组已放弃，权威审核状态已重新读取。");
    });
  };

  const controller: ReviewController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      void readRecent().then((loaded) => {
        const state = store.getState();
        if (!loaded || !active || destroyed || state.snapshot || state.busy || state.selectedReviewId) return;
        const reviewId = persistence.readActiveReviewId() ?? state.recent.find((task) => task.summary.status !== "applied")?.reviewId;
        if (reviewId) void openReview(reviewId);
      });
      const snapshot = store.getState().snapshot;
      if (snapshot?.dirty) {
        store.finish("存在未保存的待提交组，已恢复本地草稿。");
      } else if (snapshot) {
        void readPage(snapshot.reviewId, snapshot.filter);
      }
      else if (store.getState().selectedReviewId) void loadSelected();
    },
    deactivate() {
      if (!active || destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      stopPolling();
      recentController?.abort();
      pageController?.abort();
      operationController?.abort();
      savePromise = null;
      store.finish(store.getState().snapshot?.dirty ? "未保存的审核草稿已保留。" : "审核任务已保留。");
    },
    openReview,
    listTasks: (offset) => readRecent({ offset }),
    async saveAndSwitch() {
      const reviewId = store.getState().pendingReviewId;
      if (!reviewId || !await save()) return false;
      return openReview(reviewId);
    },
    requestDiscardSwitch() {
      return Boolean(store.getState().pendingReviewId && store.requestConfirmation({ ...DISCARD_CONFIRMATION, action: "discard-switch", message: "放弃当前未保存决策并打开另一个审核任务；已保存结果不受影响。", confirmLabel: "放弃草稿并切换" }));
    },
    selectReview: (reviewId) => store.selectReview(reviewId),
    loadSelected,
    async refresh() {
      const state = store.getState();
      if (!active || destroyed || state.busy) return false;
      if (state.snapshot?.dirty && !await save()) return false;
      const current = store.getState().snapshot;
      if (!store.begin("refresh", "正在刷新审核任务……")) return false;
      stopPolling();
      const recentLoaded = await readRecent();
      if (!recentLoaded) return false;
      if (current) {
        return readPage(current.reviewId, current.filter, "审核状态已刷新。");
      }
      store.finish("审核任务列表已刷新。");
      return true;
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
      return store.requestConfirmation({ ...APPLY_CONFIRMATION, title: snapshot.summary.status === "apply_failed" ? "重试送入回收区？" : APPLY_CONFIRMATION.title, confirmLabel: snapshot.summary.status === "apply_failed" ? "重试回收" : APPLY_CONFIRMATION.confirmLabel });
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
      if (confirmation.action === "discard-switch") {
        const reviewId = store.getState().pendingReviewId;
        if (!reviewId) return false;
        store.clearDraft();
        return openReview(reviewId);
      }
      const snapshot = store.getState().snapshot;
      if (!snapshot) return false;
      const { reviewId, filter } = snapshot;
      store.clearDraft();
      return readPage(reviewId, filter, "未保存更改已放弃，最新审核状态已加载。");
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
