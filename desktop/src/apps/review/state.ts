import {
  confirmReviewGroup,
  deriveReviewPresentation,
  reviewCanList,
  updateReviewImageSelection,
  validateReviewId,
  validateReviewSnapshot,
  type ReviewErrorPresentation,
  type ReviewOperation,
  type ReviewPhase,
  type ReviewRecentBatch,
  type ReviewSnapshot,
} from "./model";

export type ReviewConfirmation = Readonly<{
  action: "apply" | "discard-reload";
  title: string;
  message: string;
  confirmLabel: string;
  warning: string;
}>;

export interface ReviewState {
  readonly recent: readonly ReviewRecentBatch[];
  readonly selectedBatchId: string;
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
  commitRecent(recent: readonly ReviewRecentBatch[]): boolean;
  selectBatch(batchId: string): boolean;
  begin(operation: Exclude<ReviewOperation, "">, message: string): boolean;
  commitSnapshot(snapshot: ReviewSnapshot, message?: string): boolean;
  fail(error: ReviewErrorPresentation, message?: string): boolean;
  finish(message: string): boolean;
  setFocusedGroup(groupId: string): boolean;
  setActiveImage(imageId: string): boolean;
  toggleImage(groupId: string, imageId: string): boolean;
  confirmGroup(groupId: string): boolean;
  clearDraft(message?: string): boolean;
  requestConfirmation(confirmation: ReviewConfirmation): boolean;
  dismissConfirmation(message?: string): boolean;
  destroy(): void;
}

type InternalState = Omit<ReviewState, "presentation">;

function freezeState(source: InternalState): ReviewState {
  return Object.freeze({
    ...source,
    recent: Object.freeze([...source.recent]),
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
    recent: Object.freeze([]),
    selectedBatchId: "",
    snapshot: null,
    focusedGroupId: "",
    activeImageId: "",
    phase: "empty",
    busy: "",
    error: null,
    message: "选择一个已结束批次；打开批次不会自动开始分析。",
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
    commitRecent(recent) {
      const safeRecent = Object.freeze([...recent]);
      const selectedBatchId = safeRecent.some(({ id }) => id === state.selectedBatchId)
        ? state.selectedBatchId
        : safeRecent.some(({ id }) => id === state.snapshot?.batchId)
          ? state.snapshot!.batchId
          : "";
      return publish({ ...state, recent: safeRecent, selectedBatchId });
    },
    selectBatch(batchId) {
      const id = batchId ? validateReviewId(batchId) : "";
      if (id && !state.recent.some((batch) => batch.id === id && batch.terminal)) return false;
      if (state.selectedBatchId === id) return false;
      return publish({ ...state, selectedBatchId: id });
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
        selectedBatchId: snapshot.batchId,
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
      return snapshot !== state.snapshot && publish({ ...state, snapshot, activeImageId: imageId, message: `组 ${group.ordinal}：图 ${image.ordinal} ${image.selected ? "移除" : "保留"}。`, error: null });
    },
    confirmGroup(groupId) {
      if (!state.snapshot || state.snapshot.summary.status !== "ready" || state.busy) return false;
      const snapshot = confirmReviewGroup(state.snapshot, groupId);
      return snapshot !== state.snapshot && publish({ ...state, snapshot, message: `已确认组 ${snapshot.groups[groupId].ordinal}，等待保存。`, error: null });
    },
    clearDraft(message = "未保存的待提交组已放弃，正在读取权威审核状态。") {
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
