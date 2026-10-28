import type { ApiClient } from "../../core/api/client";
import { normalizeModelProxyUrl } from "../review/service";
import {
  sanitizeCatalog,
  sanitizeStatus,
  type TaggerCatalogEntry,
  type TaggerStatus,
} from "./model";

export const TAGGER_ENDPOINTS = Object.freeze({
  models: "/api/v1/tagger/models",
  status: "/api/v1/tagger/status",
  prepare: "/api/v1/tagger/models/prepare",
  run: "/api/v1/tagger/run",
  cancel: "/api/v1/tagger/cancel",
});

export interface TaggerRunOptions {
  readonly models: readonly string[];
  readonly assetIds: readonly string[];
  readonly directoryIds?: readonly string[];
  readonly thresholds?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly categories?: readonly string[];
  readonly writeCaptions: boolean;
  readonly overwriteCaptions: boolean;
}

export interface TaggerService {
  readCatalog(signal: AbortSignal): Promise<readonly TaggerCatalogEntry[]>;
  readStatus(signal: AbortSignal): Promise<TaggerStatus>;
  prepare(models: readonly string[], signal: AbortSignal, options?: { token?: string; acceptLicense?: boolean; proxyUrl?: string; downloadProxy?: string }): Promise<void>;
  run(options: TaggerRunOptions, signal: AbortSignal): Promise<void>;
  cancel(signal: AbortSignal): Promise<void>;
}

export function createTaggerService(api: ApiClient): TaggerService {
  return Object.freeze({
    async readCatalog(signal: AbortSignal) {
      return sanitizeCatalog(await api.get(TAGGER_ENDPOINTS.models, { signal }));
    },
    async readStatus(signal: AbortSignal) {
      return sanitizeStatus(await api.get(TAGGER_ENDPOINTS.status, { signal }));
    },
    async prepare(models: readonly string[], signal: AbortSignal, options?: { token?: string; acceptLicense?: boolean; proxyUrl?: string; downloadProxy?: string }) {
      if (!models.length || models.length > 8 || models.some((key) => !key || key.length > 64)) {
        throw new TypeError("invalid_tagger_models");
      }
      const downloadProxy = normalizeModelProxyUrl(options?.downloadProxy ?? "");
      await api.post(TAGGER_ENDPOINTS.prepare, {
        models: [...new Set(models)],
        ...(options?.token ? { token: options.token } : {}),
        ...(options?.acceptLicense ? { accept_license: true } : {}),
        ...(options?.proxyUrl ? { proxy_url: options.proxyUrl } : {}),
        ...(downloadProxy ? { download_proxy: downloadProxy } : {}),
      }, { signal });
    },
    async run(options: TaggerRunOptions, signal: AbortSignal) {
      const { models, assetIds, directoryIds = [] } = options;
      if (!models.length || models.length > 8 || models.some((key) => !key || key.length > 64)) {
        throw new TypeError("invalid_tagger_models");
      }
      if (!assetIds.length && !directoryIds.length) throw new TypeError("invalid_tagger_inputs");
      if (assetIds.length > 200 || assetIds.some((id) => !id || id.length > 128)) {
        throw new TypeError("invalid_tagger_assets");
      }
      if (directoryIds.length > 200 || directoryIds.some((id) => !id || id.length > 128)) {
        throw new TypeError("invalid_tagger_directories");
      }
      await api.post(TAGGER_ENDPOINTS.run, {
        models: [...new Set(models)],
        ...(assetIds.length ? { asset_ids: [...new Set(assetIds)] } : {}),
        ...(directoryIds.length ? { directory_ids: [...new Set(directoryIds)] } : {}),
        ...(options.thresholds && Object.keys(options.thresholds).length ? { thresholds: options.thresholds } : {}),
        ...(options.categories?.length ? { categories: [...options.categories] } : {}),
        write_captions: options.writeCaptions,
        overwrite_captions: options.overwriteCaptions,
      }, { signal });
    },
    async cancel(signal: AbortSignal) {
      await api.post(TAGGER_ENDPOINTS.cancel, {}, { signal });
    },
  });
}
