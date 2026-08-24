import type { PersistenceService } from "../../core/persistence/service";
import type { PollingHandle, PollingService } from "../../core/polling/service";
import {
  TASK_PAGE_LIMIT,
  TASK_POLL_INTERVAL_MS,
  shouldPollBatch,
  tasksErrorPresentation,
  type RecentFilter,
  type TaskPageQuery,
  type TasksErrorPresentation,
  type TasksOperation,
} from "./model";
import type { TasksService } from "./service";
import type { AuthorityCommitOptions, TasksStore } from "./state";

const ACTIVE_POLL_KEY = "tasks.active";
const TASKS_SCOPE = "app:tasks";

const SUCCESS_MESSAGES: Readonly<Record<TasksOperation, string>> = Object.freeze({
  cancel: "取消请求已接受，批次摘要与当前任务页已权威重读。",
  retry: "未完成项已重新排队，批次摘要与当前任务页已权威重读。",
  rerun: "批次已重新规划，批次摘要与当前任务页已权威重读。",
});

export interface TasksController {
  activate(): void;
  selectRecent(batchId: string): boolean;
  setRecentFilter(filter: RecentFilter): boolean;
  loadSelected(): Promise<boolean>;
  refresh(): Promise<boolean>;
  setPage(pageIndex: number): Promise<boolean>;
  setAddress(addressId: string): Promise<boolean>;
  requestOperation(operation: TasksOperation): boolean;
  confirmOperation(confirmed: boolean): Promise<boolean>;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createTasksController({
  store,
  service,
  polling,
  persistence,
}: {
  readonly store: TasksStore;
  readonly service: TasksService;
  readonly polling: PollingService;
  readonly persistence: PersistenceService;
}): TasksController {
  let active = false;
  let destroyed = false;
  let authorityHandle: PollingHandle | null = null;
  let authorityVersion = 0;
  let recentVersion = 0;
  let operationVersion = 0;
  let recentController: AbortController | null = null;
  let operationController: AbortController | null = null;

  const currentQuery = (): TaskPageQuery => {
    const state = store.getState();
    return Object.freeze({
      batchId: state.activeBatchId,
      offset: state.pageIndex * TASK_PAGE_LIMIT,
      addressId: state.addressId,
    });
  };

  const stopAuthority = (): void => {
    authorityVersion += 1;
    authorityHandle?.stop();
    authorityHandle = null;
  };

  const syncAuthority = (): void => {
    const state = store.getState();
    if (
      !active
      || destroyed
      || state.busy
      || !state.activeBatchId
      || (state.summary !== null && !shouldPollBatch(state.summary))
    ) {
      stopAuthority();
    }
  };

  const handleAuthorityError = (
    error: unknown,
    version: number,
    options: AuthorityCommitOptions,
  ): void => {
    if (!active || destroyed || version !== authorityVersion) return;
    const presentation = tasksErrorPresentation(error);
    if (presentation.missing) {
      persistence.writeActiveBatchId(null);
      store.clearMissing(presentation);
      stopAuthority();
      return;
    }
    store.failAuthority(presentation, options);
    syncAuthority();
  };

  const startAuthority = async (options: AuthorityCommitOptions = {}): Promise<boolean> => {
    stopAuthority();
    if (!active || destroyed || !store.getState().activeBatchId) return false;
    const version = authorityVersion;
    const query = currentQuery();
    const handle = polling.start({
      key: ACTIVE_POLL_KEY,
      scope: TASKS_SCOPE,
      intervalMs: TASK_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      task: (signal) => service.readAuthority(query, signal),
      onResult: (snapshot) => {
        if (!active || destroyed || version !== authorityVersion) return;
        store.commitAuthority(snapshot, options);
        syncAuthority();
      },
      onError: (error) => handleAuthorityError(error, version, options),
    });
    authorityHandle = handle;
    return handle.trigger();
  };

  const readRecent = async ({ report = false }: { readonly report?: boolean } = {}): Promise<boolean> => {
    recentController?.abort();
    const controller = new AbortController();
    const version = ++recentVersion;
    recentController = controller;
    try {
      const recent = await service.readRecent(controller.signal);
      if (!active || destroyed || controller.signal.aborted || version !== recentVersion) return false;
      store.commitRecent(recent);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || version !== recentVersion) {
        return false;
      }
      if (report) {
        const presentation = tasksErrorPresentation(error);
        store.finishBusy("error", "最近批次读取失败；未更改当前活动选择。", presentation);
      }
      return false;
    } finally {
      if (recentController === controller) recentController = null;
    }
  };

  const loadSelected = async (): Promise<boolean> => {
    const state = store.getState();
    const batchId = state.selectedRecentId;
    if (!active || destroyed || state.busy || !batchId) return false;
    if (batchId === state.activeBatchId && state.summary) return controller.refresh();
    stopAuthority();
    persistence.writeActiveBatchId(batchId);
    store.activateBatch(batchId);
    return startAuthority({
      clearBusy: true,
      operationMessage: "所选批次已加载；活动批次每 1.5 秒自动刷新。",
    });
  };

  const refresh = async (): Promise<boolean> => {
    const state = store.getState();
    if (!active || destroyed || state.busy) return false;
    store.beginBusy("refresh", "正在刷新最近批次、批次摘要与当前任务页。");
    const recent = readRecent({ report: !state.activeBatchId });
    if (!state.activeBatchId) {
      const loaded = await recent;
      if (loaded && active && !destroyed) {
        store.finishBusy("empty", "最近批次已刷新；请选择一个批次。", null);
      }
      return loaded;
    }
    const authority = startAuthority({
      clearBusy: true,
      operationMessage: "最近批次、批次摘要与当前任务页已刷新。",
    });
    const [, refreshed] = await Promise.all([recent, authority]);
    return refreshed;
  };

  const setPage = async (pageIndex: number): Promise<boolean> => {
    const state = store.getState();
    if (!active || destroyed || (state.busy && state.busy !== "load") || !store.setPage(pageIndex)) return false;
    return startAuthority({ clearBusy: true });
  };

  const setAddress = async (addressId: string): Promise<boolean> => {
    const state = store.getState();
    if (!active || destroyed || (state.busy && state.busy !== "load") || !store.setAddress(addressId)) return false;
    return startAuthority({ clearBusy: true });
  };

  const runOperation = async (operation: TasksOperation): Promise<boolean> => {
    const state = store.getState();
    if (!active || destroyed || state.busy || state.confirmation?.operation !== operation || !state.activeBatchId) {
      return false;
    }
    if (!store.beginBusy(operation, "正在执行批次操作；完成后将进行一次权威重读。")) return false;
    stopAuthority();
    operationController?.abort();
    const controller = new AbortController();
    const version = ++operationVersion;
    operationController = controller;
    let operationError: TasksErrorPresentation | null = null;
    try {
      await service.write(operation, state.activeBatchId, controller.signal);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || version !== operationVersion) {
        return false;
      }
      operationError = tasksErrorPresentation(error);
    }
    if (!active || destroyed || controller.signal.aborted || version !== operationVersion) return false;
    const reread = await startAuthority({
      clearBusy: true,
      error: operationError,
      operationMessage: operationError
        ? "操作失败；已尝试一次权威重读，不会强制更改任务状态。"
        : SUCCESS_MESSAGES[operation],
    });
    if (operationController === controller) operationController = null;
    return operationError === null && reread;
  };

  const controller: TasksController = Object.freeze({
    activate() {
      if (active || destroyed) return;
      active = true;
      void readRecent();
      if (store.getState().activeBatchId) {
        void startAuthority();
      } else {
        store.setPhase("empty", "暂无活动批次；可从最近批次中选择。");
      }
    },
    selectRecent: (batchId: string) => store.selectRecent(batchId),
    setRecentFilter: (filter: RecentFilter) => store.setRecentFilter(filter),
    loadSelected,
    refresh,
    setPage,
    setAddress,
    requestOperation: (operation: TasksOperation) => store.requestConfirmation(operation),
    async confirmOperation(confirmed: boolean) {
      const operation = store.getState().confirmation?.operation;
      if (!operation) return false;
      if (!confirmed) return store.dismissConfirmation();
      return runOperation(operation);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      authorityVersion += 1;
      recentVersion += 1;
      operationVersion += 1;
      authorityHandle?.stop();
      authorityHandle = null;
      polling.stopScope(TASKS_SCOPE);
      recentController?.abort();
      operationController?.abort();
      recentController = null;
      operationController = null;
      store.destroy();
    },
  });
  return controller;
}
