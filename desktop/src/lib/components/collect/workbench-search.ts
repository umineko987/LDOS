import type { Api } from "#lib/api/client.ts";
import { ApiError } from "#lib/api/errors.ts";
import { searchDiscovery } from "#lib/api/queries/discovery.ts";
import { workbenchAddress, type WorkbenchAddress, type WorkbenchSource } from "#lib/api/queries/workbench.ts";

type SearchChoice = { label: string; address: WorkbenchAddress };
export type SearchResolution =
  | { kind: "browse"; address: WorkbenchAddress }
  | { kind: "galleries"; choices: SearchChoice[] }
  | { kind: "invalid" };

// Require an absolute address with a literal hostname, not userinfo, a port,
// or a spelling the URL parser would recover or normalize into a known host.
function pastedUrl(input: string): URL | null {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority || /[\s\\]/.test(input)) return null;
  try {
    const url = new URL(input);
    return authority.toLowerCase() === url.hostname ? url : null;
  } catch {
    return null;
  }
}

function keywordAddress(site: "pixiv" | "twitter", keyword: string): WorkbenchAddress {
  const base = site === "pixiv" ? "https://www.pixiv.net/search.php?word=" : "https://x.com/search?q=";
  return { site, url: base + encodeURIComponent(keyword) };
}

function galleryAddress(url: URL) {
  return { site: "exhentai" as const, url: `https://${url.hostname}${url.pathname.replace(/\/$/, "")}/` };
}

function pastedAddress(input: string): WorkbenchAddress | null {
  const url = pastedUrl(input);
  if (!url) return null;
  const host = url.hostname;
  let site: WorkbenchSource;
  if (/^(?:www\.)?pixiv\.net$/.test(host)) {
    site = "pixiv";
    if (url.pathname === "/search.php") {
      const keyword = url.searchParams.get("word")?.trim();
      return keyword ? keywordAddress(site, keyword) : null;
    }
  } else if (/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(host)) {
    site = "twitter";
    if (url.pathname === "/search") {
      const keyword = url.searchParams.get("q")?.trim();
      return keyword ? keywordAddress(site, keyword) : null;
    }
  } else if (host === "exhentai.org" || host === "e-hentai.org") {
    site = "exhentai";
  } else if (host === "danbooru.donmai.us") {
    site = "danbooru";
  } else {
    return null;
  }
  const address = workbenchAddress({ site, url: url.href, addressType: null });
  if (address?.site === "danbooru") {
    const query = address.query.trim();
    return query ? { site: "danbooru", query } : null;
  }
  return address?.site === "exhentai" ? galleryAddress(url) : address;
}

// A colon alone is not a URL marker (e.g. artist:example, rating:s, from:alice).
const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:\/\/|(?:https?|ftp|file|data|javascript|mailto|blob|about|tel|urn|wss?):|[/\\]{2}|(?:[\w-]+\.)+(?:[a-z]{2,}|\d+)(?:[/:?#]|$))/i;

function isUrlLike(input: string): boolean {
  return URL_LIKE.test(input.replace(/[\t\n\r]/g, ""));
}

export async function resolveWorkbenchSearch(api: Api, site: WorkbenchSource, input: string, signal?: AbortSignal): Promise<SearchResolution> {
  const keyword = input.trim();
  if (!keyword) return { kind: "invalid" };
  if (isUrlLike(keyword)) {
    const address = pastedAddress(keyword);
    return address ? { kind: "browse", address } : { kind: "invalid" };
  }
  if (site === "danbooru") return { kind: "browse", address: { site, query: keyword } };
  if (site === "pixiv" || site === "twitter") {
    const handle = site === "twitter" ? /^@([A-Za-z\d_]{1,15})$/.exec(keyword)?.[1] : undefined;
    const profile = handle && workbenchAddress({ site, url: `https://x.com/${handle}`, addressType: "account" });
    return { kind: "browse", address: profile || keywordAddress(site, keyword) };
  }

  return resolveDiscovery(api, site, keyword, signal);
}

export function resolveWorkbenchCreator(api: Api, site: "pixiv" | "twitter", keyword: string, signal?: AbortSignal): Promise<SearchResolution> {
  const input = keyword.trim();
  return input && !isUrlLike(input)
    ? resolveDiscovery(api, site, input, signal)
    : Promise.resolve({ kind: "invalid" });
}

async function resolveDiscovery(api: Api, site: "exhentai" | "pixiv" | "twitter", keyword: string, signal?: AbortSignal): Promise<SearchResolution> {
  const sources = await searchDiscovery(api, { keyword, sites: [site] }, signal);
  const source = sources.find((source) => source.site === site);
  if (!source) return { kind: "galleries", choices: [] };
  if (source.status === "failed") {
    throw new ApiError({ code: source.needsAuth && !source.error ? "authentication" : "search_failed", message: source.error ?? undefined });
  }
  const choices = new Map<string, SearchChoice>();
  for (const candidate of source.candidates) {
    const url = pastedUrl(candidate.url);
    if (!url) continue;
    const address = workbenchAddress(candidate);
    if (address?.site !== site) continue;
    const canonical = address.site === "exhentai" ? galleryAddress(url) : address;
    const label = candidate.label === candidate.url ? canonical.url : candidate.label;
    const existing = choices.get(canonical.url);
    if (!existing || existing.label === canonical.url) choices.set(canonical.url, { label, address: canonical });
  }
  if (!choices.size && source.error) throw new ApiError({ code: "search_failed", message: source.error });
  const results = [...choices.values()];
  return results.length === 1
    ? { kind: "browse", address: results[0]!.address }
    : { kind: "galleries", choices: results };
}
