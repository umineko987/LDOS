// 数据集导出状态存储（G6-1）：任务列表、详情、阻断与操作阶段。

import {
  sanitizeExportJobDetail,
  sanitizeExportJobSummary,
  type ExportJobDetail,
  type ExportJobSummary,
} from "./model";

export type ExportLoadPhase = "idle" | "loading" | "ready" | "error";

export interface ExportJobsState {
  readonly phase: ExportLoadPhase;
  readonly jobs: readonly ExportJobSummary[];
  readonly loadedCount: number;
  readonly mayHaveMore: boolean;
  readonly errorCode: string | null;
}

export interface ExportDetailState {
  readonly exportId: string | null;
  readonly phase: ExportLoadPhase;
  readonly job: ExportJobDetail | null;
  readonly errorCode: string | null;
}

export type ExportOperationKind = "start" | "pause" | "resume" | "discard";

export interface ExportOperationState {
  readonly kind: ExportOperationKind | null;
  readonly exportId: string | null;
  readonly phase: "idle" | "busy" | "error";
  readonly errorCode: string | null;
}

export interface ExportAppState {
  readonly jobs: ExportJobsState;
  readonly detail: ExportDetailState;
  readonly operation: ExportOperationState;
}

export const EXPORT_INITIAL_STATE: ExportAppState = Object.freeze({
  jobs: Object.freeze({
    phase: "idle",
    jobs: Object.freeze([]),
    loadedCount: 0,
    mayHaveMore: false,
    errorCode: null,
  }),
  detail: Object.freeze({
    exportId: null,
    phase: "idle",
    job: null,
    errorCode: null,
  }),
  operation: Object.freeze({
    kind: null,
    exportId: null,
    phase: "idle",
    errorCode: null,
  }),
});

function jobsEqual(left: ExportJobsState, right: ExportJobsState): boolean {
  return (
    left.phase === right.phase &&
    left.loadedCount === right.loadedCount &&
    left.mayHaveMore === right.mayHaveMore &&
    left.errorCode === right.errorCode &&
    left.jobs.length === right.jobs.length &&
    left.jobs.every((job, index) => job === right.jobs[index])
  );
}

function detailEqual(left: ExportDetailState, right: ExportDetailState): boolean {
  return (
    left.exportId === right.exportId &&
    left.phase === right.phase &&
    left.errorCode === right.errorCode &&
    left.job === right.job
  );
}

function operationEqual(left: ExportOperationState, right: ExportOperationState): boolean {
  return (
    left.kind === right.kind &&
    left.exportId === right.exportId &&
    left.phase === right.phase &&
    left.errorCode === right.errorCode
  );
}

export function exportStatesEqual(left: ExportAppState, right: ExportAppState): boolean {
  return (
    jobsEqual(left.jobs, right.jobs) &&
    detailEqual(left.detail, right.detail) &&
    operationEqual(left.operation, right.operation)
  );
}

export interface ExportStore {
  getState(): ExportAppState;
  subscribe(listener: (state: ExportAppState) => void): () => void;
  reset(): void;

  setJobsLoading(): void;
  setJobsError(errorCode: string): void;
  appendJobs(
    jobs: readonly ExportJobSummary[],
    options: { mayHaveMore: boolean; replace: boolean },
  ): void;

  setDetailLoading(exportId: string): void;
  setDetailError(exportId: string, errorCode: string): void;
  setDetailJob(job: ExportJobDetail): void;
  clearDetail(): void;

  setOperationBusy(kind: ExportOperationKind, exportId: string): void;
  setOperationError(kind: ExportOperationKind, exportId: string, errorCode: string): void;
  setOperationIdle(): void;

  /** 用操作响应原地更新列表条目（无网络重载）。 */
  patchJobSummary(job: ExportJobSummary): void;
}

export function createExportStore(): ExportStore {
  let state: ExportAppState = EXPORT_INITIAL_STATE;
  const listeners = new Set<(state: ExportAppState) => void>();

  function publish(next: ExportAppState): void {
    if (exportStatesEqual(state, next)) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // 单个订阅者异常不得中断状态发布。
      }
    }
  }

  const store: ExportStore = {
    getState() {
      return state;
    },
    subscribe(listener) {
      try {
        listener(state);
      } catch {
        // 立即回放不因订阅者异常中断注册。
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      publish(EXPORT_INITIAL_STATE);
    },

    setJobsLoading() {
      publish({
        ...state,
        jobs: { ...state.jobs, phase: "loading", errorCode: null },
      });
    },
    setJobsError(errorCode) {
      publish({
        ...state,
        jobs: { ...state.jobs, phase: "error", errorCode },
      });
    },
    appendJobs(jobs, options) {
      const known = new Map(
        (options.replace ? [] : state.jobs.jobs).map((job) => [job.export_id, job]),
      );
      for (const raw of jobs) {
        // 再次清洗防止上游注入（store 边界防御）。
        const job = sanitizeExportJobSummary(raw);
        known.set(job.export_id, job);
      }
      const merged = [...known.values()].sort((left, right) => {
        if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
        return left.export_id < right.export_id ? -1 : 1;
      });
      publish({
        ...state,
        jobs: {
          phase: "ready",
          jobs: Object.freeze(merged),
          loadedCount: merged.length,
          mayHaveMore: options.mayHaveMore,
          errorCode: null,
        },
      });
    },

    setDetailLoading(exportId) {
      publish({
        ...state,
        detail: { exportId, phase: "loading", job: null, errorCode: null },
      });
    },
    setDetailError(exportId, errorCode) {
      publish({
        ...state,
        detail: { exportId, phase: "error", job: null, errorCode },
      });
    },
    setDetailJob(job) {
      publish({
        ...state,
        detail: {
          exportId: job.export_id,
          phase: "ready",
          job: sanitizeExportJobDetail(job),
          errorCode: null,
        },
      });
    },
    clearDetail() {
      publish({
        ...state,
        detail: { exportId: null, phase: "idle", job: null, errorCode: null },
      });
    },

    setOperationBusy(kind, exportId) {
      publish({
        ...state,
        operation: { kind, exportId, phase: "busy", errorCode: null },
      });
    },
    setOperationError(kind, exportId, errorCode) {
      publish({
        ...state,
        operation: { kind, exportId, phase: "error", errorCode },
      });
    },
    setOperationIdle() {
      publish({
        ...state,
        operation: { kind: null, exportId: null, phase: "idle", errorCode: null },
      });
    },

    patchJobSummary(job) {
      const normalized = sanitizeExportJobSummary(job);
      const jobs = state.jobs.jobs.map((entry) =>
        entry.export_id === normalized.export_id ? normalized : entry,
      );
      if (jobs.length === state.jobs.jobs.length && jobs.every((entry, index) => entry === state.jobs.jobs[index])) {
        return;
      }
      publish({ ...state, jobs: { ...state.jobs, jobs: Object.freeze(jobs) } });
    },
  };
  return store;
}
