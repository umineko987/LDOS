// 数据集查询：/api/v1/datasets 及其子资源（漏斗、根目录、成员、决定、阶段运行、哈希、在线采集）。
// 这些接口都声明了响应模型，直接用 schema.d.ts 生成的类型，不再另做消毒。
//
// 键的层级：["datasets", "item", id, ...] 下挂一个数据集的所有子资源，
// 收到 dataset.updated 时按 {@link datasetInvalidation} 让对应的键失效。
// 别的阶段（清洗、打标、地图）的查询可以把键放在 `datasetKeys.dataset(id)` 下面，随数据集一起失效；
// 体量大、自己有 ETag 的（captions、atlas）建议放在别处，自己订阅对应事件。

import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/svelte-query";

import type { DomainEvents } from "#lib/events/bus.ts";

import { data, idempotent, type Api } from "../client.ts";
import type { components } from "../schema";

type Schemas = components["schemas"];

export type DatasetSummary = Schemas["DatasetSummaryResponse"];
export type DatasetDetail = Schemas["DatasetDetailResponse"];
export type DatasetKind = DatasetDetail["kind"];
export type DatasetFunnel = Schemas["DatasetFunnelResponse"];
export type FunnelStage = Schemas["DatasetFunnelStageResponse"];
export type DatasetStage = FunnelStage["stage"];
export type DatasetRoot = Schemas["DatasetRootResponse"];
export type DatasetMember = Schemas["DatasetMemberResponse"];
export type DatasetMemberPage = Schemas["DatasetMemberPageResponse"];
export type DatasetStageRun = Schemas["DatasetStageRunResponse"];
export type DatasetHashing = Schemas["DatasetHashingResponse"];
export type DatasetCrawl = Schemas["DatasetCrawlResponse"];
export type DatasetCreate = Schemas["DatasetCreateRequest"];
export type DatasetPatch = Schemas["DatasetPatchRequest"];
export type DatasetRootCreate = Schemas["DatasetRootCreateRequest"];
export type DatasetDecisionRequest = Schemas["DatasetDecisionRequest"];
export type DatasetDecisionResult = Schemas["DatasetDecisionResponse"];
export type DatasetCrawlRequest = Schemas["CrawlRequest"];

export const DATASET_KINDS = ["character", "style", "concept"] as const satisfies readonly DatasetKind[];

/** 成员列表的过滤条件；按决定过滤时必须同时给阶段（后端规则）。 */
export interface MemberFilter {
  readonly stage?: DatasetStage;
  readonly decision?: "excluded" | "approved" | "undecided";
  readonly query?: string;
}

/** 成员每页条数：一屏大约 40–80 张，两三页就够滚动预取。 */
export const MEMBER_PAGE_SIZE = 200;

function memberFilterKey(filter: MemberFilter) {
  const query = filter.query?.trim() ?? "";
  return { stage: filter.stage ?? null, decision: filter.stage ? (filter.decision ?? null) : null, query };
}

export const datasetKeys = {
  all: ["datasets"] as const,
  list: () => [...datasetKeys.all, "list"] as const,
  /** 一个数据集所有子资源的公共前缀。 */
  dataset: (id: string) => [...datasetKeys.all, "item", id] as const,
  detail: (id: string) => [...datasetKeys.dataset(id), "detail"] as const,
  funnel: (id: string) => [...datasetKeys.dataset(id), "funnel"] as const,
  roots: (id: string) => [...datasetKeys.dataset(id), "roots"] as const,
  /** 所有成员列表（各种过滤条件）的公共前缀。 */
  membersAll: (id: string) => [...datasetKeys.dataset(id), "members"] as const,
  members: (id: string, filter: MemberFilter = {}) => [...datasetKeys.membersAll(id), memberFilterKey(filter)] as const,
  stageRunsAll: (id: string) => [...datasetKeys.dataset(id), "stage-runs"] as const,
  stageRuns: (id: string, stage?: DatasetStage) => [...datasetKeys.stageRunsAll(id), stage ?? null] as const,
  hashing: (id: string) => [...datasetKeys.dataset(id), "hashing"] as const,
  crawls: (id: string) => [...datasetKeys.dataset(id), "crawls"] as const,
};

const path = (dataset_id: string) => ({ params: { path: { dataset_id } } });

export function datasetListQuery(api: Api) {
  return queryOptions({
    queryKey: datasetKeys.list(),
    queryFn: async ({ signal }) => (await data(api.client.GET("/api/v1/datasets", { signal }))).items,
  });
}

export function datasetDetailQuery(api: Api, id: string) {
  return queryOptions({
    queryKey: datasetKeys.detail(id),
    queryFn: ({ signal }) => data(api.client.GET("/api/v1/datasets/{dataset_id}", { ...path(id), signal })),
  });
}

export function datasetFunnelQuery(api: Api, id: string) {
  return queryOptions({
    queryKey: datasetKeys.funnel(id),
    queryFn: ({ signal }) => data(api.client.GET("/api/v1/datasets/{dataset_id}/funnel", { ...path(id), signal })),
  });
}

export function datasetRootsQuery(api: Api, id: string) {
  return queryOptions({
    queryKey: datasetKeys.roots(id),
    queryFn: async ({ signal }) =>
      (await data(api.client.GET("/api/v1/datasets/{dataset_id}/roots", { ...path(id), signal }))).items,
  });
}

/** 成员分页：`next_cursor` 为 null 时到底。页面把 `pages.flatMap(p => p.items)` 交给网格。 */
export function datasetMembersQuery(api: Api, id: string, filter: MemberFilter = {}, limit = MEMBER_PAGE_SIZE) {
  const key = memberFilterKey(filter);
  return infiniteQueryOptions({
    queryKey: datasetKeys.members(id, filter),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DatasetMemberPage) => last.next_cursor ?? undefined,
    queryFn: ({ pageParam, signal }) =>
      data(
        api.client.GET("/api/v1/datasets/{dataset_id}/members", {
          params: {
            path: { dataset_id: id },
            query: {
              stage: key.stage,
              decision: key.decision,
              query: key.query || null,
              cursor: pageParam,
              limit,
            },
          },
          signal,
        }),
      ),
  });
}

export function datasetStageRunsQuery(api: Api, id: string, stage?: DatasetStage, limit = 50) {
  return queryOptions({
    queryKey: datasetKeys.stageRuns(id, stage),
    queryFn: async ({ signal }) =>
      (
        await data(
          api.client.GET("/api/v1/datasets/{dataset_id}/stage-runs", {
            params: { path: { dataset_id: id }, query: { stage: stage ?? null, limit } },
            signal,
          }),
        )
      ).items,
  });
}

export function datasetHashingQuery(api: Api, id: string) {
  return queryOptions({
    queryKey: datasetKeys.hashing(id),
    queryFn: ({ signal }) => data(api.client.GET("/api/v1/datasets/{dataset_id}/hashing", { ...path(id), signal })),
  });
}

export function datasetCrawlsQuery(api: Api, id: string) {
  return queryOptions({
    queryKey: datasetKeys.crawls(id),
    queryFn: async ({ signal }) =>
      (await data(api.client.GET("/api/v1/datasets/{dataset_id}/crawls", { ...path(id), signal }))).items,
  });
}

// ---- 写操作：组件里配合 createMutation 使用，成功后按需调 applyFunnel / invalidate ----

export function createDataset(api: Api, body: DatasetCreate): Promise<DatasetDetail> {
  return data(api.client.POST("/api/v1/datasets", { body }));
}

export function updateDataset(api: Api, id: string, body: DatasetPatch): Promise<DatasetDetail> {
  return data(api.client.PATCH("/api/v1/datasets/{dataset_id}", { ...path(id), body }));
}

export async function deleteDataset(api: Api, id: string): Promise<void> {
  await api.client.DELETE("/api/v1/datasets/{dataset_id}", path(id));
}

export function addDatasetRoot(api: Api, id: string, body: DatasetRootCreate): Promise<DatasetRoot> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/roots", { ...path(id), body }));
}

export async function removeDatasetRoot(api: Api, id: string, rootId: string): Promise<void> {
  await api.client.DELETE("/api/v1/datasets/{dataset_id}/roots/{root_id}", {
    params: { path: { dataset_id: id, root_id: rootId } },
  });
}

export function decideMembers(api: Api, id: string, body: DatasetDecisionRequest): Promise<DatasetDecisionResult> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/decisions", { ...path(id), body }));
}

export function startHashing(api: Api, id: string): Promise<DatasetHashing> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/hashing", path(id)));
}

/** 幂等键由调用方在一次提交里生成一次，重试时复用（见 createIdempotencyKey）。 */
export function startDatasetCrawl(
  api: Api,
  id: string,
  body: DatasetCrawlRequest,
  idempotencyKey: string,
): Promise<DatasetCrawl> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/crawls", { ...path(id), body, headers: idempotent(idempotencyKey) }),
  );
}

// ---- 缓存 ----

/** 决定接口顺带返回新漏斗：直接写进漏斗和详情缓存，轨道计数不用等重新请求。 */
export function applyFunnel(client: QueryClient, funnel: DatasetFunnel): void {
  const id = funnel.dataset_id;
  client.setQueryData(datasetKeys.funnel(id), funnel);
  client.setQueryData<DatasetDetail>(datasetKeys.detail(id), (detail) =>
    detail
      ? {
          ...detail,
          member_count: funnel.member_count,
          funnel: funnel.stages,
          stage_outputs: funnel.stages.map(({ stage, output, stale }) => ({ stage, output, stale })),
          output_count: funnel.stages.at(-1)?.output ?? detail.output_count,
        }
      : detail,
  );
}

/** 只改了元数据或 caption 的 dataset.updated（reason 见 dataset_service.publish_updated）：成员、根目录都没变。 */
const METADATA_ONLY = new Set(["updated", "captions"]);

export type DatasetEventKind = "dataset.updated" | "dataset.stage.updated" | "resync";

/**
 * 一条领域事件要让哪些查询失效（TanStack 按前缀匹配）。列表、详情、漏斗、阶段运行总是刷新；
 * 成员列表（可能有好几页）、根目录、哈希、采集只在成员或决定可能变化时才刷新。
 */
export function datasetInvalidation<K extends DatasetEventKind>(
  kind: K,
  event: DomainEvents[K],
): readonly (readonly unknown[])[] {
  if (kind === "resync") return [datasetKeys.all];
  const { dataset_id: id } = event as DomainEvents["dataset.updated"];
  const reason = kind === "dataset.updated" ? (event as DomainEvents["dataset.updated"]).reason : undefined;
  if (reason === "deleted") return [datasetKeys.list(), datasetKeys.dataset(id)];
  const keys: (readonly unknown[])[] = [
    datasetKeys.list(),
    datasetKeys.detail(id),
    datasetKeys.funnel(id),
    datasetKeys.stageRunsAll(id),
  ];
  if (reason !== undefined && METADATA_ONLY.has(reason)) return keys;
  return [...keys, datasetKeys.roots(id), datasetKeys.hashing(id), datasetKeys.crawls(id), datasetKeys.membersAll(id)];
}

/** 让事件对应的查询失效；数据集被删时顺带丢掉它的缓存，不再重新请求。 */
export function invalidateForDatasetEvent<K extends DatasetEventKind>(
  client: QueryClient,
  kind: K,
  event: DomainEvents[K],
): void {
  if (kind === "dataset.updated" && (event as DomainEvents["dataset.updated"]).reason === "deleted") {
    const id = (event as DomainEvents["dataset.updated"]).dataset_id;
    client.removeQueries({ queryKey: datasetKeys.dataset(id) });
  }
  for (const queryKey of datasetInvalidation(kind, event)) void client.invalidateQueries({ queryKey });
}
