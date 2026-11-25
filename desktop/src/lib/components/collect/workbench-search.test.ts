import { describe, expect, it, vi } from "vitest";

import { createApi } from "#lib/api/client.ts";
import { ApiError } from "#lib/api/errors.ts";
import type { WorkbenchAddress, WorkbenchSource } from "#lib/api/queries/workbench.ts";
import { resolveWorkbenchCreator, resolveWorkbenchSearch } from "./workbench-search.ts";

const first = "https://e-hentai.org/g/100/aaaaaaaaaa/";
const second = "https://exhentai.org/g/200/bbbbbbbbbb/";

function fakeApi(body: unknown = {}, status = 200) {
  const fetchImpl = vi.fn(async (_request: Request) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  return { api: createApi("http://127.0.0.1:8787", { fetchImpl }), fetchImpl };
}

function ehSource(source: Record<string, unknown>) {
  return {
    response_profile: "desktop",
    sources: [{ site: "exhentai", status: "succeeded", auth: { authorized: false }, ...source }],
  };
}

const routes: [WorkbenchSource, string, WorkbenchAddress][] = [
  ["danbooru", "  blue_sky rating:s ", { site: "danbooru", query: "blue_sky rating:s" }],
  ["pixiv", "  猫 & sky  ", { site: "pixiv", url: "https://www.pixiv.net/search.php?word=%E7%8C%AB%20%26%20sky" }],
  ["twitter", " from:Alice 猫+#art ", { site: "twitter", url: "https://x.com/search?q=from%3AAlice%20%E7%8C%AB%2B%23art" }],
  ["twitter", " @Studio_Art ", { site: "twitter", url: "https://x.com/studio_art/media" }],
  ["exhentai", "https://pixiv.net/en/users/42?ref=feed", { site: "pixiv", url: "https://www.pixiv.net/users/42/artworks" }],
  ["pixiv", "http://mobile.twitter.com/Studio_Art/media?ref=feed", { site: "twitter", url: "https://x.com/studio_art/media" }],
  ["danbooru", "http://e-hentai.org/g/100/aaaaaaaaaa?p=2#page3", { site: "exhentai", url: first }],
  ["exhentai", "https://danbooru.donmai.us/posts?tags=cat+rating%3As", { site: "danbooru", query: "cat rating:s" }],
  ["exhentai", "https://twitter.com/search?q=cat+art&f=live", { site: "twitter", url: "https://x.com/search?q=cat%20art" }],
  ["twitter", "https://www.pixiv.net/search.php?word=cat+art", { site: "pixiv", url: "https://www.pixiv.net/search.php?word=cat%20art" }],
];

describe("workbench search routing", () => {
  it.each(routes)("resolves %s input %s locally to the matching browse source", async (site, input, address) => {
    const { api, fetchImpl } = fakeApi();
    await expect(resolveWorkbenchSearch(api, site, input)).resolves.toEqual({ kind: "browse", address });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    " ", "https://other.example/42", "other.example/pictures", "//x.com/alice", "https:x.com/alice",
    "ftp://x.com/alice", "javascript:alert(1)", "https://x.com.evil.test/alice",
    "https://x.com@evil.test/alice", "https://user:secret@x.com/alice", "https://@x.com/alice",
    "https://x.com:443/alice", "https://%78.com/alice", "ht\ttps://x.com/alice", "https://x.com/settings/privacy",
    "https://www.pixiv.net/artworks/42", "https://e-hentai.org/?f_search=cat",
    "https://danbooru.donmai.us/posts?tags=%20",
  ])("rejects %s rather than issuing an EH keyword search", async (input) => {
    const { api, fetchImpl } = fakeApi();
    await expect(resolveWorkbenchSearch(api, "exhentai", input)).resolves.toEqual({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("EH gallery discovery", () => {
  it("queries the desktop discovery endpoint and returns ordered, titled and deduplicated gallery choices", async () => {
    const { api, fetchImpl } = fakeApi(ehSource({
      addresses: [
        { id: "exhentai:gallery:100", address_type: "gallery", url: `${first}?p=1` },
        { id: "exhentai:gallery:200", address_type: "gallery", url: second, title: "Alias-only hit" },
        { id: "exhentai:gallery:100", address_type: "gallery", url: "http://e-hentai.org/g/100/aaaaaaaaaa#page2", label: "Direct + alias hit" },
        { address_type: "gallery", url: "https://other.example/g/300/cccccccccc/" },
        { address_type: "search", url: "https://e-hentai.org/?f_search=fixture" },
      ],
    }));
    await expect(resolveWorkbenchSearch(api, "exhentai", "  artist:fixture  ")).resolves.toEqual({
      kind: "galleries",
      choices: [
        { label: "Direct + alias hit", address: { site: "exhentai", url: first } },
        { label: "Alias-only hit", address: { site: "exhentai", url: second } },
      ],
    });
    const [request] = fetchImpl.mock.calls[0]!;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/api/v1/search?view=desktop");
    expect(await request.json()).toMatchObject({ keyword: "artist:fixture", sites: ["exhentai"] });
  });

  it("opens a unique gallery for browsing, even when discovery returns several URL variants", async () => {
    const { api, fetchImpl } = fakeApi(ehSource({ addresses: [{ url: `${first}?p=2` }, { url: `${first}#page2` }] }));
    await expect(resolveWorkbenchSearch(api, "exhentai", "fixture")).resolves.toEqual({
      kind: "browse", address: { site: "exhentai", url: first },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an empty success even when the optional EH login is unavailable", async () => {
    const { api } = fakeApi(ehSource({ addresses: [], error: { code: "", message: "" } }));
    await expect(resolveWorkbenchSearch(api, "exhentai", "fixture")).resolves.toEqual({ kind: "galleries", choices: [] });
  });

  it.each([
    ["failed", "authentication", "请检查登录凭据或账户权限"],
    ["failed", "search_timeout", "搜索超时，请检查网络连接或代理设置后重试"],
    ["partial", "search_incomplete", "扩展查询未完成，暂未取得候选"],
  ])("exposes the safe message from a %s discovery result (%s)", async (status, code, message) => {
    const { api } = fakeApi(ehSource({ status, error: { code, message }, addresses: [] }));
    const result = resolveWorkbenchSearch(api, "exhentai", "fixture");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toThrow(message);
  });

  it("preserves API transport errors", async () => {
    const { api } = fakeApi({ error: { code: "service_unavailable", message: "服务暂不可用" } }, 503);
    await expect(resolveWorkbenchSearch(api, "exhentai", "fixture")).rejects.toMatchObject({
      name: "ApiError", code: "service_unavailable", status: 503, message: "服务暂不可用",
    });
  });

  it("forwards cancellation to discovery", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (request: Request) => {
      controller.abort();
      request.signal.throwIfAborted();
      return new Response();
    });
    const api = createApi("http://127.0.0.1:8787", { fetchImpl });
    await expect(resolveWorkbenchSearch(api, "exhentai", "fixture", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("opt-in creator discovery", () => {
  it("uses the original Pixiv keyword and offers distinct previewable artists", async () => {
    const { api, fetchImpl } = fakeApi({
      response_profile: "desktop",
      sources: [{
        site: "pixiv", status: "succeeded", addresses: [
          { address_type: "account", url: "https://pixiv.net/en/users/123?ref=artist", label: "Studio One" },
          { address_type: "account", url: "https://www.pixiv.net/users/456/artworks", label: "Studio Two" },
          { address_type: "search", url: "https://www.pixiv.net/search.php?word=Studio" },
          { address_type: "artwork", url: "https://www.pixiv.net/artworks/678" },
          { address_type: "account", url: "https://someone@www.pixiv.net/users/789" },
        ],
      }],
    });
    const keyword = "  Studio 猫  ";
    await expect(resolveWorkbenchSearch(api, "pixiv", keyword)).resolves.toMatchObject({ kind: "browse" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(resolveWorkbenchCreator(api, "pixiv", keyword)).resolves.toEqual({
      kind: "galleries",
      choices: [
        { label: "Studio One", address: { site: "pixiv", url: "https://www.pixiv.net/users/123/artworks" } },
        { label: "Studio Two", address: { site: "pixiv", url: "https://www.pixiv.net/users/456/artworks" } },
      ],
    });
    const [request] = fetchImpl.mock.calls[0]!;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await request.json()).toMatchObject({ keyword: "Studio 猫", sites: ["pixiv"] });
  });

  it("opens one X creator after canonicalizing profile aliases", async () => {
    const { api, fetchImpl } = fakeApi({
      response_profile: "desktop",
      sources: [{
        site: "twitter", status: "succeeded", addresses: [
          { address_type: "account", url: "https://twitter.com/Studio_Art", label: "Studio Art" },
          { address_type: "account", url: "https://x.com/studio_art/media?ref=artist", label: "Studio Art" },
          { address_type: "account", url: "https://x.com/settings/privacy" },
        ],
      }],
    });
    await expect(resolveWorkbenchCreator(api, "twitter", "Studio Art")).resolves.toEqual({
      kind: "browse", address: { site: "twitter", url: "https://x.com/studio_art/media" },
    });
    const [request] = fetchImpl.mock.calls[0]!;
    expect(await request.json()).toMatchObject({ keyword: "Studio Art", sites: ["twitter"] });
  });

  it("returns no creators when discovery only has a non-previewable status", async () => {
    const { api } = fakeApi({
      response_profile: "desktop",
      sources: [{ site: "twitter", status: "succeeded", addresses: [
        { address_type: "status", url: "https://x.com/Studio_Art/status/321" },
      ] }],
    });
    await expect(resolveWorkbenchCreator(api, "twitter", "Studio Art")).resolves.toEqual({ kind: "galleries", choices: [] });
  });
});
