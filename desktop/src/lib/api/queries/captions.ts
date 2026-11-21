// 数据集 caption 查询：列表（带 ETag）、单张编辑、批量操作、从打标写入、批次历史和撤销。
// 再次请求带上 If-None-Match，后端回 304 就沿用缓存。写操作发 captions.updated 事件，
// 由 useCaptionEvents（captions-live.svelte.ts）让列表和批次历史失效。

import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";
import type { components } from "../schema.d.ts";

type Schemas = components["schemas"];

export type CaptionList = Schemas["CaptionListResponse"];
export type CaptionItem = Schemas["CaptionItem"];
export type CaptionEditRequest = Schemas["CaptionEditRequest"];
export type CaptionEditResponse = Schemas["CaptionEditResponse"];
export type CaptionOpsRequest = Schemas["CaptionOpsRequest"];
export type CaptionsFromTaggerRequest = Schemas["CaptionsFromTaggerRequest"];
export type CaptionBatchResult = Schemas["CaptionBatchResult"];
export type CaptionBatchSummary = Schemas["CaptionBatchSummary"];
export type CaptionDiffSample = Schemas["CaptionDiffSample"];
export type CaptionUndoResponse = Schemas["CaptionUndoResponse"];

export interface CaptionsSnapshot {
  readonly etag: string | null;
  readonly list: CaptionList;
}

/** 批次历史默认取的条数。 */
export const CAPTION_BATCH_LIMIT = 20;

export const captionKeys = {
  all: ["captions"] as const,
  dataset: (datasetId: string) => [...captionKeys.all, datasetId] as const,
  list: (datasetId: string) => [...captionKeys.dataset(datasetId), "list"] as const,
  batches: (datasetId: string) => [...captionKeys.dataset(datasetId), "batches"] as const,
};

const path = (dataset_id: string) => ({ path: { dataset_id } });

/** caption 列表不带图片地址：缩略图和原图按 asset id 走图库接口。 */
export function assetThumbnailPath(assetId: string, size = 256): string {
  return `/api/v1/gallery/assets/${encodeURIComponent(assetId)}/thumbnail?size=${size}`;
}

export function assetContentPath(assetId: string): string {
  return `/api/v1/gallery/assets/${encodeURIComponent(assetId)}/content`;
}

export function captionsQuery(api: Api, datasetId: string) {
  const queryKey = captionKeys.list(datasetId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }): Promise<CaptionsSnapshot> => {
      const previous = client.getQueryData<CaptionsSnapshot>(queryKey);
      try {
        const result = await api.client.GET("/api/v1/datasets/{dataset_id}/captions", {
          params: { ...path(datasetId), header: previous?.etag ? { "if-none-match": previous.etag } : undefined },
          signal,
        });
        const list = await data(Promise.resolve(result));
        // 响应头拿不到 ETag 时（跨域没暴露）用响应体里的同一个值。
        return { etag: result.response.headers.get("ETag") ?? (list.etag || null), list };
      } catch (error) {
        // 取此刻的缓存，不用请求开始时的：请求途中写进缓存的编辑（applyCaptionEdit）不能被旧对象盖掉。
        if (previous && isApiError(error) && error.status === 304) {
          return client.getQueryData<CaptionsSnapshot>(queryKey) ?? previous;
        }
        throw error;
      }
    },
  });
}

export function captionBatchesQuery(api: Api, datasetId: string, limit = CAPTION_BATCH_LIMIT) {
  return queryOptions({
    queryKey: captionKeys.batches(datasetId),
    queryFn: async ({ signal }) =>
      (
        await data(
          api.client.GET("/api/v1/datasets/{dataset_id}/caption-batches", {
            params: { ...path(datasetId), query: { limit } },
            signal,
          }),
        )
      ).items,
  });
}


/** 改一张图的 caption；`expected_version` 对不上时 409 caption_version_conflict。 */
export function editCaption(api: Api, datasetId: string, assetId: string, body: CaptionEditRequest): Promise<CaptionEditResponse> {
  return data(
    api.client.PUT("/api/v1/datasets/{dataset_id}/captions/{asset_id}", {
      params: { path: { dataset_id: datasetId, asset_id: assetId } },
      body,
    }),
  );
}

/** 批量操作；`dry_run` 时只返回统计和差异样例，不写文件。 */
export function captionOps(api: Api, datasetId: string, body: CaptionOpsRequest): Promise<CaptionBatchResult> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/captions/ops", { params: path(datasetId), body }));
}

/** 按打标策略写入 打标阶段的 caption；`dry_run` 时只预览。 */
export function captionsFromTagger(api: Api, datasetId: string, body: CaptionsFromTaggerRequest): Promise<CaptionBatchResult> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/captions/from-tagger", { params: path(datasetId), body }));
}

export function undoCaptionBatch(api: Api, batchId: string): Promise<CaptionUndoResponse> {
  return data(api.client.POST("/api/v1/caption-batches/{batch_id}/undo", { params: { path: { batch_id: batchId } } }));
}


/** 编辑成功后把新 caption 写进列表缓存，不等事件和重新请求（ETag 留旧的，下次请求会拿到新内容）。 */
export function applyCaptionEdit(client: QueryClient, datasetId: string, response: CaptionEditResponse): void {
  const entry = response.caption;
  client.setQueryData<CaptionsSnapshot>(captionKeys.list(datasetId), (snapshot) => {
    if (!snapshot) return snapshot;
    const items = snapshot.list.items.map((item) =>
      item.asset_id === entry.asset_id
        ? { ...item, state: entry.state, text: entry.text, tags: entry.tags, version: entry.version }
        : item,
    );
    return { etag: null, list: { ...snapshot.list, items } };
  });
}

export function invalidateCaptions(client: QueryClient, datasetId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: captionKeys.dataset(datasetId) });
}
