// caption 查询：review 阶段输入的全部 caption（带 ETag）、单张编辑、批量操作、从打标写入、批次历史和撤销，
// 以及标签工作室要的“本阶段已校对”集合。
//
// 列表一次给全（标签工作室在浏览器里统计和过滤），带 ETag：再次请求带上 If-None-Match，
// 后端回 304 就沿用缓存里的同一个对象。写操作都会发 captions.updated 事件，
// 由 useCaptionEvents（captions-live.svelte.ts）让列表和批次历史失效。

import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";
import type { components } from "../schema.d.ts";
import { datasetKeys, decideMembers, type DatasetDecisionResult } from "./datasets.ts";

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
/** 已校对集合按这个大小翻页（成员接口的上限）。 */
export const APPROVAL_PAGE_SIZE = 500;
/** 决定接口单次最多这么多张。 */
export const DECISION_BATCH = 5000;

export const captionKeys = {
  all: ["captions"] as const,
  dataset: (datasetId: string) => [...captionKeys.all, datasetId] as const,
  list: (datasetId: string) => [...captionKeys.dataset(datasetId), "list"] as const,
  batches: (datasetId: string) => [...captionKeys.dataset(datasetId), "batches"] as const,
  /** 放在成员列表前缀下：决定变了（dataset.updated）时随成员列表一起失效。 */
  approvals: (datasetId: string) => [...datasetKeys.membersAll(datasetId), "review-approved"] as const,
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
        if (previous && isApiError(error) && error.status === 304) return previous;
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

/** review 阶段已校对的图（成员接口按决定过滤，翻完所有页）。 */
export function reviewApprovalsQuery(api: Api, datasetId: string) {
  return queryOptions({
    queryKey: captionKeys.approvals(datasetId),
    queryFn: async ({ signal }): Promise<ReadonlySet<string>> => {
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: Schemas["DatasetMemberPageResponse"] = await data(
          api.client.GET("/api/v1/datasets/{dataset_id}/members", {
            params: {
              ...path(datasetId),
              query: { stage: "review", decision: "approved", cursor, limit: APPROVAL_PAGE_SIZE },
            },
            signal,
          }),
        );
        for (const item of page.items) ids.add(item.asset_id);
        cursor = page.next_cursor ?? null;
      } while (cursor);
      return ids;
    },
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

/** 按打标策略写入 review 阶段的 caption；`dry_run` 时只预览。 */
export function captionsFromTagger(api: Api, datasetId: string, body: CaptionsFromTaggerRequest): Promise<CaptionBatchResult> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/captions/from-tagger", { params: path(datasetId), body }));
}

export function undoCaptionBatch(api: Api, batchId: string): Promise<CaptionUndoResponse> {
  return data(api.client.POST("/api/v1/caption-batches/{batch_id}/undo", { params: { path: { batch_id: batchId } } }));
}

/** 记 review 阶段的校对决定（approve）或清掉（clear）；超过单次上限时分批，返回最后一批的结果（含新漏斗）。 */
export async function decideReview(
  api: Api,
  datasetId: string,
  assetIds: readonly string[],
  decision: "approve" | "clear",
): Promise<DatasetDecisionResult | null> {
  const unique = [...new Set(assetIds)];
  let last: DatasetDecisionResult | null = null;
  let updated = 0;
  for (let start = 0; start < unique.length; start += DECISION_BATCH) {
    const batch = unique.slice(start, start + DECISION_BATCH);
    last = await decideMembers(api, datasetId, { stage: "review", decision, asset_ids: batch });
    updated += last.updated;
  }
  return last && { ...last, updated };
}

/** 本地先改已校对集合（乐观），请求失败时由调用方让它失效。 */
export function setApproved(client: QueryClient, datasetId: string, assetIds: readonly string[], approved: boolean): void {
  client.setQueryData<ReadonlySet<string>>(captionKeys.approvals(datasetId), (current) => {
    const next = new Set(current ?? []);
    for (const assetId of assetIds) {
      if (approved) next.add(assetId);
      else next.delete(assetId);
    }
    return next;
  });
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
