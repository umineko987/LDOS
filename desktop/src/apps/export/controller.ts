// 数据集导出控制器（G6-1）：任务列表加载、详情、状态机操作。

import type { ApiClient } from "../../core/api/client";
import type { PollingHandle, PollingService } from "../../core/polling/service";

import {
  EXPORT_TERMINAL_STATES,
  type ExportBlocker,
  type ExportJobDetail,
  type ExportJobSummary,
} from "./model";
import {
  createExportService,
  type ExportSourceInput,
  type ExportService,
} from "./service";
import {
  createExportStore,
  type ExportAppState,
  type ExportOperationKind,
  type ExportStore,
} from "./state";

const POLL_INTERVAL_MS = 1200;
const EXPORT_POLL_KEY = "exports.active";
const EXPORT_POLL_SCOPE = "export";

export interface ExportController {
  readonly store: ExportStore;
  readonly service: ExportService;
  activate(): boolean;
  destroy(): void;
  refreshJobs(): Promise<boolean>;
  loadMoreJobs(): Promise<boolean>;
  openDetail(exportId: string): Promise<boolean>;
  closeDetail(): void;
  refreshDetail(): Promise<boolean>;
  startJob(exportId: string): Promise<boolean>;
  pauseJob(exportId: string): Promise<boolean>;
  resumeJob(exportId: string): Promise<boolean>;
  discardJob(exportId: string): Promise<boolean>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "export_unknown_error";
}

/** 非终态任务需要轮询推进（staging/committing 等由后台线程驱动）。 */
export function exportJobNeedsPolling(job: ExportJobSummary): boolean {
  return !EXPORT_TERMINAL_STATES.includes(job.status) && job.status !== "blocked";
}

export function createExportController(
  api: ApiClient,
  store: ExportStore = createExportStore(),
  service: ExportService = createExportService(api),
  polling: PollingService | null = null,
): ExportController {
  let active = false;
  let jobsRequestId = 0;
  let detailRequestId = 0;
  let pollHandle: PollingHandle | null = null;
  let detailAbort: AbortController | null = null;
  let jobsAbort: AbortController | null = null;

  function schedulePoll(): void {
    if (pollHandle !== null || !active || polling === null) return;
    pollHandle = polling.start({
      key: EXPORT_POLL_KEY,
      scope: EXPORT_POLL_SCOPE,
      intervalMs: POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      task: (signal) => pollActiveJobs(signal),
      onResult: () => {},
      onError: () => {
        // 轮询失败不打断 UI；下一轮继续。
      },
    });
  }

  function stopPoll(): void {
    if (pollHandle !== null) {
      pollHandle.stop();
      pollHandle = null;
    }
  }

  async function pollActiveJobs(signal: AbortSignal): Promise<boolean> {
    const state = store.getState();
    const actives = state.jobs.jobs.filter(exportJobNeedsPolling);
    if (actives.length === 0) {
      stopPoll();
      return false;
    }
    const requestId = ++jobsRequestId;
    try {
      const { jobs } = await service.listJobs(0, signal);
      if (!active || requestId !== jobsRequestId) return false;
      // 轮询结果可能少于已加载页（终态过滤）；只用于原地推进已知任务。
      store.appendJobs(jobs, { mayHaveMore: state.jobs.mayHaveMore, replace: false });
      const detailId = store.getState().detail.exportId;
      if (detailId !== null && jobs.some((job) => job.export_id === detailId)) {
        await controller.refreshDetail();
      }
      return true;
    } catch {
      // 轮询失败不打断 UI；下一轮继续。
      return false;
    }
  }

  async function operate(
    kind: ExportOperationKind,
    exportId: string,
    action: (id: string) => Promise<ExportJobSummary>,
  ): Promise<boolean> {
    store.setOperationBusy(kind, exportId);
    try {
      const job = await action(exportId);
      store.patchJobSummary(job);
      store.setOperationIdle();
      schedulePoll();
      return true;
    } catch (error) {
      store.setOperationError(kind, exportId, errorMessage(error));
      return false;
    }
  }


  const controller: ExportController = {
    store,
    service,
    activate() {
      if (active) return false;
      active = true;
      void controller.refreshJobs();
      return true;
    },
    destroy() {
      active = false;
      stopPoll();
      jobsAbort?.abort();
      detailAbort?.abort();
      store.reset();
    },
    async refreshJobs() {
      const requestId = ++jobsRequestId;
      jobsAbort?.abort();
      jobsAbort = new AbortController();
      store.setJobsLoading();
      try {
        const { jobs, mayHaveMore } = await service.listJobs(0, jobsAbort.signal);
        if (!active || requestId !== jobsRequestId) return false;
        store.appendJobs(jobs, { mayHaveMore, replace: true });
        schedulePoll();
        return true;
      } catch (error) {
        if (!active || requestId !== jobsRequestId) return false;
        store.setJobsError(errorMessage(error));
        return false;
      }
    },
    async loadMoreJobs() {
      const state = store.getState();
      if (state.jobs.phase !== "ready" || !state.jobs.mayHaveMore) return false;
      const requestId = ++jobsRequestId;
      try {
        const { jobs, mayHaveMore } = await service.listJobs(
          state.jobs.loadedCount,
          jobsAbort?.signal ?? new AbortController().signal,
        );
        if (!active || requestId !== jobsRequestId) return false;
        store.appendJobs(jobs, { mayHaveMore, replace: false });
        return true;
      } catch {
        return false;
      }
    },
    async openDetail(exportId) {
      const requestId = ++detailRequestId;
      detailAbort?.abort();
      detailAbort = new AbortController();
      store.setDetailLoading(exportId);
      try {
        const job = await service.getJob(exportId, detailAbort.signal);
        if (requestId !== detailRequestId) return false;
        store.setDetailJob(job);
        return true;
      } catch (error) {
        if (requestId !== detailRequestId) return false;
        store.setDetailError(exportId, errorMessage(error));
        return false;
      }
    },
    closeDetail() {
      detailRequestId += 1;
      detailAbort?.abort();
      store.clearDetail();
    },
    async refreshDetail() {
      const exportId = store.getState().detail.exportId;
      if (exportId === null) return false;
      return controller.openDetail(exportId);
    },
    startJob(exportId) {
      return operate("start", exportId, service.start);
    },
    pauseJob(exportId) {
      return operate("pause", exportId, service.pause);
    },
    resumeJob(exportId) {
      return operate("resume", exportId, service.resume);
    },
    discardJob(exportId) {
      return operate("discard", exportId, service.discard);
    },
  };
  return controller;
}

/** 从创建结果推导展示语义（列表外新建任务直接进入详情）。 */
export function exportCreateOutcome(
  blockers: readonly ExportBlocker[],
): { kind: "ready" } | { kind: "blocked"; blockers: readonly ExportBlocker[] } {
  if (blockers.length > 0) return { kind: "blocked", blockers };
  return { kind: "ready" };
}

export type { ExportSourceInput, ExportAppState, ExportJobDetail };
