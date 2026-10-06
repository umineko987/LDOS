import type { ApiClient } from "../../core/api/client";
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
  readonly inputs: readonly string[];
  readonly thresholds?: Readonly<Record<string, number>>;
  readonly categories?: readonly string[];
  readonly writeCaptions: boolean;
  readonly overwriteCaptions: boolean;
}

export interface TaggerService {
  readCatalog(signal: AbortSignal): Promise<readonly TaggerCatalogEntry[]>;
  readStatus(signal: AbortSignal): Promise<TaggerStatus>;
  prepare(models: readonly string[], signal: AbortSignal, options?: { token?: string; acceptLicense?: boolean }): Promise<void>;
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
    async prepare(models: readonly string[], signal: AbortSignal, options?: { token?: string; acceptLicense?: boolean }) {
      if (!models.length || models.length > 8 || models.some((key) => !key || key.length > 64)) {
        throw new TypeError("invalid_tagger_models");
      }
      await api.post(TAGGER_ENDPOINTS.prepare, {
        models: [...new Set(models)],
        ...(options?.token ? { token: options.token } : {}),
        ...(options?.acceptLicense ? { accept_license: true } : {}),
      }, { signal });
    },
    async run(options: TaggerRunOptions, signal: AbortSignal) {
      const { models, inputs } = options;
      if (!models.length || models.length > 8 || models.some((key) => !key || key.length > 64)) {
        throw new TypeError("invalid_tagger_models");
      }
      if (!inputs.length || inputs.length > 16 || inputs.some((path) => !path || path.length > 2048)) {
        throw new TypeError("invalid_tagger_inputs");
      }
      await api.post(TAGGER_ENDPOINTS.run, {
        models: [...new Set(models)],
        inputs: [...inputs],
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
