import type { ApiClient } from "../../core/api/client";

import {
  sanitizeExportBlocker,
  sanitizeExportJobDetail,
  sanitizeExportJobSummary,
  validateExportAlias,
  type ExportBlocker,
  type ExportJobDetail,
  type ExportJobSummary,
} from "./model";

export const EXPORT_ENDPOINTS = Object.freeze({
  root: "/api/v1/dataset-exports",
} as const);

export interface ExportSourceInput {
  readonly sourceId: string;
  /** null 表示整个来源根目录。 */
  readonly directoryId: string | null;
  readonly includeDescendants: boolean;
  readonly outputAlias: string;
}

export interface ExportJobListResult {
  readonly jobs: readonly ExportJobSummary[];
  readonly mayHaveMore: boolean;
}

export interface ExportCreateResult {
  readonly job: ExportJobSummary;
  readonly blockers: readonly ExportBlocker[];
}

export interface ExportService {
  listJobs(
    offset: number,
    signal: AbortSignal,
  ): Promise<ExportJobListResult>;
  getJob(exportId: string, signal: AbortSignal): Promise<ExportJobDetail>;
  getBlockers(exportId: string, signal: AbortSignal): Promise<readonly ExportBlocker[]>;
  createExport(
    targetPath: string,
    selections: readonly ExportSourceInput[],
  ): Promise<ExportCreateResult>;
  start(exportId: string): Promise<ExportJobSummary>;
  pause(exportId: string): Promise<ExportJobSummary>;
  resume(exportId: string): Promise<ExportJobSummary>;
  discard(exportId: string): Promise<ExportJobSummary>;
}

function endpointId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new TypeError("invalid_export_id");
  }
  return encodeURIComponent(id);
}

/** 任务列表查询路径（view=desktop 有界响应，供预算合同测试盘点）。 */
export function datasetExportsPath(offset: number): string {
  const parameters = ["view=desktop", "limit=20"];
  if (offset > 0) parameters.push(`offset=${Math.floor(offset)}`);
  return `${EXPORT_ENDPOINTS.root}?${parameters.join("&")}`;
}

export function createExportService(api: ApiClient): ExportService {
  const service: ExportService = {
    async listJobs(offset, signal) {
      const payload = await api.get(datasetExportsPath(offset), { signal });
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("invalid_export_job_page");
      }
      const rawJobs = (payload as { jobs?: unknown }).jobs;
      if (!Array.isArray(rawJobs)) throw new TypeError("invalid_export_job_page");
      const jobs = rawJobs.map(sanitizeExportJobSummary);
      return { jobs, mayHaveMore: jobs.length >= 20 };
    },
    async getJob(exportId, signal) {
      return sanitizeExportJobDetail(
        await api.get(`${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}?view=desktop`, {
          signal,
        }),
      );
    },
    async getBlockers(exportId, signal) {
      const payload = await api.get(
        `${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}/blockers?view=desktop`,
        { signal },
      );
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("invalid_export_blocker_page");
      }
      const rawBlockers = (payload as { blockers?: unknown }).blockers;
      if (!Array.isArray(rawBlockers)) throw new TypeError("invalid_export_blocker_page");
      return rawBlockers.map(sanitizeExportBlocker);
    },
    async createExport(targetPath, selections) {
      if (typeof targetPath !== "string" || !targetPath.length || targetPath.length > 4096) {
        throw new TypeError("invalid_export_target_path");
      }
      if (selections.length === 0 || selections.length > 50) {
        throw new TypeError("invalid_export_selections");
      }
      const body = {
        target_path: targetPath,
        selections: selections.map((selection) => {
          if (!validateExportAlias(selection.outputAlias)) {
            throw new TypeError("invalid_export_alias");
          }
          return {
            source_id: selection.sourceId,
            directory_id: selection.directoryId,
            include_descendants: selection.includeDescendants,
            output_alias: selection.outputAlias,
          };
        }),
      };
      const payload = await api.post(EXPORT_ENDPOINTS.root, body);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("invalid_export_create_result");
      }
      const record = payload as { job?: unknown; blockers?: unknown };
      // 后端契约：就绪时直接返回任务对象；阻断时包一层 {job, blockers}。
      const job = sanitizeExportJobSummary(
        record.job !== undefined ? record.job : payload,
      );
      const blockers = Array.isArray(record.blockers)
        ? record.blockers.map(sanitizeExportBlocker)
        : [];
      return { job, blockers };
    },
    async start(exportId) {
      return sanitizeExportJobSummary(
        await api.post(`${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}/start`),
      );
    },
    async pause(exportId) {
      return sanitizeExportJobSummary(
        await api.post(`${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}/pause`),
      );
    },
    async resume(exportId) {
      return sanitizeExportJobSummary(
        await api.post(`${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}/resume`),
      );
    },
    async discard(exportId) {
      return sanitizeExportJobSummary(
        await api.post(`${EXPORT_ENDPOINTS.root}/${endpointId(exportId)}/discard`),
      );
    },
  };
  return service;
}
