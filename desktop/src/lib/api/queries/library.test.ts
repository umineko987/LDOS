import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { DIRECTORY_PAGE_SIZE, libraryDirectoryQuery, libraryKeys, librarySourcesQuery } from "./library.ts";

function fakeApi(reply: (request: Request) => unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify(reply(request)), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("library queries", () => {
  it("键都在 library 下", () => {
    expect(libraryKeys.sources()).toEqual(["library", "sources"]);
    expect(libraryKeys.directory("d1")).toEqual(["library", "directory", "d1"]);
  });

  it("来源列表取 sources，带 view=desktop", async () => {
    const { api, requests } = fakeApi(() => ({ sources: [{ source_id: "s1" }] }));
    await expect(client().fetchQuery(librarySourcesQuery(api))).resolves.toEqual([{ source_id: "s1" }]);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/gallery/sources");
    expect(url.searchParams.get("view")).toBe("desktop");
  });

  it("目录按 directory_cursor 翻页", async () => {
    const { api, requests } = fakeApi((request) =>
      new URL(request.url).searchParams.get("directory_cursor")
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
    const first = new URL(requests[0]!.url);
    expect(first.pathname).toBe("/api/v1/gallery/directories/d1/entries");
    expect(Object.fromEntries(first.searchParams)).toEqual({ view: "desktop", limit: String(DIRECTORY_PAGE_SIZE) });
    expect(new URL(requests.at(-1)!.url).searchParams.get("directory_cursor")).toBe("next");
  });
});
