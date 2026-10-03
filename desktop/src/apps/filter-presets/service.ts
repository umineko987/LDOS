import type { ApiClient } from "../../core/api/client";
import { isPlainRecord } from "../../core/runtime/sanitize";
import { createReviewService } from "../review/service";
import type { ModelSetupSnapshot } from "../review/model";
import {
  filterRecord, sanitizeFilterCapabilities, sanitizeFilterOptions, sanitizeFilterPreset,
  validateFilterId, validateFilterName,
  type FilterCapabilities, type FilterOptions, type FilterPreset,
} from "./model";

const PRESETS = "/api/v1/gallery/review-presets";

export function createFilterPresetService(api: ApiClient): {
  list(signal?: AbortSignal): Promise<readonly FilterPreset[]>;
  create(name: string, options: FilterOptions): Promise<FilterPreset>;
  update(id: string, name: string, options: FilterOptions): Promise<FilterPreset>;
  remove(id: string): Promise<void>;
  capabilities(signal?: AbortSignal): Promise<FilterCapabilities>;
  readModelSetup(signal: AbortSignal): Promise<ModelSetupSnapshot>;
} {
  function path(id: string): string { return `${PRESETS}/${encodeURIComponent(validateFilterId(id))}`; }
  function body(name: string, options: FilterOptions) {
    return { name: validateFilterName(name), options: sanitizeFilterOptions(options) };
  }
  const setupService = createReviewService(api);
  return Object.freeze({
    async list(signal?: AbortSignal) {
      const response = filterRecord(await api.get(PRESETS, { signal }), ["items"], "filter_preset_list");
      if (!Array.isArray(response.items)) throw new TypeError("invalid_filter_preset_list");
      const items = Array.from(response.items, sanitizeFilterPreset);
      if (new Set(items.map(({ id }) => id)).size !== items.length) throw new TypeError("invalid_filter_preset_list");
      return Object.freeze(items);
    },
    async create(name: string, options: FilterOptions) {
      const preset = sanitizeFilterPreset(await api.post(PRESETS, body(name, options)));
      if (preset.builtin) throw new TypeError("invalid_filter_preset_create");
      return preset;
    },
    async update(id: string, name: string, options: FilterOptions) {
      const preset = sanitizeFilterPreset(await api.request(path(id), "PUT", { body: body(name, options) }));
      if (preset.id !== id) throw new TypeError("invalid_filter_preset_update");
      return preset;
    },
    async remove(id: string) {
      const response = await api.delete(path(id));
      if (response !== null) throw new TypeError("invalid_filter_preset_delete");
    },
    async readModelSetup(signal: AbortSignal) {
      const setup = await setupService.readModelSetup(signal);
      if (!setup.reviewFilters) throw new TypeError("invalid_filter_capabilities");
      return setup;
    },
    async capabilities(signal?: AbortSignal) {
      const response = await api.get("/api/v1/setup/models", { signal });
      if (!isPlainRecord(response)) throw new TypeError("invalid_filter_capabilities");
      const phase = Object.getOwnPropertyDescriptor(response, "phase");
      if (phase && (!("value" in phase) || !["idle", "installing", "ready", "failed"].includes(phase.value))) {
        throw new TypeError("invalid_model_setup_phase");
      }
      const descriptor = Object.getOwnPropertyDescriptor(response, "review_filters");
      if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid_filter_capabilities");
      return sanitizeFilterCapabilities(descriptor.value);
    },
  });
}
