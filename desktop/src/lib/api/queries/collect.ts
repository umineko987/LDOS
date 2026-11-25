import { data, idempotent, type Api } from "../client.ts";
import { createIdempotencyKey } from "../ids.ts";
import type { components } from "../schema";

type Schemas = components["schemas"];
export type CollectResolveRequest = Schemas["CollectResolveRequest"];
export type CollectResolveResponse = Schemas["CollectResolveResponse"];
export type CollectBrowseRequest = Schemas["CollectBrowseRequest"];
export type CollectBrowseResponse = Schemas["CollectBrowseResponse"];
export type CollectSubmitRequest = Schemas["CollectSubmitRequest"];
export type CollectSubmitResponse = Schemas["CollectSubmitResponse"];
export type CollectSiteStatus = Schemas["CollectSiteStatus"];

export function resolveCollect(
  api: Api,
  datasetId: string,
  body: CollectResolveRequest,
  signal?: AbortSignal,
): Promise<CollectResolveResponse> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/collect/resolve", {
      params: { path: { dataset_id: datasetId } },
      body,
      signal,
    }),
  );
}

export function browseCollect(
  api: Api,
  datasetId: string,
  body: CollectBrowseRequest,
  signal?: AbortSignal,
): Promise<CollectBrowseResponse> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/collect/browse", {
      params: { path: { dataset_id: datasetId } },
      body,
      signal,
    }),
  );
}

export function submitCollect(
  api: Api,
  datasetId: string,
  body: CollectSubmitRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CollectSubmitResponse> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/collect/submit", {
      params: { path: { dataset_id: datasetId }, header: idempotent(idempotencyKey) },
      body,
      signal,
    }),
  );
}

/**
 * Only local signed media proxy paths returned by the backend (`/api/v1/collect/media/...`)
 * are resolved against `api.resourceUrl`, preventing untrusted external image URLs.
 */
export function collectMediaUrl(api: Api, previewPath?: string | null): string | null {
  if (!previewPath || !previewPath.startsWith("/api/v1/collect/media/")) {
    return null;
  }
  return api.resourceUrl(previewPath);
}

export interface CollectSubmitTracker {
  keyFor(request: CollectSubmitRequest): string;
  reset(): void;
}

/**
 * Keeps the same `Idempotency-Key` across retries of an identical submit payload
 * and mints a fresh key whenever the user alters sources or ranges.
 */
export function createCollectSubmitTracker(
  mint: () => string = () => createIdempotencyKey("collect"),
): CollectSubmitTracker {
  let lastDigest: string | null = null;
  let lastKey: string | null = null;

  return {
    keyFor(request: CollectSubmitRequest): string {
      const digest = JSON.stringify(request);
      if (digest !== lastDigest || !lastKey) {
        lastDigest = digest;
        lastKey = mint();
      }
      return lastKey;
    },
    reset(): void {
      lastDigest = null;
      lastKey = null;
    },
  };
}
