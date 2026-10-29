// 模型表和下载设置：/api/v1/models、/api/v1/models/install、/api/v1/settings/downloads。
// 三个接口都有响应模型，类型直接来自 schema.d.ts。

import { queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import type { components } from "../schema.d.ts";

type Schemas = components["schemas"];

/** openapi-typescript 把带默认值的字段标成必填；调用方可以省略，发请求前补上默认值。 */
type Defaulted<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type ModelList = Schemas["ModelList"];
export type ModelInstallBody = Defaulted<Schemas["ModelInstallBody"], "accept_license">;
export type ModelInstallResponse = Schemas["ModelInstallResponse"];
export type DownloadSettings = Schemas["DownloadSettingsView"];
export type DownloadSettingsUpdate = Defaulted<Schemas["DownloadSettingsUpdate"], "clear_hf_token">;

export const modelKeys = {
  all: ["models"] as const,
  list: () => [...modelKeys.all, "list"] as const,
  downloads: () => ["settings", "downloads"] as const,
};

export function modelsQuery(api: Api) {
  return queryOptions({
    queryKey: modelKeys.list(),
    queryFn: async ({ signal }): Promise<ModelList> => data(api.client.GET("/api/v1/models", { signal })),
  });
}

/** 202：返回启动了哪些安装 job，以及更新后的整张模型表。 */
export function installModels(api: Api, body: ModelInstallBody): Promise<ModelInstallResponse> {
  return data(api.client.POST("/api/v1/models/install", { body: { accept_license: false, ...body } }));
}

export function downloadSettingsQuery(api: Api) {
  return queryOptions({
    queryKey: modelKeys.downloads(),
    queryFn: async ({ signal }): Promise<DownloadSettings> => data(api.client.GET("/api/v1/settings/downloads", { signal })),
  });
}

/** 只更新 body 里出现的字段；`hf_token` 只写，响应里只有 `token_set` 和末四位提示。 */
export function updateDownloadSettings(api: Api, body: DownloadSettingsUpdate): Promise<DownloadSettings> {
  return data(api.client.PUT("/api/v1/settings/downloads", { body: { clear_hf_token: false, ...body } }));
}
