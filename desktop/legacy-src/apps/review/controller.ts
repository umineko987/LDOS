import type { PollingHandle, PollingService } from "../../core/polling/service";
import {
  REVIEW_FILTERS,
  REVIEW_POLL_INTERVAL_MS,
  createReviewRequestGate,
  reviewCanList,
  reviewErrorPresentation,
  reviewStepIndex,
  shouldPollReview,
  validateReviewId,
  type ReviewFilter,
} from "./model";
import type { ReviewService, ReviewStatusOperation } from "./service";
import { focusedReviewGroup, type ReviewStore } from "./state";

export const REVIEW_POLL_KEY = "review.active";
export const REVIEW_SCOPE = "app:review";

const DISCARD_LOCAL_CONFIRMATION = Object.freeze({
  action: "discard-local" as const,
  title: "放弃未采纳的更改？",
  message: "当前组有未采纳的标记更改；继续操作将丢弃这些标记。",
  confirmLabel: "放弃更改并继续",
  warning: "只会丢弃未采纳的标记，已采纳的结果不受影响。",
});

type PendingIntent = Readonly<{ kind: "filter"; filter: ReviewFilter } | { kind: "refresh" }> | null;

export interface ReviewController {
  activate(): void;
  deactivate(): void;
  openReview(reviewId: string): Promise<boolean>;
  selectReview(reviewId: string): boolean;
  loadSelected(): Promise<boolean>;
  refresh(): Promise<boolean>;
  setFilter(filter: ReviewFilter): Promise<boolean>;
  setFocusedGroup(groupId: string): boolean;
  setActiveImage(imageId: string): boolean;
  toggleImage(groupId: string, imageId: string): boolean;
  moveGroup(direction: -1 | 1): boolean;
  moveImage(direction: -1 | 1): boolean;
  adoptFocused(): Promise<boolean>;
  finish(): Promise<boolean>;
  switchToPending(): Promise<boolean>;
  stayOnTask(): boolean;
  run(operation: ReviewStatusOperation): Promise<boolean>;
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
}: {
  readonly store: ReviewStore;
  readonly service: ReviewService;
  readonly polling: PollingService;
}): ReviewController {
  let active = false;
  let destroyed = false;
  const requestGate = createReviewRequestGate();
  let pollVersion = 0;
  let pageController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let pollHandle: PollingHandle | null = null;
  let pendingIntent: PendingIntent = null;

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

  const openReview = async (value: string): Promise<boolean> => {
    const reviewId = validateReviewId(value);
    const state = store.getState();
    if (!active || destroyed) return false;
    if (state.snapshot?.reviewId === reviewId && !state.pendingReviewId) return true;
    if (state.busy) {
      store.queueReview(reviewId);
      return false;
    }
    if (state.snapshot) {
      // 旧任务尚未完成：按一次性任务语义，横幅确认后结束旧任务再切换。
      store.queueReview(reviewId);
      return false;
    }
    store.selectReview(reviewId);
    if (!store.begin("load", "正在加载审核任务……")) return false;
    stopPolling();
    return readPage(reviewId, "", "审核任务已打开；逐组采纳后点击“完成”结束。");
  };

  const loadSelected = (): Promise<boolean> => {
    const reviewId = store.getState().selectedReviewId;
    return reviewId ? openReview(reviewId) : Promise.resolve(false);
  };

  const setFilter = async (filter: ReviewFilter): Promise<boolean> => {
    if (!REVIEW_FILTERS.some((item) => item.id === filter)) return false;
    const current = store.getState().snapshot;
    if (!active || destroyed || store.getState().busy || !current || current.filter === filter) return false;
    if (current.dirty) {
      pendingIntent = { kind: "filter", filter };
      return store.requestConfirmation(DISCARD_LOCAL_CONFIRMATION);
    }
    if (!store.begin("load", "正在切换审核筛选……")) return false;
    stopPolling();
    return readPage(current.reviewId, filter);
  };

  const runStatus = async (operation: ReviewStatusOperation): Promise<boolean> => {
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!active || destroyed || state.busy || !snapshot) return false;
    if (snapshot.dirty) {
      store.fail(reviewErrorPresentation(Object.assign(new Error("review_dirty"), { code: "review_dirty", status: 409 })), "存在未采纳的更改；请先采纳当前组。");
      return false;
    }
    const current = store.getState().snapshot;
    if (!current || (operation === "retry" && !["failed", "blocked"].includes(current.summary.status)) || !store.begin(operation, "正在重新排队分析……")) return false;
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
      store.commitSnapshot(authority, "去重分析已重新排队。");
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
      if (active && !destroyed) void readPage(reviewId, filter, "未采纳的更改已放弃，最新审核状态已重新读取。");
    });
  };

  const controller: ReviewController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      const state0 = store.getState();
      if (!state0.snapshot && !state0.busy && state0.selectedReviewId) void loadSelected();
      const snapshot = store.getState().snapshot;
      if (snapshot?.dirty) {
        store.finish("存在未采纳的更改，已恢复本地标记。");
      } else if (snapshot) {
        void readPage(snapshot.reviewId, snapshot.filter);
      }
    },
    deactivate() {
      if (!active || destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      stopPolling();
      pageController?.abort();
      operationController?.abort();
      store.finish(store.getState().snapshot?.dirty ? "未采纳的更改已保留。" : "审核任务已保留。");
    },
    openReview,
    selectReview: (reviewId) => store.selectReview(reviewId),
    loadSelected,
    async refresh() {
      const state = store.getState();
      if (!active || destroyed || state.busy) return false;
      const current = state.snapshot;
      if (!current) {
        store.finish("当前没有进行中的去重任务。");
        return true;
      }
      if (current.dirty) {
        pendingIntent = { kind: "refresh" };
        return store.requestConfirmation(DISCARD_LOCAL_CONFIRMATION);
      }
      if (!store.begin("refresh", "正在刷新审核任务……")) return false;
      stopPolling();
      return readPage(current.reviewId, current.filter, "审核状态已刷新。");
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
    async adoptFocused() {
      const state = store.getState();
      const snapshot = state.snapshot;
      const group = focusedReviewGroup(state);
      if (!active || destroyed || state.busy || !snapshot || !group || snapshot.summary.status !== "ready" || !group.imageOrder.length) return false;
      if (!store.begin("adopt", `正在采纳组 ${group.ordinal}……`)) return false;
      stopPolling();
      pageController?.abort();
      const controller = new AbortController();
      const ticket = requestGate.beginWrite();
      operationController = controller;
      try {
        await service.adoptGroup(
          snapshot.reviewId,
          group.id,
          group.imageOrder.filter((imageId) => group.images[imageId].selected),
          snapshot.version,
          controller.signal,
        );
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        const authority = await service.readPage(snapshot.reviewId, snapshot.filter, controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        const adopted = authority.groups[group.id];
        const failedImages = adopted ? adopted.imageOrder.filter((imageId) => authority.groups[group.id].images[imageId].failed).length : 0;
        if (failedImages) {
          store.commitSnapshot(authority, `组 ${group.ordinal} 有 ${failedImages} 张图片落地失败；调整后可重新采纳。`);
        } else {
          store.commitSnapshot(authority, `组 ${group.ordinal} 已采纳并落地。`);
          const index = authority.groupOrder.indexOf(group.id);
          const next = reviewStepIndex(index, authority.groupOrder.length, 1);
          if (next !== null) store.setFocusedGroup(authority.groupOrder[next]);
          else {
            const remaining = Math.max(0, authority.summary.totalGroupCount - authority.summary.decidedGroupCount);
            if (!remaining) store.finish("本次任务已全部采纳；点击“完成”结束本次任务。");
          }
        }
        syncPolling();
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isWriteCurrent(ticket)) return false;
        store.fail(reviewErrorPresentation(error), "采纳未完成；本地标记已保留，可重试。");
        return false;
      } finally {
        if (operationController === controller) operationController = null;
      }
    },
    async finish() {
      const state = store.getState();
      const snapshot = state.snapshot;
      if (!active || destroyed || state.busy || !snapshot) return false;
      if (!store.begin("finish", "正在结束本次任务……")) return false;
      stopPolling();
      pageController?.abort();
      const controller = new AbortController();
      const ticket = requestGate.beginWrite();
      operationController = controller;
      try {
        await service.finishReview(snapshot.reviewId, controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isWriteCurrent(ticket)) return false;
        store.reset("本次任务已完成；已采纳的结果保持不变。");
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed || !requestGate.isWriteCurrent(ticket)) return false;
        store.fail(reviewErrorPresentation(error), "结束失败；请重试。");
        return false;
      } finally {
        if (operationController === controller) operationController = null;
      }
    },
    run: (operation) => runStatus(operation),
    stayOnTask: () => store.clearPending(),
    async switchToPending() {
      const reviewId = store.getState().pendingReviewId;
      if (!reviewId || !active || destroyed) return false;
      const current = store.getState().snapshot;
      if (current) {
        try {
          await service.finishReview(current.reviewId, new AbortController().signal);
        } catch {
          // 结束旧任务失败不阻塞切换：物理结果已落地，遗留记录会在下次启动清理。
        }
      }
      store.selectReview(reviewId);
      if (!store.begin("load", "正在加载审核任务……")) return false;
      stopPolling();
      return readPage(reviewId, "", "审核任务已打开；逐组采纳后点击“完成”结束。");
    },
    async confirmAction(confirmed) {
      const confirmation = store.getState().confirmation;
      if (!confirmation) return false;
      if (!confirmed) {
        pendingIntent = null;
        store.dismissConfirmation();
        return false;
      }
      store.dismissConfirmation("已确认操作。");
      const intent = pendingIntent;
      pendingIntent = null;
      const snapshot = store.getState().snapshot;
      if (!intent || !snapshot) return false;
      if (intent.kind === "filter") {
        if (!store.begin("load", "正在切换审核筛选……")) return false;
        stopPolling();
        return readPage(snapshot.reviewId, intent.filter);
      }
      if (!store.begin("refresh", "正在刷新审核任务……")) return false;
      stopPolling();
      return readPage(snapshot.reviewId, snapshot.filter, "审核状态已刷新。");
    },
    beforeLeave: () => Promise.resolve(true),
    beforeWindowHide: () => Promise.resolve(true),
    discardDraft,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      requestGate.advanceLifecycle();
      stopPolling();
      polling.stopScope(REVIEW_SCOPE);
      pageController?.abort();
      operationController?.abort();
      pageController = null;
      operationController = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
