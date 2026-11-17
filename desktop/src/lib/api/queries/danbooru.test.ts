import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { ApiError } from "../errors.ts";
import {
  autocompleteDanbooru,
  browseDanbooru,
  canCollectDanbooruPost,
  clearDanbooruQuery,
  collectDanbooru,
  composeDanbooruQuery,
  createDanbooruRequestScope,
  DANBOORU_COLLECT_LIMIT,
  danbooruCollectAttempt,
  danbooruMediaUrl,
  danbooruQueryText,
  deleteDanbooruRecipe,
  emptyDanbooruFilters,
  mergeDanbooruPosts,
  isDanbooruExpired,
  rawDanbooruQuery,
  readDanbooruRecipes,
  replaceLastDanbooruTag,
  saveDanbooruRecipe,
  selectedDanbooruTokens,
  selectLoadedDanbooruPosts,
  type DanbooruPost,
  type DanbooruQueryDraft,
  type DanbooruRecipe,
} from "./danbooru.ts";

function post(id: string, extra: Partial<DanbooruPost> = {}): DanbooruPost {
  return {
    id, url: `https://danbooru.donmai.us/posts/${id}`, title: `Post ${id}`, width: 1000, height: 1200,
    rating: "g", score: 5, file_ext: "png", file_size: 1234,
    tags: { general: ["solo"], character: [], artist: [], copyright: [], meta: [] },
    source_url: "", downloadable: true, unavailable_reason: "", preview_url: `/api/v1/danbooru/media/${id}/preview`,
    sample_url: "", token: `token-${id}`, local_asset_id: null, in_dataset: false, ...extra,
  };
}

function fakeApi(body: unknown, status = 200) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request.clone());
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

describe("Danbooru query drafts", () => {
  it("composes the structured filters as Danbooru DSL", () => {
    expect(composeDanbooruQuery({
      ...emptyDanbooruFilters(), include: "  solo blue_hair solo ", exclude: "watermark -text", rating: "g",
      minWidth: "0768", minHeight: "1024", ratio: ">1", format: "png", order: "score",
    })).toBe("solo blue_hair -watermark -text rating:g width:>=768 height:>=1024 ratio:>1 filetype:png order:score");
  });

  it("does not invent numeric constraints from empty, zero or invalid dimensions", () => {
    expect(composeDanbooruQuery({ ...emptyDanbooruFilters(), minWidth: "-5", minHeight: "0" })).toBe("order:id_desc");
    expect(composeDanbooruQuery({ ...emptyDanbooruFilters(), minWidth: "1.5", minHeight: "" })).toBe("order:id_desc");
    expect(composeDanbooruQuery({ ...emptyDanbooruFilters(), ratio: "<1" })).toContain("ratio:<1");
    expect(composeDanbooruQuery({ ...emptyDanbooruFilters(), ratio: "1" })).toContain("ratio:1");
  });

  it("switches simple to raw without losing generated filters", () => {
    const draft: DanbooruQueryDraft = { mode: "simple", filters: { ...emptyDanbooruFilters(), include: "solo", rating: "q" } };
    expect(rawDanbooruQuery(draft)).toEqual({ mode: "raw", text: "solo rating:q order:id_desc" });
  });

  it("keeps complex raw queries verbatim until the explicit clear action", () => {
    const text = '  ( ~blue_hair ~red_hair ) -artist:"a b" score:>10 order:custom id:9,2  ';
    const draft: DanbooruQueryDraft = { mode: "raw", text };
    expect(danbooruQueryText(draft)).toBe(text);
    expect(rawDanbooruQuery(draft)).toEqual(draft);
    expect(clearDanbooruQuery()).toEqual({ mode: "simple", filters: emptyDanbooruFilters() });
    expect(draft.text).toBe(text);
  });

  it("replaces only the final autocomplete token, preserving the preceding tags", () => {
    expect(replaceLastDanbooruTag("solo blue_", "blue_hair")).toBe("solo blue_hair");
    expect(replaceLastDanbooruTag("solo ", "blue_hair")).toBe("solo blue_hair");
  });
});

describe("Danbooru source selection", () => {
  it("keeps source order across pages and removes duplicate post IDs", () => {
    const first = [post("90"), post("4"), post("72")];
    const result = mergeDanbooruPosts(first, [post("4", { token: "later-token" }), post("1"), post("1")]);
    expect(result.map((item) => item.id)).toEqual(["90", "4", "72", "1"]);
    expect(result[1]!.token).toBe("token-4");
    expect(first).toHaveLength(3);
    expect(selectedDanbooruTokens(result, new Set(["1", "90", "4"]))).toEqual(["token-90", "token-4", "token-1"]);
  });

  it("rechecks disabled states when building the submission", () => {
    const posts = [post("a", { in_dataset: true }), post("b", { downloadable: false }),
      post("c", { downloadable: false, local_asset_id: "local-c" }), post("d", { token: "" }), post("e")];
    expect(posts.map(canCollectDanbooruPost)).toEqual([false, false, true, false, true]);
    expect(canCollectDanbooruPost(post("x", { in_dataset: true, local_asset_id: "local-x" }))).toBe(false);
    expect(selectedDanbooruTokens([...posts, posts[2]!], new Set(posts.map((item) => item.id)))).toEqual(["token-c", "token-e"]);
  });

  it("caps select-loaded at 1000 collectable posts in source order", () => {
    const posts = Array.from({ length: 1005 }, (_, index) => post(String(index), { in_dataset: index < 3 }));
    const selected = selectLoadedDanbooruPosts([...posts, posts[4]!]);
    expect(selected.size).toBe(DANBOORU_COLLECT_LIMIT);
    expect([...selected].at(0)).toBe("3");
    expect([...selected].at(-1)).toBe("1002");
    expect(selected.has("1003")).toBe(false);
  });

  it("reuses the idempotency key for the same ordered selection on retry", () => {
    const first = danbooruCollectAttempt(undefined, ["token-9", "token-2"]);
    expect(danbooruCollectAttempt(first, ["token-9", "token-2"])).toBe(first);
    const changed = danbooruCollectAttempt(first, ["token-9"]);
    expect(changed.key).not.toBe(first.key);
    expect(changed.tokens).toEqual(["token-9"]);
  });

  it("only resolves backend media paths, leaving absent or remote media as placeholders", () => {
    const { api } = fakeApi({});
    expect(danbooruMediaUrl(api, "/api/v1/danbooru/media/1")).toBe("http://127.0.0.1:8787/api/v1/danbooru/media/1");
    for (const path of ["", "https://example.com/image.png", "//example.com/image.png", "/\\example.com/image.png"]) {
      expect(danbooruMediaUrl(api, path)).toBe("");
    }
  });
});

describe("Danbooru request sequence", () => {
  it("aborts old work and refuses late results after changed conditions or close", async () => {
    const scope = createDanbooruRequestScope();
    let resolveOld!: (value: string) => void;
    const oldResult = new Promise<string>((resolve) => { resolveOld = resolve; });
    const old = scope.begin();
    const applied: string[] = [];
    const waiting = oldResult.then((result) => { if (old.isCurrent()) applied.push(result); });
    const current = scope.begin();
    expect(old.signal.aborted).toBe(true);
    expect(current.isCurrent()).toBe(true);
    resolveOld("stale page");
    await waiting;
    expect(applied).toEqual([]);
    scope.cancel();
    expect(current.signal.aborted).toBe(true);
    expect(current.isCurrent()).toBe(false);
    expect(scope.begin().isCurrent()).toBe(true);
  });
});

describe("Danbooru local recipes", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }
  const recipe: DanbooruRecipe = { id: "one", name: "Pool source", kind: "pool", query: "", reference: "https://danbooru.donmai.us/pools/4" };

  it("isolates datasets and preserves raw recipes and collection references", () => {
    const storage = memoryStorage();
    saveDanbooruRecipe(storage, "dataset/a", recipe);
    const other: DanbooruRecipe = { ...recipe, name: "Raw query", kind: "search", query: "( ~solo ~duo ) order:rank", reference: "" };
    saveDanbooruRecipe(storage, "dataset/b", other);
    expect(readDanbooruRecipes(storage, "dataset/a")).toEqual([recipe]);
    expect(readDanbooruRecipes(storage, "dataset/b")).toEqual([other]);
    expect(deleteDanbooruRecipe(storage, "dataset/a", "one")).toEqual([]);
    expect(readDanbooruRecipes(storage, "dataset/b")).toEqual([other]);
  });

  it("persists only recipe fields, without response tokens or credentials", () => {
    const storage = memoryStorage();
    saveDanbooruRecipe(storage, "a", { ...recipe, token: "secret-token", api_key: "secret-key", preview_url: "/media" } as DanbooruRecipe);
    expect([...storage.values.values()].join("")).not.toContain("secret");
    expect(readDanbooruRecipes(storage, "a")).toEqual([recipe]);
    saveDanbooruRecipe(storage, "a", { ...recipe, name: "Updated" });
    expect(readDanbooruRecipes(storage, "a")).toEqual([{ ...recipe, name: "Updated" }]);
  });

  it("ignores damaged or outdated local data", () => {
    const storage = memoryStorage();
    saveDanbooruRecipe(storage, "a", recipe);
    const key = [...storage.values.keys()][0]!;
    storage.setItem(key, "bad json");
    expect(readDanbooruRecipes(storage, "a")).toEqual([]);
    storage.setItem(key, JSON.stringify([null, { ...recipe, kind: "subscription" }, recipe]));
    expect(readDanbooruRecipes(storage, "a")).toEqual([recipe]);
  });
});

describe("Danbooru API contracts", () => {
  it("uses the browse contract, including raw text, reference, count and cursor", async () => {
    const response = { items: [post("7")], source: { kind: "pool", id: "4", name: "Actual pool name", url: "https://danbooru.donmai.us/pools/4" },
      next_cursor: "cursor-two", total: null, warnings: ["partial"] };
    const { api, requests } = fakeApi(response);
    const body = { dataset_id: "d", kind: "pool" as const, query: "", reference: "4", cursor: "cursor-one", limit: 48, count: false };
    await expect(browseDanbooru(api, body)).resolves.toEqual(response);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/danbooru/browse");
    expect(await requests[0]!.json()).toEqual(body);
  });

  it("sends only ordered tokens to collect with a reusable idempotency key", async () => {
    const response = { batch_id: null, queued_count: 0, reused_count: 2, skipped_count: 1 };
    const { api, requests } = fakeApi(response);
    await expect(collectDanbooru(api, "dataset-a", ["token-9", "token-2"], "danbooru-test-key")).resolves.toEqual(response);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/datasets/dataset-a/danbooru/collect");
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe("danbooru-test-key");
    expect(await requests[0]!.json()).toEqual({ tokens: ["token-9", "token-2"] });
  });

  it("retains the existing error middleware", async () => {
    const { api } = fakeApi({ error: { code: "permission_denied", message: "private" } }, 403);
    await expect(collectDanbooru(api, "d", ["token"], "danbooru-error-key")).rejects.toBeInstanceOf(ApiError);
  });

  it("preserves 410 so the UI can require reloading expired previews", async () => {
    const { api } = fakeApi({ error: { code: "danbooru_token_expired", message: "expired" } }, 410);
    const error = await collectDanbooru(api, "d", ["token"], "danbooru-expired-key").catch((failure: unknown) => failure);
    expect(isDanbooruExpired(error)).toBe(true);
    expect(isDanbooruExpired(new ApiError({ status: 403, code: "denied" }))).toBe(false);
    expect(isDanbooruExpired(new Error("network"))).toBe(false);
  });

  it("uses and normalizes the existing autocomplete schema", async () => {
    const { api, requests } = fakeApi({ items: [{ value: "blue_hair", label: "blue hair", category: "general", post_count: 12 },
      { value: "solo" }, null, 5, { label: "invalid" }] });
    await expect(autocompleteDanbooru(api, "blue_")).resolves.toEqual([
      { value: "blue_hair", label: "blue hair", category: "general", count: 12 },
      { value: "solo", label: "solo", category: "", count: null },
    ]);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/search/autocomplete");
    expect(url.searchParams.get("q")).toBe("blue_");
    expect(url.searchParams.get("limit")).toBe("8");
  });
});
