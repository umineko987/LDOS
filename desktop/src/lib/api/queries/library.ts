// 图库查询（desktop 视图）。目前只有采集阶段「从图库添加」的目录选择器要用：来源列表和逐级目录。
// 图库页（浏览、回收区）在这里继续加查询，键都放在 libraryKeys.all 下面。

import { infiniteQueryOptions, queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import type { components } from "../schema";

type Schemas = components["schemas"];

export type LibrarySource = Schemas["GallerySourceResponse"];
export type LibraryDirectory = Schemas["GalleryDirectoryEntryResponse"];
export type LibraryAsset = Schemas["GalleryAssetEntryResponse"];
export type LibraryDirectoryPage = Schemas["GalleryDirectoryPageResponse"];

export const libraryKeys = {
  all: ["library"] as const,
  sources: () => [...libraryKeys.all, "sources"] as const,
  directory: (directoryId: string) => [...libraryKeys.all, "directory", directoryId] as const,
};

/** 目录选择器每页的子目录数（接口上限 200）。 */
export const DIRECTORY_PAGE_SIZE = 200;

export function librarySourcesQuery(api: Api) {
  return queryOptions({
    queryKey: libraryKeys.sources(),
    queryFn: async ({ signal }) =>
      (await data(api.client.GET("/api/v1/gallery/sources", { params: { query: { view: "desktop" } }, signal })))
        .sources,
  });
}

/** 一个目录的直接子目录，按 `directory_cursor` 翻页。图片也随页返回，选择器只用目录。 */
export function libraryDirectoryQuery(api: Api, directoryId: string) {
  return infiniteQueryOptions({
    queryKey: libraryKeys.directory(directoryId),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LibraryDirectoryPage) => last.directory_cursor ?? undefined,
    queryFn: ({ pageParam, signal }) =>
      data(
        api.client.GET("/api/v1/gallery/directories/{directory_id}/entries", {
          params: {
            path: { directory_id: directoryId },
            query: { view: "desktop", directory_cursor: pageParam, limit: DIRECTORY_PAGE_SIZE },
          },
          signal,
        }),
      ),
  });
}
