import { data, idempotent, type Api } from "../client.ts";
import { createIdempotencyKey } from "../ids.ts";
import type { components } from "../schema";
import type { DanbooruKind } from "./danbooru.ts";
import type { DiscoveryCandidate } from "./discovery.ts";

type Schemas = components["schemas"];
export type WorkbenchSite = Schemas["WorkbenchBrowseRequest"]["site"];
export type WorkbenchSource = WorkbenchSite | "danbooru";
export const WORKBENCH_PAGE_SIZE = 24;
export const WORKBENCH_BROWSE_LIMIT = 1000;
export const WORKBENCH_EH_BROWSE_LIMIT = 500;
export const WORKBENCH_SUBMIT_LIMIT = 500;

export type WorkbenchPreview = Schemas["WorkbenchBrowseResponse"];

export function browseWorkbench(api: Api, datasetId: string, site: WorkbenchSite, url: string, limit: number, signal?: AbortSignal): Promise<WorkbenchPreview> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/workbench/browse", {
    params: { path: { dataset_id: datasetId } }, body: { site, url, limit }, signal,
  }));
}

export type WorkbenchAttempt =
  | { readonly site: "danbooru"; readonly ids: readonly string[]; readonly tokens: readonly string[]; readonly key: string }
  | { readonly site: WorkbenchSite; readonly ids: readonly string[]; readonly snapshotId: string; readonly key: string };

type AttemptInput<T = WorkbenchAttempt> = T extends WorkbenchAttempt ? Omit<T, "key"> : never;

export function newWorkbenchAttempt(input: AttemptInput): WorkbenchAttempt {
  const ids = [...input.ids];
  const key = createIdempotencyKey("workbench-collect");
  return input.site === "danbooru"
    ? { ...input, ids, tokens: [...input.tokens], key }
    : { ...input, ids, key };
}

export function collectWorkbench(api: Api, datasetId: string, attempt: Extract<WorkbenchAttempt, { site: WorkbenchSite }>, signal?: AbortSignal): Promise<Schemas["WorkbenchCollectResponse"]> {
  return data(api.client.POST("/api/v1/datasets/{dataset_id}/workbench/collect", {
    params: { path: { dataset_id: datasetId }, header: idempotent(attempt.key) },
    body: { snapshot_id: attempt.snapshotId, ids: [...attempt.ids] }, signal,
  }));
}

export type WorkbenchAddress = { site: WorkbenchSite; url: string } | { site: "danbooru"; query: string };

function httpUrl(address: string): URL | null {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function timelineReference(site: "pixiv" | "twitter", url: URL): string | null {
  if (site === "pixiv" && /^(?:www\.)?pixiv\.net$/.test(url.hostname)) {
    const artist = /^\/(?:en\/)?users\/([1-9]\d{0,19})(?:\/artworks)?\/?$/.exec(url.pathname)?.[1];
    return artist ? `https://www.pixiv.net/users/${artist}/artworks` : null;
  }
  if (site === "twitter" && /^(?:(?:www|mobile)\.)?(?:twitter|x)\.com$/.test(url.hostname)) {
    const handle = /^\/([A-Za-z0-9_]{1,15})(?:\/media)?\/?$/.exec(url.pathname)?.[1];
    if (!handle || /^(?:i|home|search|intent|share|hashtag|explore|settings|login|logout|signup|account|compose|messages|notifications|bookmarks|communities|tos|privacy|about|help|download|oauth|jobs|premium)$/i.test(handle)) return null;
    return `https://x.com/${handle.toLowerCase()}/media`;
  }
  return null;
}

/** Discovery results without a supported preview remain available for address crawling. */
export function workbenchAddress(candidate: Pick<DiscoveryCandidate, "site" | "url" | "addressType">): WorkbenchAddress | null {
  const url = httpUrl(candidate.url);
  if (!url || url.username || url.password || url.port) return null;
  const site = candidate.site;
  if ((site === "pixiv" || site === "twitter") && candidate.addressType !== "search") {
    const reference = timelineReference(site, url);
    return reference ? { site, url: reference } : null;
  }
  if (site === "exhentai" && /^(?:exhentai|e-hentai)\.org$/.test(url.hostname) && /^\/g\/[1-9]\d{0,19}\/[\da-f]{10}\/?$/i.test(url.pathname)) {
    return { site, url: url.href };
  }
  if (site === "danbooru" && url.hostname === "danbooru.donmai.us" && /^\/posts\/?$/.test(url.pathname)) {
    const query = url.searchParams.get("tags");
    if (query !== null) return { site, query };
  }
  return null;
}

/** Only the timeline identity is needed to find a submitted checkpoint again. */
export function workbenchCheckpointSource(site: WorkbenchSource, kind: DanbooruKind, query: string, reference: string): string | null {
  if (site === "danbooru") return JSON.stringify([site, kind, query, reference.trim()]);
  if (site === "exhentai") return null;
  const url = httpUrl(reference);
  return url ? timelineReference(site, url) : null;
}

function checkpointKey(datasetId: string, source: string): string {
  return `ldos:workbench:last-submitted:${JSON.stringify([datasetId, source])}`;
}

export function readWorkbenchCheckpoint(storage: Pick<Storage, "getItem">, datasetId: string, source: string): string | null {
  return storage.getItem(checkpointKey(datasetId, source));
}

export function saveWorkbenchCheckpoint(storage: Pick<Storage, "setItem">, datasetId: string, source: string, id: string) {
  storage.setItem(checkpointKey(datasetId, source), id);
}
