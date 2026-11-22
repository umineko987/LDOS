// 清洗 / 去重两段的查询：运行、分诊摘要、清洗命中列表、去重分组、定夺与撤销。
//
// 键都挂在 `datasetKeys.dataset(id)` 下面（["datasets", "item", id, "triage", stage, ...]），
// 定夺 / 撤销后让整个数据集前缀失效就能连同轨道计数一起刷新（这两个接口不返回漏斗）。
// 运行状态靠 dataset.stage.updated 推送（见 triage-live.svelte.ts）；分析中另有兜底轮询。

import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/svelte-query";

import type { DomainEvents } from "#lib/events/bus.ts";

import { data, type Api } from "../client.ts";
import { isPlainRecord, ownValue } from "../sanitize.ts";
import type { components, operations } from "../schema";
import { applyFunnel, datasetKeys, type DatasetFunnel } from "./datasets.ts";

type Schemas = components["schemas"];

export type TriageStage = "clean" | "dedup";
export type StageTriageSummary = Schemas["StageTriageSummaryResponse"];
export type StageTriageCounts = Schemas["StageTriageCountsResponse"];
export type ReviewStatus = NonNullable<StageTriageSummary["review_status"]>;
export type StageRunRequest = Schemas["StageRunRequest"];
export type StageRunOptions = Schemas["StageRunOptions"];
export type TriageMember = Schemas["TriageMemberResponse"];
export type CleanItem = Schemas["CleanItemResponse"];
export type CleanItemPage = Schemas["CleanItemPageResponse"];
export type DedupGroup = Schemas["DedupGroupResponse"];
export type DedupGroupPage = Schemas["DedupGroupPageResponse"];
export type TriageGroupDecision = Schemas["TriageGroupDecision"];
export type TriageApplyRequest = Schemas["TriageApplyRequest"];
export type TriageApplyResult = Schemas["TriageApplyResponse"];
export type TriageUndoResult = Schemas["TriageUndoResponse"];

type CleanQuery = NonNullable<operations["list_dataset_clean_items_api_v1_datasets__dataset_id__stages_clean_items_get"]["parameters"]["query"]>;
export type CleanReason = NonNullable<CleanQuery["reason"]>;
export type TriageItemState = NonNullable<CleanQuery["state"]>;

export const CLEAN_REASONS = ["monochrome", "rough", "filter_character", "unreadable"] as const satisfies readonly CleanReason[];

/** 后端每页上限：清洗 200 条，去重 100 组。 */
export const CLEAN_PAGE_SIZE = 200;
export const DEDUP_PAGE_SIZE = 50;
/** 后端一次定夺最多 200 组（TriageApplyRequest.groups.maxItems）。 */
export const TRIAGE_APPLY_MAX = 200;
/** 分析中没有推送时的兜底轮询。 */
export const TRIAGE_POLL_MS = 3000;

/** 过滤器 → 需要的模型（dedup/review_filters.py 的 FILTER_MODELS）。 */
export const FILTER_MODELS = {
  filter_monochrome: "monochrome",
  filter_sketch: "completeness",
  filter_character: "ccip",
} as const;

export interface CleanFilter {
  readonly reason?: CleanReason | null;
  readonly state?: TriageItemState;
}

export interface DedupFilter {
  readonly automatic?: boolean;
  readonly state?: TriageItemState;
}

export const triageKeys = {
  all: (id: string) => [...datasetKeys.dataset(id), "triage"] as const,
  stage: (id: string, stage: TriageStage) => [...triageKeys.all(id), stage] as const,
  summary: (id: string, stage: TriageStage) => [...triageKeys.stage(id, stage), "summary"] as const,
  cleanItems: (id: string, filter: CleanFilter = {}) =>
    [...triageKeys.stage(id, "clean"), "items", { reason: filter.reason ?? null, state: filter.state ?? "all" }] as const,
  dedupGroups: (id: string, filter: DedupFilter = {}) =>
    [...triageKeys.stage(id, "dedup"), "groups", { automatic: filter.automatic ?? false, state: filter.state ?? "all" }] as const,
};

const stagePath = (dataset_id: string, stage: TriageStage) => ({ params: { path: { dataset_id, stage } } });

/** 运行还没出结果（建审核、分析、自动落地）。 */
export function isTriageRunning(summary: StageTriageSummary | undefined): boolean {
  if (!summary?.run) return false;
  if (summary.run.status === "running") return true;
  return summary.review_status === "pending" || summary.review_status === "analyzing" || summary.review_status === "auto_applying";
}

export type TriagePhase = "idle" | "running" | "ready" | "failed" | "expired";

/** 页面的大状态：没跑过、分析中、可以分诊、失败、分组失效（后端重启过）。 */
export function triagePhase(summary: StageTriageSummary | undefined): TriagePhase {
  if (!summary?.run) return "idle";
  if (isTriageRunning(summary)) return "running";
  if (summary.run.status !== "succeeded" || summary.review_status === "failed") return "failed";
  if (summary.review_status === "expired") return "expired";
  return "ready";
}

export function triageSummaryQuery(api: Api, id: string, stage: TriageStage) {
  return queryOptions({
    queryKey: triageKeys.summary(id, stage),
    queryFn: ({ signal }) =>
      data(api.client.GET("/api/v1/datasets/{dataset_id}/stages/{stage}/triage", { ...stagePath(id, stage), signal })),
    refetchInterval: (query) => (isTriageRunning(query.state.data) ? TRIAGE_POLL_MS : false),
  });
}

function nextOffset(last: { offset: number; total: number; items: readonly unknown[] }): number | undefined {
  const next = last.offset + last.items.length;
  return last.items.length > 0 && next < last.total ? next : undefined;
}

/** 清洗命中的图（每张图自己一组），按 offset 翻页。`enabled` 交给页面：只有运行成功后才有列表。 */
export function cleanItemsQuery(api: Api, id: string, filter: CleanFilter = {}, limit = CLEAN_PAGE_SIZE) {
  return infiniteQueryOptions({
    queryKey: triageKeys.cleanItems(id, filter),
    initialPageParam: 0,
    getNextPageParam: (last: CleanItemPage) => nextOffset(last),
    queryFn: ({ pageParam, signal }) =>
      data(
        api.client.GET("/api/v1/datasets/{dataset_id}/stages/clean/items", {
          params: {
            path: { dataset_id: id },
            query: { state: filter.state ?? "all", reason: filter.reason ?? null, offset: pageParam, limit },
          },
          signal,
        }),
      ),
  });
}

/** 去重分组。`automatic: true` 时连自动组一起返回（后端没有“只要自动组”的筛选）。 */
export function dedupGroupsQuery(api: Api, id: string, filter: DedupFilter = {}, limit = DEDUP_PAGE_SIZE) {
  return infiniteQueryOptions({
    queryKey: triageKeys.dedupGroups(id, filter),
    initialPageParam: 0,
    getNextPageParam: (last: DedupGroupPage) => nextOffset(last),
    queryFn: ({ pageParam, signal }) =>
      data(
        api.client.GET("/api/v1/datasets/{dataset_id}/stages/dedup/groups", {
          params: {
            path: { dataset_id: id },
            query: { state: filter.state ?? "all", include_automatic: filter.automatic ?? false, offset: pageParam, limit },
          },
          signal,
        }),
      ),
  });
}


// ---- 写操作 ----

/** 跑一次（覆盖上一次的分组）。`body` 省略时用后端默认：清洗启用黑白和草稿，去重启用基础去重和相似分组。 */
export function runTriageStage(api: Api, id: string, stage: TriageStage, body?: StageRunRequest): Promise<StageTriageSummary> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/stages/{stage}/run", { ...stagePath(id, stage), body: body ?? null }));
}

export function applyTriage(api: Api, id: string, stage: TriageStage, body: TriageApplyRequest): Promise<TriageApplyResult> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/stages/{stage}/apply", { ...stagePath(id, stage), body }));
}

/** 撤销一批定夺；不给 batchId 时撤销最近一批（只能撤最近的，后端按栈记 50 批，重启后清空）。 */
export function undoTriage(api: Api, id: string, stage: TriageStage, batchId?: string | null): Promise<TriageUndoResult> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/stages/{stage}/undo", {
      ...stagePath(id, stage),
      body: batchId ? { batch_id: batchId } : null,
    }),
  );
}

// ---- 缓存 ----

export function invalidateTriage(client: QueryClient, id: string, stage?: TriageStage): Promise<void> {
  return client.invalidateQueries({ queryKey: stage ? triageKeys.stage(id, stage) : triageKeys.all(id) });
}

/**
 * 定夺 / 撤销之后：响应里带漏斗时直接写进缓存、只刷新分诊；不带时（现在的 apply/undo 都不带）
 * 让整个数据集前缀失效（详情、漏斗、成员、分诊），再刷新首页列表的计数。
 */
export async function refreshAfterTriage(client: QueryClient, id: string, result: unknown): Promise<void> {
  const funnel = isPlainRecord(result) ? ownValue(result, "funnel") : undefined;
  if (isPlainRecord(funnel) && funnel.dataset_id === id && Array.isArray(funnel.stages)) {
    applyFunnel(client, funnel as unknown as DatasetFunnel);
    await invalidateTriage(client, id);
    return;
  }
  await Promise.all([
    client.invalidateQueries({ queryKey: datasetKeys.dataset(id) }),
    client.invalidateQueries({ queryKey: datasetKeys.list() }),
  ]);
}

/** dataset.stage.updated 里这一段的事件（导出也发这个事件，stage=export，不归这里管）。 */
export function isTriageEvent(event: DomainEvents["dataset.stage.updated"], id: string, stage: TriageStage): boolean {
  return event.dataset_id === id && event.stage === stage;
}
