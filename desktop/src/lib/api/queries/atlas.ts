// 语义地图查询：GET /datasets/{id}/atlas（带 ETag），运行、取消、移除、恢复，地图上加标签。
//
// GET 带上一次的 ETag；后端回 304 时（客户端中间件把它当成 ApiError 抛出）直接沿用缓存里的数据，
// 返回同一个对象，页面上由它派生的模型也就不会重建。
// 移除 / 恢复一次最多 5000 张（后端限制），更多时按批顺序提交。

import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import type { components } from "../schema.d.ts";
import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";

type Schemas = components["schemas"];
export type AtlasResponse = Schemas["AtlasResponse"];
export type AtlasStateResponse = Schemas["AtlasStateResponse"];
export type AtlasRunRequest = Schemas["AtlasRunRequest"];
export type DatasetDecisionResponse = Schemas["DatasetDecisionResponse"];
export type CaptionBatchResult = Schemas["CaptionBatchResult"];
export type CaptionUndoResponse = Schemas["CaptionUndoResponse"];

export interface AtlasSnapshot {
  readonly etag: string | null;
  readonly atlas: AtlasResponse;
}

export const atlasKeys = {
  all: ["atlas"] as const,
  detail: (datasetId: string) => [...atlasKeys.all, datasetId] as const,
};

/** 后端单次移除 / 恢复的上限（AtlasAssetsRequest.asset_ids.maxItems）。 */
export const ATLAS_ASSET_BATCH = 5000;
/** 运行中没有 SSE 推送时的兜底轮询间隔；有 ETag，回 304 时几乎没有开销。 */
export const ATLAS_POLL_MS = 2000;

export function atlasJobId(datasetId: string): string {
  return `atlas:${datasetId}`;
}

export function atlasQuery(api: Api, datasetId: string) {
  return queryOptions({
    queryKey: atlasKeys.detail(datasetId),
    queryFn: async ({ signal, client }): Promise<AtlasSnapshot> => {
      const previous = client.getQueryData<AtlasSnapshot>(atlasKeys.detail(datasetId));
      const headers = previous?.etag ? { "If-None-Match": previous.etag } : undefined;
      try {
        const result = await api.client.GET("/api/v1/datasets/{dataset_id}/atlas", {
          params: { path: { dataset_id: datasetId }, header: headers },
          signal,
        });
        const atlas = await data(Promise.resolve(result));
        return { etag: result.response.headers.get("ETag"), atlas };
      } catch (error) {
        if (previous && isApiError(error) && error.status === 304) return previous;
        throw error;
      }
    },
    refetchInterval: (query) => (query.state.data?.atlas.status === "running" ? ATLAS_POLL_MS : false),
  });
}

export async function runAtlas(
  api: Api,
  datasetId: string,
  body: Partial<AtlasRunRequest> = {},
): Promise<AtlasStateResponse> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/atlas/run", {
      params: { path: { dataset_id: datasetId } },
      body: { force: false, ...body },
    }),
  );
}

export async function cancelAtlas(api: Api, datasetId: string): Promise<AtlasStateResponse> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/atlas/cancel", { params: { path: { dataset_id: datasetId } } }));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

async function decideInBatches(
  api: Api,
  datasetId: string,
  path: "/api/v1/datasets/{dataset_id}/atlas/remove" | "/api/v1/datasets/{dataset_id}/atlas/restore",
  assetIds: readonly string[],
): Promise<DatasetDecisionResponse | null> {
  let last: DatasetDecisionResponse | null = null;
  let updated = 0;
  for (const batch of chunk([...new Set(assetIds)], ATLAS_ASSET_BATCH)) {
    last = await data(api.client.POST(path, { params: { path: { dataset_id: datasetId } }, body: { asset_ids: batch } }));
    updated += last.updated;
  }
  return last && { ...last, updated };
}

/** 记为去重阶段的排除（reason=atlas），不动文件。没有图时不发请求，返回 null。 */
export function removeFromAtlas(api: Api, datasetId: string, assetIds: readonly string[]) {
  return decideInBatches(api, datasetId, "/api/v1/datasets/{dataset_id}/atlas/remove", assetIds);
}

/** 只清掉 reason=atlas 的去重决定。 */
export function restoreToAtlas(api: Api, datasetId: string, assetIds: readonly string[]) {
  return decideInBatches(api, datasetId, "/api/v1/datasets/{dataset_id}/atlas/restore", assetIds);
}

/** 标签写法和标签工作室一致：去掉首尾空白、合并空白，逗号分隔多个，去重。 */
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[,，\n]/)
    .map((tag) => tag.replace(/\s+/g, " ").trim())
    .filter((tag) => tag.length > 0 && tag.length <= 512);
  return [...new Set(tags)].slice(0, 200);
}

/** 给选中的图加标签；`dryRun` 时只返回差异样例，不写文件。 */
export async function addAtlasTags(
  api: Api,
  datasetId: string,
  assetIds: readonly string[],
  tags: readonly string[],
  dryRun: boolean,
): Promise<CaptionBatchResult> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/captions/ops", {
      params: { path: { dataset_id: datasetId } },
      body: { asset_ids: [...assetIds], ops: [{ op: "add", tags: [...tags], position: "back" }], dry_run: dryRun, sample_limit: 5 },
    }),
  );
}

export async function undoCaptionBatch(api: Api, batchId: string): Promise<CaptionUndoResponse> {
  return data(api.client.POST("/api/v1/caption-batches/{batch_id}/undo", { params: { path: { batch_id: batchId } } }));
}

/** 移除、恢复、运行之后让地图重新拉取（ETag 会因为输入摘要变化而不同）。 */
export function invalidateAtlas(client: QueryClient, datasetId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: atlasKeys.detail(datasetId) });
}
