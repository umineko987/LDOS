import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  assetContentPath,
  assetThumbnailPath,
  DIRECTORY_PAGE_SIZE,
  emptyTrash,
  ENTRIES_PAGE_SIZE,
  importSource,
  invalidateLibrary,
  libraryAnnotationQuery,
  libraryDirectoryQuery,
  libraryEntriesQuery,
  libraryKeys,
  libraryPathQuery,
  libraryScanQuery,
  librarySearchQuery,
  librarySourceQuery,
  librarySourcesQuery,
  libraryTrashQuery,
  MAX_DIRECTORY_DEPTH,
  nextEntriesCursor,
  purgeTrash,
  relinkSource,
  removeSource,
  renameAsset,
  restoreTrash,
  saveAnnotation,
  startScan,
  trashItems,
  undoOperation,
  type LibraryDirectory,
  type LibraryDirectoryPage,
} from "./library.ts";

function fakeApi(reply: (request: Request) => unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request.clone());
      return new Response(JSON.stringify(reply(request) ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const url = (request: Request) => new URL(request.url);
const query = (request: Request) => Object.fromEntries(url(request).searchParams);

function directory(id: string, parent: string | null): LibraryDirectory {
  return { directory_id: id, name: id, parent_id: parent } as LibraryDirectory;
}

describe("library queries", () => {
  it("键都在 library 下", () => {
    expect(libraryKeys.sources()).toEqual(["library", "sources"]);
    expect(libraryKeys.directory("d1")).toEqual(["library", "directory", "d1"]);
    expect(libraryKeys.scan("s1")).toEqual(["library", "source", "s1", "scan"]);
    expect(libraryKeys.entries("d1")).toEqual(["library", "entries", "d1", { includeDescendants: false }]);
    expect(libraryKeys.search({ query: " a ", scope: "library", sourceId: "s1", directoryId: "d1" })).toEqual([
      "library",
      "search",
      { query: "a", scope: "library", sourceId: null, directoryId: null },
    ]);
    expect(libraryKeys.search({ query: "a", scope: "source", sourceId: "s1", directoryId: "d1" }).at(-1)).toEqual({
      query: "a",
      scope: "source",
      sourceId: "s1",
      directoryId: null,
    });
    expect(libraryKeys.trash()).toEqual(["library", "trash"]);
    expect(libraryKeys.annotation("a1")).toEqual(["library", "annotation", "a1"]);
  });

  it("资源路径转义 id", () => {
    expect(assetThumbnailPath("a/1")).toBe("/api/v1/gallery/assets/a%2F1/thumbnail?size=256");
    expect(assetThumbnailPath("a1", 128)).toBe("/api/v1/gallery/assets/a1/thumbnail?size=128");
    expect(assetContentPath("a1")).toBe("/api/v1/gallery/assets/a1/content");
  });

  it("来源列表、详情和扫描状态都带 view=desktop", async () => {
    const { api, requests } = fakeApi((request) =>
      url(request).pathname === "/api/v1/gallery/sources" ? { sources: [{ source_id: "s1" }] } : { source_id: "s1" },
    );
    const queries = client();
    await expect(queries.fetchQuery(librarySourcesQuery(api))).resolves.toEqual([{ source_id: "s1" }]);
    await queries.fetchQuery(librarySourceQuery(api, "s1"));
    await queries.fetchQuery(libraryScanQuery(api, "s1"));
    expect(requests.map((request) => url(request).pathname)).toEqual([
      "/api/v1/gallery/sources",
      "/api/v1/gallery/sources/s1",
      "/api/v1/gallery/sources/s1/scan",
    ]);
    expect(requests.every((request) => url(request).searchParams.get("view") === "desktop")).toBe(true);
  });

  it("目录选择器按 directory_cursor 翻页", async () => {
    const { api, requests } = fakeApi((request) =>
      url(request).searchParams.get("directory_cursor")
        ? { directories: [{ directory_id: "d3" }], directory_cursor: null }
        : { directories: [{ directory_id: "d2" }], directory_cursor: "next" },
    );
    const queries = client();
    const options = libraryDirectoryQuery(api, "d1");
    await queries.fetchInfiniteQuery(options);
    await queries.fetchInfiniteQuery({ ...options, pages: 2 });
    const pages = queries.getQueryData(options.queryKey)?.pages ?? [];
    expect(pages.flatMap((page) => page.directories)).toEqual([{ directory_id: "d2" }, { directory_id: "d3" }]);
    expect(options.getNextPageParam(pages[1]!, pages, null, [])).toBeUndefined();
    expect(url(requests[0]!).pathname).toBe("/api/v1/gallery/directories/d1/entries");
    expect(query(requests[0]!)).toEqual({ view: "desktop", limit: String(DIRECTORY_PAGE_SIZE) });
    expect(url(requests.at(-1)!).searchParams.get("directory_cursor")).toBe("next");
  });

  it("浏览页的两路游标各自走完", () => {
    const page = (directory_cursor: string | null, asset_cursor: string | null) =>
      ({ directory_cursor, asset_cursor }) as LibraryDirectoryPage;
    expect(nextEntriesCursor(page("d", "a"), { directories: null, assets: null })).toEqual({ directories: "d", assets: "a" });
    expect(nextEntriesCursor(page(null, "a2"), { directories: "d", assets: "a" })).toEqual({ directories: false, assets: "a2" });
    // 已经取完的一路不再看接口返回的游标。
    expect(nextEntriesCursor(page("d", "a3"), { directories: false, assets: "a2" })).toEqual({ directories: false, assets: "a3" });
    expect(nextEntriesCursor(page("d", null), { directories: false, assets: "a3" })).toBeUndefined();
  });

  it("浏览页丢掉已取完那一路的重复内容", async () => {
    const { api, requests } = fakeApi((request) => {
      const cursor = url(request).searchParams.get("asset_cursor");
      return cursor
        ? { directory: { directory_id: "d1" }, directories: [{ directory_id: "dup" }], assets: [{ asset_id: "a2" }], directory_cursor: null, asset_cursor: null }
        : { directory: { directory_id: "d1" }, directories: [{ directory_id: "c1" }], assets: [{ asset_id: "a1" }], directory_cursor: null, asset_cursor: "n" };
    });
    const queries = client();
    const options = libraryEntriesQuery(api, "d1", { includeDescendants: true });
    await queries.fetchInfiniteQuery(options);
    await queries.fetchInfiniteQuery({ ...options, pages: 2 });
    const pages = queries.getQueryData(options.queryKey)?.pages ?? [];
    expect(pages.flatMap((page) => page.directories.map((entry) => entry.directory_id))).toEqual(["c1"]);
    expect(pages.flatMap((page) => page.assets.map((entry) => entry.asset_id))).toEqual(["a1", "a2"]);
    expect(query(requests[0]!)).toEqual({ view: "desktop", include_descendants: "true", limit: String(ENTRIES_PAGE_SIZE) });
    expect(query(requests.at(-1)!)).toEqual({ view: "desktop", include_descendants: "true", asset_cursor: "n", limit: String(ENTRIES_PAGE_SIZE) });
  });

  it("目录链沿 parent_id 往上找，遇到缓存的上级就接上", async () => {
    const tree: Record<string, LibraryDirectory> = {
      root: directory("root", null),
      d1: directory("d1", "root"),
      d2: directory("d2", "d1"),
      d3: directory("d3", "d2"),
    };
    const { api, requests } = fakeApi((request) => ({ directory: tree[url(request).pathname.split("/")[5]!] }));
    const queries = client();
    const ids = (chain: LibraryDirectory[]) => chain.map((entry) => entry.directory_id);
    expect(ids(await queries.fetchQuery(libraryPathQuery(api, queries, "d2")))).toEqual(["root", "d1", "d2"]);
    expect(requests).toHaveLength(3);
    expect(query(requests[0]!)).toEqual({ view: "desktop", limit: "1" });
    expect(ids(await queries.fetchQuery(libraryPathQuery(api, queries, "d3")))).toEqual(["root", "d1", "d2", "d3"]);
    expect(requests).toHaveLength(4);
  });

  it("目录链有深度上限", async () => {
    const { api, requests } = fakeApi((request) => {
      const id = url(request).pathname.split("/")[5]!;
      return { directory: directory(id, `${id}x`) };
    });
    const queries = client();
    const chain = await queries.fetchQuery(libraryPathQuery(api, queries, "d"));
    expect(chain).toHaveLength(MAX_DIRECTORY_DEPTH);
    expect(requests).toHaveLength(MAX_DIRECTORY_DEPTH);
  });

  it("搜索按范围带参数并按 asset_cursor 翻页", async () => {
    const { api, requests } = fakeApi((request) =>
      url(request).searchParams.get("asset_cursor") ? { assets: [{ asset_id: "a2" }], asset_cursor: null } : { assets: [{ asset_id: "a1" }], asset_cursor: "n" },
    );
    const queries = client();
    const options = librarySearchQuery(api, { query: " cat ", scope: "directory", sourceId: "s1", directoryId: "d1" }, 50);
    await queries.fetchInfiniteQuery(options);
    await queries.fetchInfiniteQuery({ ...options, pages: 2 });
    expect(url(requests[0]!).pathname).toBe("/api/v1/gallery/search");
    expect(query(requests[0]!)).toEqual({
      view: "desktop",
      query: "cat",
      scope: "directory",
      source_id: "s1",
      directory_id: "d1",
      include_descendants: "true",
      limit: "50",
    });
    expect(url(requests[2]!).searchParams.get("asset_cursor")).toBe("n");
    const pages = queries.getQueryData(options.queryKey)?.pages ?? [];
    expect(options.getNextPageParam(pages[1]!, pages, "n", [null, "n"])).toBeUndefined();

    await queries.fetchInfiniteQuery(librarySearchQuery(api, { query: "cat", scope: "library", sourceId: "s1" }));
    expect(query(requests.at(-1)!)).toEqual({ view: "desktop", query: "cat", scope: "library", include_descendants: "false", limit: String(ENTRIES_PAGE_SIZE) });
  });

  it("回收区按 next_cursor 翻页", async () => {
    const { api, requests } = fakeApi((request) =>
      url(request).searchParams.get("cursor") ? { operations: [{ operation_id: "o2" }], next_cursor: null } : { operations: [{ operation_id: "o1" }], next_cursor: "c" },
    );
    const queries = client();
    const options = libraryTrashQuery(api);
    await queries.fetchInfiniteQuery(options);
    await queries.fetchInfiniteQuery({ ...options, pages: 2 });
    expect(query(requests[0]!)).toEqual({ view: "desktop", limit: "50" });
    expect(url(requests.at(-1)!).searchParams.get("cursor")).toBe("c");
    const pages = queries.getQueryData(options.queryKey)?.pages ?? [];
    expect(pages.flatMap((page) => page.operations.map((operation) => operation.operation_id))).toEqual(["o1", "o2"]);
    expect(options.getNextPageParam(pages[1]!, pages, "c", [null, "c"])).toBeUndefined();
  });

  it("TXT 读写", async () => {
    const { api, requests } = fakeApi(() => ({ asset_id: "a1", content: "tag", disk_version: "v", txt_version: 1 }));
    await client().fetchQuery(libraryAnnotationQuery(api, "a1"));
    await saveAnnotation(api, "a1", { content: "new", expected_disk_version: "v", expected_txt_version: 1 });
    expect(`${requests[0]!.method} ${url(requests[0]!).pathname}`).toBe("GET /api/v1/gallery/assets/a1/annotation");
    expect(`${requests[1]!.method} ${url(requests[1]!).pathname}`).toBe("PUT /api/v1/gallery/assets/a1/annotation");
    expect(await requests[1]!.json()).toEqual({ content: "new", expected_disk_version: "v", expected_txt_version: 1 });
  });

  it("写操作打到对应接口", async () => {
    const { api, requests } = fakeApi(() => ({ operation_id: "o1", source_id: "s1" }));
    await startScan(api, "s1");
    await importSource(api, { root_path: "/p", display_name: "P" });
    await relinkSource(api, "s1", "/q");
    await removeSource(api, "s1", true);
    await removeSource(api, "s2");
    await trashItems(api, { asset_ids: ["a1"] });
    await undoOperation(api, "o1");
    await renameAsset(api, "a1", "new");
    await restoreTrash(api, "o1");
    await purgeTrash(api, "o1");
    await emptyTrash(api);
    expect(requests.map((request) => `${request.method} ${url(request).pathname}${url(request).search}`)).toEqual([
      "POST /api/v1/gallery/sources/s1/scan",
      "POST /api/v1/gallery/imports",
      "POST /api/v1/gallery/sources/s1/relink",
      "DELETE /api/v1/gallery/sources/s1?delete_files=true",
      "DELETE /api/v1/gallery/sources/s2?delete_files=false",
      "POST /api/v1/gallery/file-operations/trash",
      "POST /api/v1/gallery/file-operations/o1/undo",
      "POST /api/v1/gallery/assets/a1/rename",
      "POST /api/v1/gallery/trash/o1/restore",
      "DELETE /api/v1/gallery/trash/o1",
      "DELETE /api/v1/gallery/trash",
    ]);
    expect(await requests[1]!.json()).toEqual({ root_path: "/p", display_name: "P" });
    expect(await requests[2]!.json()).toEqual({ root_path: "/q" });
    expect(await requests[5]!.json()).toEqual({ asset_ids: ["a1"] });
    expect(await requests[7]!.json()).toEqual({ new_stem: "new" });
  });

  it("invalidateLibrary 让图库的查询全部失效", async () => {
    const queries = client();
    queries.setQueryData(libraryKeys.sources(), []);
    queries.setQueryData(libraryKeys.trash(), { pages: [], pageParams: [] });
    queries.setQueryData(["datasets", "list"], []);
    await invalidateLibrary(queries);
    expect(queries.getQueryState(libraryKeys.sources())?.isInvalidated).toBe(true);
    expect(queries.getQueryState(libraryKeys.trash())?.isInvalidated).toBe(true);
    expect(queries.getQueryState(["datasets", "list"])?.isInvalidated).toBe(false);
  });
});
