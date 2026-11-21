// 导出查询：一个数据集的导出历史、计划预览（dry_run）、开始、取消、续传。
//
// 历史挂在 `datasetKeys.dataset(id)` 下面，数据集一失效它也跟着刷新；进度看 SSE：
// job.updated（job_id 在导出记录里）给逐文件进度，dataset.export.updated 在状态变化时让历史失效（见 exports-live.svelte.ts）。
// 进行中的导出另有兜底轮询。

import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import type { components } from "../schema";
import { datasetKeys } from "./datasets.ts";
import { invalidateLibrary, libraryKeys } from "./library.ts";

type Schemas = components["schemas"];

export type DatasetExport = Schemas["DatasetExportJobResponse"];
export type ExportStatus = DatasetExport["status"];
export type ExportPlan = Schemas["DatasetExportPlanResponse"];
export type ExportPlanItem = Schemas["DatasetExportPlanItemResponse"];
export type ExportRequest = Schemas["DatasetExportRequest"];
export type ExportOptions = Schemas["DatasetExportOptionsResponse"];
export type ExportLayout = NonNullable<ExportRequest["layout"]>;
export type ExportRename = NonNullable<ExportRequest["rename"]>;

export const EXPORT_HISTORY_LIMIT = 20;
export const EXPORT_POLL_MS = 2000;

export const exportKeys = {
  list: (id: string) => [...datasetKeys.dataset(id), "exports"] as const,
};

export function isActiveExport(status: ExportStatus): boolean {
  return status === "queued" || status === "running";
}

export function datasetExportsQuery(api: Api, id: string, limit = EXPORT_HISTORY_LIMIT) {
  return queryOptions({
    queryKey: exportKeys.list(id),
    queryFn: async ({ signal, client, queryKey }) => {
      const { items } = await data(
        api.client.GET("/api/v1/datasets/{dataset_id}/exports", { params: { path: { dataset_id: id }, query: { limit } }, signal }),
      );
      // The backend finishes the gallery handoff before reporting success.
      // Refresh cached sources even if polling picked up the completion without SSE.
      const previous = client.getQueryData<DatasetExport[]>(queryKey);
      if (previous?.some((prior) => isActiveExport(prior.status) && items.some((item) => item.export_id === prior.export_id && item.status === "succeeded"))) {
        void invalidateLibrary(client);
      }
      return items;
    },
    refetchInterval: (query) => (query.state.data?.some((item) => isActiveExport(item.status)) ? EXPORT_POLL_MS : false),
  });
}

/** 只算计划：目标路径、文件名、冲突、标注样例、总字节。不写任何文件。 */
export async function previewExport(api: Api, id: string, body: Omit<ExportRequest, "dry_run">): Promise<ExportPlan> {
  const result = await data(
    api.client.POST("/api/v1/datasets/{dataset_id}/exports", { params: { path: { dataset_id: id } }, body: { ...body, dry_run: true } }),
  );
  if (!result.plan) throw new TypeError("export_plan_missing");
  return result.plan;
}

export async function startExport(api: Api, id: string, body: Omit<ExportRequest, "dry_run">): Promise<DatasetExport> {
  const result = await data(
    api.client.POST("/api/v1/datasets/{dataset_id}/exports", { params: { path: { dataset_id: id } }, body: { ...body, dry_run: false } }),
  );
  if (!result.job) throw new TypeError("export_job_missing");
  return result.job;
}

export function cancelExport(api: Api, exportId: string): Promise<DatasetExport> {
  return data(api.client.POST("/api/v1/exports/{export_id}/cancel", { params: { path: { export_id: exportId } } }));
}

/** 续传中断的导出，或目标名字被占用而失败、腾出名字之后的导出（`resumable` 为真时）。 */
export function resumeExport(api: Api, exportId: string): Promise<DatasetExport> {
  return data(api.client.POST("/api/v1/exports/{export_id}/resume", { params: { path: { export_id: exportId } } }));
}

/** 写回一条导出记录（开始、取消、续传的响应），列表里没有时插到最前面。 */
export function upsertExport(client: QueryClient, item: DatasetExport): void {
  client.setQueryData<DatasetExport[]>(exportKeys.list(item.dataset_id), (items) => {
    if (!items) return [item];
    const index = items.findIndex((existing) => existing.export_id === item.export_id);
    if (index < 0) return [item, ...items];
    return items.map((existing, position) => (position === index ? item : existing));
  });
  if (isActiveExport(item.status)) {
    // A user may leave before the history observes completion. Mark the
    // cached gallery stale now so its next mount fetches instead of reusing it.
    void client.invalidateQueries({ queryKey: libraryKeys.all, refetchType: "none" });
  }
}

export function invalidateExports(client: QueryClient, id: string): Promise<void> {
  return client.invalidateQueries({ queryKey: exportKeys.list(id) });
}
