import {
  deriveReviewPresentation,
  reviewCanList,
  updateReviewImageSelection,
  validateReviewId,
  validateReviewSnapshot,
  type ReviewErrorPresentation,
  type ReviewOperation,
  type ReviewPhase,
  type ReviewSnapshot,
} from "./model";

export type ReviewConfirmation = Readonly<{
  action: "switch-task" | "discard-local";
  title: string;
  message: string;
  confirmLabel: string;
  warning: string;
}>;

export interface ReviewState {
  readonly selectedReviewId: string;
  readonly pendingReviewId: string;
  readonly snapshot: ReviewSnapshot | null;
  readonly focusedGroupId: string;
  readonly activeImageId: string;
  readonly phase: ReviewPhase;
  readonly busy: ReviewOperation;
  readonly error: ReviewErrorPresentation | null;
  readonly message: string;
  readonly confirmation: ReviewConfirmation | null;
  readonly presentation: ReturnType<typeof deriveReviewPresentation>;
}

export interface ReviewStore {
  subscribe(listener: (state: ReviewState) => void): () => void;
  getState(): ReviewState;
  selectReview(reviewId: string): boolean;
  queueReview(reviewId: string): boolean;
  clearPending(): boolean;
  updateDraftVersion(version: number): boolean;
  begin(operation: Exclude<ReviewOperation, "">, message: string): boolean;
  commitSnapshot(snapshot: ReviewSnapshot, message?: string): boolean;
  fail(error: ReviewErrorPresentation, message?: string): boolean;
  finish(message: string): boolean;
  setFocusedGroup(groupId: string): boolean;
  setActiveImage(imageId: string): boolean;
  toggleImage(groupId: string, imageId: string): boolean;
  reset(message: string): boolean;
  clearDraft(message?: string): boolean;
  requestConfirmation(confirmation: ReviewConfirmation): boolean;
  dismissConfirmation(message?: string): boolean;
  destroy(): void;
}

type InternalState = Omit<ReviewState, "presentation">;

function freezeState(source: InternalState): ReviewState {
  return Object.freeze({
    ...source,
    presentation: deriveReviewPresentation(source.phase, source.snapshot?.summary ?? null),
  });
}

function firstImage(snapshot: ReviewSnapshot | null, groupId: string): string {
  return snapshot?.groups[groupId]?.imageOrder[0] ?? "";
}

export function reviewGroupsFromState(state: ReviewState) {
  return state.snapshot
    ? state.snapshot.groupOrder.map((id) => state.snapshot!.groups[id])
    : [];
}

export function focusedReviewGroup(state: ReviewState) {
  return state.snapshot?.groups[state.focusedGroupId] ?? null;
}

export function createReviewStore(): ReviewStore {
  let state = freezeState({
    selectedReviewId: "",
    pendingReviewId: "",
    snapshot: null,
    focusedGroupId: "",
    activeImageId: "",
    phase: "empty",
    busy: "",
    error: null,
    message: "请在图库勾选图片或目录发起去重。",
    confirmation: null,
  });
  const listeners = new Set<(value: ReviewState) => void>();
  let destroyed = false;

  const publish = (next: InternalState): boolean => {
    if (destroyed) return false;
    state = freezeState(next);
    for (const listener of [...listeners]) listener(state);
    return true;
  };

  const store: ReviewStore = {
    subscribe(listener) {
      if (destroyed) return () => {};
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    selectReview(reviewId) {
      const id = reviewId ? validateReviewId(reviewId) : "";
      if (state.selectedReviewId === id && !state.pendingReviewId) return false;
      return publish({ ...state, selectedReviewId: id, pendingReviewId: "" });
    },
    queueReview(reviewId) {
      return publish({ ...state, pendingReviewId: validateReviewId(reviewId), message: "新审核任务已收到。" });
    },
    clearPending() {
      if (!state.pendingReviewId) return false;
      return publish({ ...state, pendingReviewId: "", message: "已留在当前任务。" });
    },
    updateDraftVersion(version) {
      if (!state.snapshot?.dirty || !Number.isSafeInteger(version) || version <= state.snapshot.version) return false;
      return publish({ ...state, snapshot: Object.freeze({ ...state.snapshot, version }) });
    },
    begin(operation, message) {
      if (state.busy) return false;
      return publish({ ...state, busy: operation, phase: operation === "load" || operation === "refresh" ? "loading" : "writing", error: null, message, confirmation: null });
    },
    commitSnapshot(snapshot, message = "当前筛选的全部审核组已加载。") {
      validateReviewSnapshot(snapshot);
      const focusedGroupId = snapshot.groups[state.focusedGroupId]
        ? state.focusedGroupId
        : snapshot.groupOrder[0] ?? "";
      const activeImageId = snapshot.groups[focusedGroupId]?.images[state.activeImageId]
        ? state.activeImageId
        : firstImage(snapshot, focusedGroupId);
      return publish({
        ...state,
        selectedReviewId: snapshot.reviewId,
        snapshot,
        focusedGroupId,
        activeImageId,
        phase: reviewCanList(snapshot.summary) ? "content" : "polling",
        busy: "",
        error: null,
        message,
        confirmation: null,
      });
    },
    fail(error, message = "审核操作未完成；安全快照和草稿已保留。") {
      return publish({ ...state, phase: "error", busy: "", error, message, confirmation: null });
    },
    finish(message) {
      return publish({ ...state, busy: "", phase: state.snapshot ? reviewCanList(state.snapshot.summary) ? "content" : "polling" : "empty", message, confirmation: null });
    },
    setFocusedGroup(groupId) {
      const id = validateReviewId(groupId);
      if (!state.snapshot?.groups[id] || state.focusedGroupId === id) return false;
      return publish({ ...state, focusedGroupId: id, activeImageId: firstImage(state.snapshot, id), message: `已切换到组 ${state.snapshot.groups[id].ordinal}。` });
    },
    setActiveImage(imageId) {
      const id = validateReviewId(imageId);
      const group = focusedReviewGroup(state);
      if (!group?.images[id] || state.activeImageId === id) return false;
      return publish({ ...state, activeImageId: id, message: `已聚焦图 ${group.images[id].ordinal}。` });
    },
    toggleImage(groupId, imageId) {
      if (!state.snapshot || state.snapshot.summary.status !== "ready" || state.busy) return false;
      const group = state.snapshot.groups[groupId];
      const image = group?.images[imageId];
      if (!group || !image) return false;
      const snapshot = updateReviewImageSelection(state.snapshot, groupId, imageId, !image.selected);
      return snapshot !== state.snapshot && publish({ ...state, snapshot, activeImageId: imageId, message: `组 ${group.ordinal}：图 ${image.ordinal} 标记为${image.selected ? "回收" : "保留"}，采纳后生效。`, error: null });
    },
    reset(message) {
      return publish({
        ...state,
        selectedReviewId: "",
        pendingReviewId: "",
        snapshot: null,
        focusedGroupId: "",
        activeImageId: "",
        phase: "empty",
        busy: "",
        error: null,
        message,
        confirmation: null,
      });
    },
    clearDraft(message = "未采纳的更改已放弃，正在读取最新状态。") {
      if (!state.snapshot?.dirty) return false;
      return publish({
        ...state,
        snapshot: null,
        focusedGroupId: "",
        activeImageId: "",
        phase: "loading",
        busy: "",
        error: null,
        message,
        confirmation: null,
      });
    },
    requestConfirmation(confirmation) {
      if (state.busy || state.confirmation) return false;
      return publish({ ...state, confirmation });
    },
    dismissConfirmation(message = "已取消操作，审核状态未改变。") {
      if (!state.confirmation) return false;
      return publish({ ...state, confirmation: null, message });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(store);
}
