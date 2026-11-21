import { queryOptions, type QueryClient } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";
import type { components } from "../schema";
import {
  CAPTION_BATCH_LIMIT,
  type CaptionEditRequest,
  type CaptionEditResponse,
  type CaptionOpsRequest,
} from "./captions.ts";
import { libraryKeys } from "./library.ts";

export const galleryStudioKeys = {
  source: (sourceId: string) => [...libraryKeys.source(sourceId), "studio"] as const,
  lists: (sourceId: string) => [...galleryStudioKeys.source(sourceId), "captions"] as const,
  list: (sourceId: string, directoryId: string | null) => [...galleryStudioKeys.lists(sourceId), directoryId] as const,
  batches: (sourceId: string) => [...galleryStudioKeys.source(sourceId), "batches"] as const,
  kept: (sourceId: string) => [...galleryStudioKeys.source(sourceId), "kept"] as const,
};

const sourcePath = (source_id: string) => ({ path: { source_id } });

type GalleryCaptionList = components["schemas"]["GalleryCaptionListResponse"];

export function galleryCaptionsQuery(api: Api, sourceId: string, directoryId: string | null) {
  const queryKey = galleryStudioKeys.list(sourceId, directoryId);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }): Promise<GalleryCaptionList> => {
      const previous = client.getQueryData<GalleryCaptionList>(queryKey);
      try {
        return await data(api.client.GET("/api/v1/gallery/sources/{source_id}/captions", {
          params: {
            ...sourcePath(sourceId),
            query: { directory_id: directoryId ?? undefined },
            header: previous?.etag ? { "if-none-match": previous.etag } : undefined,
          },
          signal,
        }));
      } catch (error) {
        if (previous && isApiError(error) && error.status === 304) return client.getQueryData<GalleryCaptionList>(queryKey) ?? previous;
        throw error;
      }
    },
  });
}

export function galleryStudioDirectoryQuery(api: Api, directoryId: string) {
  return queryOptions({
    queryKey: [...libraryKeys.all, "studio-directory-label", directoryId] as const,
    queryFn: async ({ signal }) => (await data(api.client.GET("/api/v1/gallery/directories/{directory_id}/entries", {
      params: { path: { directory_id: directoryId }, query: { view: "desktop", limit: 1 } },
      signal,
    }))).directory,
  });
}

export function galleryCaptionBatchesQuery(api: Api, sourceId: string) {
  return queryOptions({
    queryKey: galleryStudioKeys.batches(sourceId),
    queryFn: async ({ signal }) => (await data(api.client.GET("/api/v1/gallery/sources/{source_id}/caption-batches", {
      params: { ...sourcePath(sourceId), query: { limit: CAPTION_BATCH_LIMIT } },
      signal,
    }))).items,
  });
}

export function galleryKeptQuery(api: Api, sourceId: string) {
  return queryOptions({
    queryKey: galleryStudioKeys.kept(sourceId),
    queryFn: async ({ signal }): Promise<ReadonlySet<string>> => new Set((await data(api.client.GET(
      "/api/v1/gallery/sources/{source_id}/kept", { params: sourcePath(sourceId), signal },
    ))).asset_ids),
  });
}

export function editGalleryCaption(api: Api, sourceId: string, assetId: string, body: CaptionEditRequest) {
  return data(api.client.PUT("/api/v1/gallery/sources/{source_id}/captions/{asset_id}", {
    params: { path: { source_id: sourceId, asset_id: assetId } }, body,
  }));
}

export function galleryCaptionOps(api: Api, sourceId: string, body: CaptionOpsRequest) {
  return data(api.client.POST("/api/v1/gallery/sources/{source_id}/captions/ops", { params: sourcePath(sourceId), body }));
}

export async function saveGalleryKept(api: Api, client: QueryClient, sourceId: string, assetIds: readonly string[], kept: boolean) {
  const queryKey = galleryStudioKeys.kept(sourceId);
  await data(api.client.PUT("/api/v1/gallery/sources/{source_id}/kept", {
    params: sourcePath(sourceId), body: { asset_ids: [...assetIds], kept },
  }));
  await client.cancelQueries({ queryKey });
  client.setQueryData<ReadonlySet<string>>(queryKey, (current) => {
    if (!current) return current;
    const next = new Set(current);
    for (const id of assetIds) {
      if (kept) next.add(id);
      else next.delete(id);
    }
    return next;
  });
  void client.invalidateQueries({ queryKey });
}


export async function cacheGalleryCaptionEdit(client: QueryClient, sourceId: string, { caption }: CaptionEditResponse) {
  const queryKey = galleryStudioKeys.lists(sourceId);
  await client.cancelQueries({ queryKey });
  client.setQueriesData<GalleryCaptionList>({ queryKey }, (current) => {
    if (!current?.items.some((item) => item.asset_id === caption.asset_id)) return current;
    return { ...current, etag: "", items: current.items.map((item) => item.asset_id === caption.asset_id ? { ...item, ...caption } : item) };
  });
  void invalidateGalleryCaptions(client, sourceId);
  void client.invalidateQueries({ queryKey: libraryKeys.annotation(caption.asset_id) });
}

export async function dropGalleryCaption(client: QueryClient, sourceId: string, assetId: string) {
  const queryKey = galleryStudioKeys.lists(sourceId);
  await client.cancelQueries({ queryKey });
  client.setQueriesData<GalleryCaptionList>({ queryKey }, (current) => {
    if (!current?.items.some((item) => item.asset_id === assetId)) return current;
    return { ...current, etag: "", items: current.items.filter((item) => item.asset_id !== assetId) };
  });
}

export function invalidateGalleryCaptions(client: QueryClient, sourceId: string): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: galleryStudioKeys.lists(sourceId) }),
    client.invalidateQueries({ queryKey: galleryStudioKeys.batches(sourceId) }),
  ]).then(() => {});
}
