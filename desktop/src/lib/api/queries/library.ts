// 图库查询（desktop 视图）：来源、扫描、逐级目录、搜索、回收区，以及改名、回收、撤销、TXT 读写。
// 采集阶段「从图库添加」的目录选择器也用这里的来源列表和目录查询。键都放在 libraryKeys.all 下面，
// 文件操作（回收、撤销、恢复、改名）之后让 libraryKeys.all 整体失效：目录计数、来源计数、回收区都会变。

import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import type { components } from "../schema";

type Schemas = components["schemas"];

export type LibrarySource = Schemas["GallerySourceResponse"];
export type LibraryDirectory = Schemas["GalleryDirectoryEntryResponse"];
export type LibraryAsset = Schemas["GalleryAssetEntryResponse"];
export type LibraryDirectoryPage = Schemas["GalleryDirectoryPageResponse"];
export type LibraryAncestor = Schemas["GalleryDirectoryAncestorResponse"];
export type LibraryScan = Schemas["GalleryScanOperationResponse"];
export type LibrarySearchPage = Schemas["GallerySearchPageResponse"];
export type LibrarySearchScope = LibrarySearchPage["scope"];
export type LibraryTrashOperation = Schemas["GalleryTrashOperationResponse"];
export type LibraryTrashPage = Schemas["GalleryTrashPageResponse"];
export type LibraryFileOperation = Schemas["GalleryFileOperationResponse"];
export type LibraryTrashRequest = Schemas["GalleryTrashRequest"];
export type LibraryPurgeAll = Schemas["GalleryPurgeAllTrashResponse"];
export type LibraryAnnotation = Schemas["GalleryAnnotationResponse"];
export type LibraryAnnotationPut = Schemas["GalleryAnnotationPutRequest"];
export type LibraryImport = Schemas["GalleryImportRequest"];

/** 浏览页的筛选：`includeDescendants` 时图片包括所有子文件夹里的。 */
export interface EntriesFilter {
  readonly includeDescendants?: boolean;
}

/** 搜索范围：`directory` 搜当前文件夹（含子文件夹），`source` 搜整个来源，`library` 搜全部图库。 */
export interface SearchParams {
  readonly query: string;
  readonly scope: LibrarySearchScope;
  readonly sourceId?: string;
  readonly directoryId?: string;
}

/** 目录选择器每页的子目录数（接口上限 200）。 */
export const DIRECTORY_PAGE_SIZE = 200;
/** 浏览页每页的条数（子目录和图片各自最多这么多）。 */
export const ENTRIES_PAGE_SIZE = 200;
export const TRASH_PAGE_SIZE = 50;

const entriesFilterKey = (filter: EntriesFilter) => ({ includeDescendants: filter.includeDescendants ?? false });

function searchKey(params: SearchParams) {
  const scope = params.scope;
  return {
    query: params.query.trim(),
    scope,
    sourceId: scope === "library" ? null : (params.sourceId ?? null),
    directoryId: scope === "directory" ? (params.directoryId ?? null) : null,
  };
}

export const libraryKeys = {
  all: ["library"] as const,
  sources: () => [...libraryKeys.all, "sources"] as const,
  /** 一个来源的详情和扫描状态的公共前缀。 */
  source: (sourceId: string) => [...libraryKeys.all, "source", sourceId] as const,
  scan: (sourceId: string) => [...libraryKeys.source(sourceId), "scan"] as const,
  directory: (directoryId: string) => [...libraryKeys.all, "directory", directoryId] as const,
  /** 一个目录所有浏览页（各种筛选）的公共前缀。 */
  entriesAll: (directoryId: string) => [...libraryKeys.all, "entries", directoryId] as const,
  entries: (directoryId: string, filter: EntriesFilter = {}) =>
    [...libraryKeys.entriesAll(directoryId), entriesFilterKey(filter)] as const,
  /** 这个目录的上级，从来源根目录到父目录（面包屑）。 */
  path: (directoryId: string) => [...libraryKeys.all, "path", directoryId] as const,
  searchAll: () => [...libraryKeys.all, "search"] as const,
  search: (params: SearchParams) => [...libraryKeys.searchAll(), searchKey(params)] as const,
  trash: () => [...libraryKeys.all, "trash"] as const,
  annotation: (assetId: string) => [...libraryKeys.all, "annotation", assetId] as const,
};

const sourcePath = (source_id: string) => ({ params: { path: { source_id } } });
const assetPath = (asset_id: string) => ({ params: { path: { asset_id } } });
const operationPath = (operation_id: string) => ({ params: { path: { operation_id } } });

/** 缩略图和原图的接口路径（交给 `api.resourceUrl()`）。 */
export function assetThumbnailPath(assetId: string, size = 256): string {
  return `/api/v1/gallery/assets/${encodeURIComponent(assetId)}/thumbnail?size=${size}`;
}

export function assetContentPath(assetId: string): string {
  return `/api/v1/gallery/assets/${encodeURIComponent(assetId)}/content`;
}

// ---- 来源 ----

export function librarySourcesQuery(api: Api) {
  return queryOptions({
    queryKey: libraryKeys.sources(),
    queryFn: async ({ signal }) =>
      (await data(api.client.GET("/api/v1/gallery/sources", { params: { query: { view: "desktop" } }, signal })))
        .sources,
  });
}

export function librarySourceQuery(api: Api, sourceId: string) {
  return queryOptions({
    queryKey: libraryKeys.source(sourceId),
    queryFn: ({ signal }) =>
      data(
        api.client.GET("/api/v1/gallery/sources/{source_id}", {
          params: { path: { source_id: sourceId }, query: { view: "desktop" } },
          signal,
        }),
      ),
  });
}

export function libraryScanQuery(api: Api, sourceId: string) {
  return queryOptions({
    queryKey: libraryKeys.scan(sourceId),
    queryFn: ({ signal }) =>
      data(
        api.client.GET("/api/v1/gallery/sources/{source_id}/scan", {
          params: { path: { source_id: sourceId }, query: { view: "desktop" } },
          signal,
        }),
      ),
  });
}

/** 后台扫描（202）；进度走任务 `scan:{source_id}`，结束后重拉来源。 */
export function startScan(api: Api, sourceId: string): Promise<LibraryScan> {
  return data(api.client.POST("/api/v1/gallery/sources/{source_id}/scan", sourcePath(sourceId)));
}

export function importSource(api: Api, body: LibraryImport): Promise<LibrarySource> {
  return data(api.client.POST("/api/v1/gallery/imports", { body }));
}

/** 离线来源指到新的根目录。 */
export function relinkSource(api: Api, sourceId: string, rootPath: string): Promise<LibrarySource> {
  return data(
    api.client.POST("/api/v1/gallery/sources/{source_id}/relink", { ...sourcePath(sourceId), body: { root_path: rootPath } }),
  );
}

/** 移出图库；`deleteFiles` 时连磁盘上的文件一起删。 */
export async function removeSource(api: Api, sourceId: string, deleteFiles = false): Promise<void> {
  await data(
    api.client.DELETE("/api/v1/gallery/sources/{source_id}", {
      params: { path: { source_id: sourceId }, query: { delete_files: deleteFiles } },
    }),
  );
}

// ---- 目录 ----

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

/**
 * 浏览页的两路游标：子目录和图片在同一个接口里各自翻页。`false` 表示这一路已经取完，
 * 之后的页不再带它的游标，接口照常返回的第一页内容也丢掉。
 */
export interface EntriesCursor {
  readonly directories: string | null | false;
  readonly assets: string | null | false;
}

export function nextEntriesCursor(last: LibraryDirectoryPage, param: EntriesCursor): EntriesCursor | undefined {
  const directories = param.directories === false ? false : (last.directory_cursor ?? false);
  const assets = param.assets === false ? false : (last.asset_cursor ?? false);
  return directories === false && assets === false ? undefined : { directories, assets };
}

/** 浏览页：子目录和图片一起翻页。页面把各页的 `directories`、`assets` 拼起来。 */
export function libraryEntriesQuery(api: Api, directoryId: string, filter: EntriesFilter = {}, limit = ENTRIES_PAGE_SIZE) {
  const key = entriesFilterKey(filter);
  return infiniteQueryOptions({
    queryKey: libraryKeys.entries(directoryId, filter),
    initialPageParam: { directories: null, assets: null } as EntriesCursor,
    getNextPageParam: (last: LibraryDirectoryPage, _pages: LibraryDirectoryPage[], param: EntriesCursor) =>
      nextEntriesCursor(last, param),
    queryFn: async ({ pageParam, signal }) => {
      const page = await data(
        api.client.GET("/api/v1/gallery/directories/{directory_id}/entries", {
          params: {
            path: { directory_id: directoryId },
            query: {
              view: "desktop",
              include_descendants: key.includeDescendants,
              directory_cursor: pageParam.directories || null,
              asset_cursor: pageParam.assets || null,
              limit,
            },
          },
          signal,
        }),
      );
      return {
        ...page,
        directories: pageParam.directories === false ? [] : page.directories,
        assets: pageParam.assets === false ? [] : page.assets,
      };
    },
  });
}

/** 目录的上级，从来源根目录到父目录，不含它自己；根目录是空数组。目录不会改名，缓存一分钟。 */
export function libraryPathQuery(api: Api, directoryId: string) {
  return queryOptions({
    queryKey: libraryKeys.path(directoryId),
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<LibraryAncestor[]> =>
      (
        await data(
          api.client.GET("/api/v1/gallery/directories/{directory_id}/ancestors", {
            params: { path: { directory_id: directoryId } },
            signal,
          }),
        )
      ).ancestors,
  });
}

/** 按文件名搜索，按 `asset_cursor` 翻页。搜当前文件夹时包括子文件夹。 */
export function librarySearchQuery(api: Api, params: SearchParams, limit = ENTRIES_PAGE_SIZE) {
  const key = searchKey(params);
  return infiniteQueryOptions({
    queryKey: libraryKeys.search(params),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LibrarySearchPage) => last.asset_cursor ?? undefined,
    queryFn: ({ pageParam, signal }) =>
      data(
        api.client.GET("/api/v1/gallery/search", {
          params: {
            query: {
              view: "desktop",
              query: key.query,
              scope: key.scope,
              source_id: key.sourceId,
              directory_id: key.directoryId,
              include_descendants: key.scope === "directory",
              asset_cursor: pageParam,
              limit,
            },
          },
          signal,
        }),
      ),
  });
}

// ---- 文件操作 ----

/** 移到回收区；返回的 `operation_id` 可以撤销（{@link undoOperation}）或在回收区里恢复。 */
export function trashItems(api: Api, body: LibraryTrashRequest): Promise<LibraryFileOperation> {
  return data(api.client.POST("/api/v1/gallery/file-operations/trash", { body }));
}

export function undoOperation(api: Api, operationId: string): Promise<LibraryFileOperation> {
  return data(api.client.POST("/api/v1/gallery/file-operations/{operation_id}/undo", operationPath(operationId)));
}

/** 改文件名（只改主名，扩展名和同名 TXT 由后端跟着处理）。 */
export function renameAsset(api: Api, assetId: string, newStem: string): Promise<LibraryFileOperation> {
  return data(api.client.POST("/api/v1/gallery/assets/{asset_id}/rename", { ...assetPath(assetId), body: { new_stem: newStem } }));
}

export function libraryAnnotationQuery(api: Api, assetId: string) {
  return queryOptions({
    queryKey: libraryKeys.annotation(assetId),
    queryFn: ({ signal }) =>
      data(
        api.client.GET("/api/v1/gallery/assets/{asset_id}/annotation", {
          params: { path: { asset_id: assetId }, query: { view: "desktop" } },
          signal,
        }),
      ),
  });
}

/** 写同名 TXT；版本不符（文件在别处改过）时后端回 409。 */
export function saveAnnotation(api: Api, assetId: string, body: LibraryAnnotationPut): Promise<LibraryAnnotation> {
  return data(api.client.PUT("/api/v1/gallery/assets/{asset_id}/annotation", { ...assetPath(assetId), body }));
}

// ---- 回收区 ----

/** 回收区按操作分组（一次回收一行），新的在前，按 `next_cursor` 翻页。 */
export function libraryTrashQuery(api: Api, limit = TRASH_PAGE_SIZE) {
  return infiniteQueryOptions({
    queryKey: libraryKeys.trash(),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LibraryTrashPage) => last.next_cursor ?? undefined,
    queryFn: ({ pageParam, signal }) =>
      data(api.client.GET("/api/v1/gallery/trash", { params: { query: { view: "desktop", cursor: pageParam, limit } }, signal })),
  });
}

export function restoreTrash(api: Api, operationId: string): Promise<LibraryFileOperation> {
  return data(api.client.POST("/api/v1/gallery/trash/{operation_id}/restore", operationPath(operationId)));
}

/** 永久删除一组（不可撤销）。 */
export function purgeTrash(api: Api, operationId: string): Promise<LibraryFileOperation> {
  return data(api.client.DELETE("/api/v1/gallery/trash/{operation_id}", operationPath(operationId)));
}

export function emptyTrash(api: Api): Promise<LibraryPurgeAll> {
  return data(api.client.DELETE("/api/v1/gallery/trash"));
}

// ---- 缓存 ----

/** 文件操作（回收、撤销、恢复、删除、改名、扫描结束）之后：图库的查询全部重新拉。 */
export function invalidateLibrary(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: libraryKeys.all });
}
