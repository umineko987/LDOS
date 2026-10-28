import {
  TASK_PAGE_LIMIT,
  TERMINAL_BATCH_STATUSES,
  deriveOperationAvailability,
  filterRecentBatches,
  recentBatchFromSummary,
  taskPageCount,
  validateBatchId,
  type BatchSummary,
  type RecentBatch,
  type RecentFilter,
  type TaskEntity,
  type TasksAuthoritySnapshot,
  type TasksErrorPresentation,
  type TasksOperation,
  type TasksPhase,
} from "./model";

export interface TasksConfirmation {
  readonly operation: TasksOperation;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly warning: string;
}

export interface TasksState {
  readonly activeBatchId: string;
  readonly selectedRecentId: string;
  readonly recentFilter: RecentFilter;
  readonly recent: readonly RecentBatch[];
  readonly summary: BatchSummary | null;
  readonly entities: Readonly<Record<string, TaskEntity>>;
  readonly order: readonly string[];
  readonly pageIndex: number;
  readonly addressId: string;
  readonly phase: TasksPhase;
  readonly error: TasksErrorPresentation | null;
  readonly busy: TasksOperation | "load" | "refresh" | "";
  readonly operationMessage: string;
  readonly confirmation: TasksConfirmation | null;
}

export interface AuthorityCommitOptions {
  readonly error?: TasksErrorPresentation | null;
  readonly operationMessage?: string;
  readonly clearBusy?: boolean;
}

export interface TasksStore {
  subscribe(listener: (state: TasksState) => void): () => void;
  getState(): TasksState;
  setPhase(phase: TasksPhase, operationMessage?: string): boolean;
  commitRecent(recent: readonly RecentBatch[]): boolean;
  selectRecent(batchId: string): boolean;
  setRecentFilter(filter: RecentFilter): boolean;
  activateBatch(batchId: string): boolean;
  setPage(pageIndex: number): boolean;
  setAddress(addressId: string): boolean;
  commitAuthority(snapshot: TasksAuthoritySnapshot, options?: AuthorityCommitOptions): boolean;
  failAuthority(error: TasksErrorPresentation, options?: AuthorityCommitOptions): boolean;
  clearMissing(error: TasksErrorPresentation): boolean;
  beginBusy(kind: TasksOperation | "load" | "refresh", message: string): boolean;
  finishBusy(phase: TasksPhase, message: string, error?: TasksErrorPresentation | null): boolean;
  setOperationMessage(message: string): boolean;
  requestConfirmation(operation: TasksOperation): boolean;
  dismissConfirmation(): boolean;
  destroy(): void;
}

const EMPTY_ENTITIES = Object.freeze(Object.create(null) as Record<string, TaskEntity>);
const EMPTY_ORDER = Object.freeze([]) as readonly string[];

const CONFIRMATIONS = Object.freeze({
  cancel: Object.freeze({
    operation: "cancel",
    title: "取消当前批次？",
    message: "系统将请求取消该批次及其活动图片任务，不会删除已完成文件。",
    confirmLabel: "取消批次",
    warning: "取消请求可能需要片刻生效，请以权威重读后的状态为准。",
  }),
  retry: Object.freeze({
    operation: "retry",
    title: "重试未完成项？",
    message: "系统将重新排队失败图片并重新规划未完成地址，已完成文件会自动跳过。",
    confirmLabel: "重试未完成项",
    warning: "失败任务将获得 2 次额外重试；已完成文件不会重复下载。",
  }),
  rerun: Object.freeze({
    operation: "rerun",
    title: "重新规划当前批次？",
    message: "系统将按原批次和原目录重新规划全部地址，默认只处理新增、失败或取消的内容。",
    confirmLabel: "重新规划批次",
    warning: "去重审核进行中时不能重新规划。",
  }),
} satisfies Record<TasksOperation, TasksConfirmation>);

function freezeState(state: TasksState): TasksState {
  return Object.freeze(state);
}

function sameTask(left: TaskEntity, right: TaskEntity): boolean {
  return left.id === right.id
    && left.site === right.site
    && left.status === right.status
    && left.statusLabel === right.statusLabel
    && left.statusKind === right.statusKind
    && left.sourceOrder === right.sourceOrder
    && left.addressOrder === right.addressOrder
    && left.sequence === right.sequence
    && left.attemptCount === right.attemptCount
    && left.maxAttempts === right.maxAttempts
    && left.addressId === right.addressId
    && left.artifactCount === right.artifactCount
    && left.artifactBytes === right.artifactBytes
    && left.errorClass === right.errorClass
    && left.errorCategory === right.errorCategory
    && left.terminal === right.terminal;
}

function pageEntities(previous: Readonly<Record<string, TaskEntity>>, items: readonly TaskEntity[]) {
  const entities = Object.create(null) as Record<string, TaskEntity>;
  const order: string[] = [];
  for (const task of items) {
    const current = previous[task.id];
    entities[task.id] = current && sameTask(current, task) ? current : task;
    order.push(task.id);
  }
  return Object.freeze({
    entities: Object.freeze(entities) as Readonly<Record<string, TaskEntity>>,
    order: Object.freeze(order) as readonly string[],
  });
}

function mergeRecent(recent: readonly RecentBatch[], summary: BatchSummary): readonly RecentBatch[] {
  const projected = recentBatchFromSummary(summary);
  const index = recent.findIndex(({ id }) => id === summary.id);
  if (index < 0) return Object.freeze([projected, ...recent].slice(0, 30));
  const existing = recent[index];
  if (
    existing.status === projected.status
    && existing.createdAt === projected.createdAt
    && existing.taskCount === projected.taskCount
    && existing.succeededTaskCount === projected.succeededTaskCount
    && existing.failedTaskCount === projected.failedTaskCount
  ) return recent;
  return Object.freeze(recent.map((item, itemIndex) => itemIndex === index ? projected : item));
}

function phaseFor(summary: BatchSummary | null): TasksPhase {
  if (!summary) return "empty";
  return TERMINAL_BATCH_STATUSES.has(summary.status) ? "terminal" : "content";
}

export function tasksFromState(state: TasksState): readonly TaskEntity[] {
  return state.order.map((id) => state.entities[id]).filter((task): task is TaskEntity => Boolean(task));
}

export function filteredRecentFromState(state: TasksState): readonly RecentBatch[] {
  return filterRecentBatches(state.recent, state.recentFilter);
}

export function createTasksStore({ activeBatchId = "" }: { readonly activeBatchId?: string } = {}): TasksStore {
  const initialBatchId = activeBatchId ? validateBatchId(activeBatchId) : "";
  let state = freezeState({
    activeBatchId: initialBatchId,
    selectedRecentId: initialBatchId,
    recentFilter: "all",
    recent: Object.freeze([]),
    summary: null,
    entities: EMPTY_ENTITIES,
    order: EMPTY_ORDER,
    pageIndex: 0,
    addressId: "",
    phase: initialBatchId ? "loading" : "empty",
    error: null,
    busy: "",
    operationMessage: initialBatchId ? "正在加载活动批次。" : "正在等待批次选择。",
    confirmation: null,
  });
  const listeners = new Set<(state: TasksState) => void>();
  let destroyed = false;

  const publish = (next: TasksState): boolean => {
    if (destroyed || next === state) return false;
    state = freezeState(next);
    for (const listener of listeners) listener(state);
    return true;
  };

  const service: TasksStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    setPhase(phase, operationMessage = state.operationMessage) {
      if (state.phase === phase && state.operationMessage === operationMessage) return false;
      return publish({ ...state, phase, operationMessage });
    },
    commitRecent(recent) {
      const sanitized = Object.freeze([...recent]);
      const nextRecent = state.summary ? mergeRecent(sanitized, state.summary) : sanitized;
      const selected = nextRecent.some(({ id }) => id === state.selectedRecentId)
        ? state.selectedRecentId
        : nextRecent.some(({ id }) => id === state.activeBatchId)
          ? state.activeBatchId
          : "";
      return publish({ ...state, recent: nextRecent, selectedRecentId: selected });
    },
    selectRecent(batchId) {
      const selected = batchId ? validateBatchId(batchId) : "";
      if (selected && !filteredRecentFromState(state).some(({ id }) => id === selected)) return false;
      if (state.selectedRecentId === selected) return false;
      return publish({ ...state, selectedRecentId: selected });
    },
    setRecentFilter(filter) {
      filterRecentBatches(state.recent, filter);
      if (state.recentFilter === filter) return false;
      const next = { ...state, recentFilter: filter };
      const selectedRecentId = filterRecentBatches(state.recent, filter)
        .some(({ id }) => id === state.selectedRecentId) ? state.selectedRecentId : "";
      return publish({ ...next, selectedRecentId });
    },
    activateBatch(batchId) {
      const active = validateBatchId(batchId);
      if (state.activeBatchId === active && state.summary?.id === active) return false;
      return publish({
        ...state,
        activeBatchId: active,
        selectedRecentId: active,
        summary: null,
        entities: EMPTY_ENTITIES,
        order: EMPTY_ORDER,
        pageIndex: 0,
        addressId: "",
        phase: "loading",
        error: null,
        busy: "load",
        confirmation: null,
        operationMessage: "正在读取所选批次的摘要与第一页任务。",
      });
    },
    setPage(pageIndex) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= taskPageCount(state.summary, state.addressId)) {
        return false;
      }
      if (state.pageIndex === pageIndex) return false;
      return publish({
        ...state,
        pageIndex,
        entities: EMPTY_ENTITIES,
        order: EMPTY_ORDER,
        phase: "loading",
        busy: "load",
        error: null,
        operationMessage: `正在读取第 ${pageIndex + 1} 页任务。`,
      });
    },
    setAddress(addressId) {
      const selected = addressId ? validateBatchId(addressId) : "";
      if (selected && !state.summary?.sources.some((source) => source.addresses.some(({ id }) => id === selected))) {
        return false;
      }
      if (state.addressId === selected) return false;
      return publish({
        ...state,
        addressId: selected,
        pageIndex: 0,
        entities: EMPTY_ENTITIES,
        order: EMPTY_ORDER,
        phase: "loading",
        busy: "load",
        error: null,
        operationMessage: selected ? "正在读取所选来源地址的任务。" : "正在读取全部来源地址的任务。",
      });
    },
    commitAuthority(snapshot, options = {}) {
      const expectedOffset = state.pageIndex * TASK_PAGE_LIMIT;
      if (
        snapshot.summary.id !== state.activeBatchId
        || snapshot.page.batchId !== state.activeBatchId
        || snapshot.page.offset !== expectedOffset
        || snapshot.page.addressId !== state.addressId
      ) return false;
      const page = pageEntities(state.entities, snapshot.page.items);
      const recent = mergeRecent(state.recent, snapshot.summary);
      const nextBusy = options.clearBusy ? "" : state.busy;
      const confirmation = state.confirmation
        && deriveOperationAvailability(snapshot.summary, nextBusy)[state.confirmation.operation]
        ? state.confirmation
        : null;
      return publish({
        ...state,
        summary: snapshot.summary,
        entities: page.entities,
        order: page.order,
        recent,
        selectedRecentId: state.selectedRecentId || snapshot.summary.id,
        phase: phaseFor(snapshot.summary),
        error: options.error ?? null,
        busy: nextBusy,
        operationMessage: options.operationMessage ?? (
          TERMINAL_BATCH_STATUSES.has(snapshot.summary.status)
            ? "批次已结束，自动刷新已停止。"
            : "批次摘要与当前任务页已更新。"
        ),
        confirmation,
      });
    },
    failAuthority(error, options = {}) {
      const nextBusy = options.clearBusy ? "" : state.busy;
      const confirmation = state.confirmation
        && deriveOperationAvailability(state.summary, nextBusy)[state.confirmation.operation]
        ? state.confirmation
        : null;
      return publish({
        ...state,
        phase: state.summary ? "partial" : "error",
        error: options.error ?? error,
        busy: nextBusy,
        operationMessage: options.operationMessage ?? "未获得完整摘要与任务页；已保留上一次完整快照。",
        confirmation,
      });
    },
    clearMissing(error) {
      return publish({
        ...state,
        activeBatchId: "",
        selectedRecentId: "",
        summary: null,
        entities: EMPTY_ENTITIES,
        order: EMPTY_ORDER,
        pageIndex: 0,
        addressId: "",
        phase: "empty",
        error,
        busy: "",
        confirmation: null,
        operationMessage: "该批次已不存在，已清除活动选择并停止自动刷新。",
      });
    },
    beginBusy(kind, message) {
      if (state.busy) return false;
      return publish({
        ...state,
        busy: kind,
        phase: kind === "cancel" || kind === "retry" || kind === "rerun" ? "writing" : "loading",
        error: null,
        confirmation: null,
        operationMessage: message,
      });
    },
    finishBusy(phase, operationMessage, error = null) {
      if (!state.busy) return false;
      return publish({ ...state, busy: "", phase, operationMessage, error, confirmation: null });
    },
    setOperationMessage(operationMessage) {
      if (operationMessage === state.operationMessage) return false;
      return publish({ ...state, operationMessage });
    },
    requestConfirmation(operation) {
      const available = deriveOperationAvailability(state.summary, state.busy);
      if (!available[operation] || state.confirmation?.operation === operation) return false;
      return publish({ ...state, confirmation: CONFIRMATIONS[operation] });
    },
    dismissConfirmation() {
      if (!state.confirmation) return false;
      return publish({ ...state, confirmation: null });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(service);
}
