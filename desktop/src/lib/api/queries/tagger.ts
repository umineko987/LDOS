// 打标查询：模型表（/tagger/models）、候选分数（带 ETag）、运行 tag 阶段、取消。
//
// 候选分数是打标页实时阈值的输入，体量大（每张图每个模型几十到几百行），带 ETag：
// 再次请求时带上 If-None-Match，后端回 304 就沿用缓存里的同一个对象，页面上由它派生的索引不会重建。
// /tagger/models 没有响应模型，这里逐项消毒。

import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";
import type { components } from "../schema.d.ts";

type Schemas = components["schemas"];

export type TaggerCandidates = Schemas["TaggerCandidatesResponse"];
export type TagStageRunRequest = Schemas["TagStageRunRequest"];
export type DatasetStageRun = Schemas["DatasetStageRunResponse"];

export interface TaggerModel {
  readonly key: string;
  readonly repo: string;
  readonly adapter: string;
  readonly gated: boolean;
  readonly license: string;
  readonly default_thresholds: Readonly<Record<string, number>>;
  readonly installed: boolean;
}

export interface CandidatesSnapshot {
  readonly etag: string | null;
  readonly candidates: TaggerCandidates;
}

/** 后端的候选下限（CANDIDATE_FLOOR）：阈值滑块不能低于它。 */
export const CANDIDATE_FLOOR = 0.01;

export const taggerKeys = {
  all: ["tagger"] as const,
  models: () => [...taggerKeys.all, "models"] as const,
  /** 一个数据集所有候选查询（各种模型组合）的公共前缀。 */
  candidatesAll: (datasetId: string) => [...taggerKeys.all, "candidates", datasetId] as const,
  candidates: (datasetId: string, models: readonly string[], floor = CANDIDATE_FLOOR) =>
    [...taggerKeys.candidatesAll(datasetId), { models: [...models], floor }] as const,
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function thresholds(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record(value) ?? {})) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return result;
}

/** 逐项消毒 GET /tagger/models：没有 key 的项丢掉，其余字段缺了给默认值。 */
export function sanitizeTaggerModels(value: unknown): TaggerModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): TaggerModel[] => {
    const item = record(raw);
    if (!item || typeof item.key !== "string" || !item.key) return [];
    const text = (field: unknown) => (typeof field === "string" ? field : "");
    return [
      {
        key: item.key,
        repo: text(item.repo),
        adapter: text(item.adapter),
        gated: item.gated === true,
        license: text(item.license),
        default_thresholds: thresholds(item.default_thresholds),
        installed: item.installed === true,
      },
    ];
  });
}

export function taggerModelsQuery(api: Api) {
  return queryOptions({
    queryKey: taggerKeys.models(),
    queryFn: async ({ signal }): Promise<TaggerModel[]> =>
      sanitizeTaggerModels(await data(api.client.GET("/api/v1/tagger/models", { signal }))),
  });
}

export function candidatesQuery(api: Api, datasetId: string, models: readonly string[], floor = CANDIDATE_FLOOR) {
  const queryKey = taggerKeys.candidates(datasetId, models, floor);
  return queryOptions({
    queryKey,
    enabled: models.length > 0,
    queryFn: async ({ signal, client }): Promise<CandidatesSnapshot> => {
      const previous = client.getQueryData<CandidatesSnapshot>(queryKey);
      try {
        const result = await api.client.GET("/api/v1/datasets/{dataset_id}/tagger/candidates", {
          params: {
            path: { dataset_id: datasetId },
            query: { models: models.join(","), floor },
            header: previous?.etag ? { "if-none-match": previous.etag } : undefined,
          },
          signal,
        });
        // openapi-fetch 把定长元组 [下标, 分数] 推成 number[]；后端总是两项。
        const candidates = (await data(Promise.resolve(result))) as TaggerCandidates;
        return { etag: result.response.headers.get("ETag"), candidates };
      } catch (error) {
        if (previous && isApiError(error) && error.status === 304) return previous;
        throw error;
      }
    },
  });
}

/** 对 tag 阶段的输入跑推理（已缓存的分数不重算）。202，返回阶段运行记录，`ref_id` 是任务 id。 */
export function runTagStage(api: Api, datasetId: string, body: TagStageRunRequest): Promise<DatasetStageRun> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/stages/tag/run", { params: { path: { dataset_id: datasetId } }, body }),
  );
}

export async function cancelTagger(api: Api): Promise<void> {
  await data(api.client.POST("/api/v1/tagger/cancel"));
}

/** 推理结束、输入变化后让候选重新拉取（有 ETag，没变时只是一次 304）。 */
export function invalidateCandidates(client: QueryClient, datasetId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: taggerKeys.candidatesAll(datasetId) });
}
