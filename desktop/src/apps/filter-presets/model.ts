export interface FilterOptions {
  readonly basic_dedup: boolean;
  readonly filter_monochrome: boolean;
  readonly filter_sketch: boolean;
  readonly filter_character: boolean;
  readonly similarity_groups: boolean;
  readonly reference_asset_ids: readonly string[];
}

export interface FilterPreset {
  readonly id: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly options: FilterOptions;
}

export interface FilterConfig {
  readonly preset_name: string;
  readonly options: FilterOptions;
}

export type FilterCapabilityKey = "filter_monochrome" | "filter_sketch" | "filter_character";
export type FilterCapabilities = Readonly<Record<FilterCapabilityKey, Readonly<{ available: boolean; reason: string }>>>;

export const FILTER_LABELS = Object.freeze({
  basic_dedup: "基础去重",
  filter_monochrome: "单色",
  filter_sketch: "线稿/草图",
  filter_character: "非目标角色",
  similarity_groups: "相似图片分组",
});
export const FILTER_CAPABILITY_KEYS: readonly FilterCapabilityKey[] = Object.freeze([
  "filter_monochrome", "filter_sketch", "filter_character",
]);
export const EMPTY_FILTER_OPTIONS: FilterOptions = Object.freeze({
  basic_dedup: false, filter_monochrome: false, filter_sketch: false,
  filter_character: false, similarity_groups: false, reference_asset_ids: Object.freeze([]),
});

export function filterRecord(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`invalid_${label}`);
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`invalid_${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`invalid_${label}`);
  }
  for (const key of keys) {
    if (!descriptors[key] || !("value" in descriptors[key])) throw new TypeError(`invalid_${label}`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function validateFilterName(raw: unknown): string {
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/u.test(raw)) throw new TypeError("invalid_filter_name");
  const name = raw.trim();
  if (!name || Array.from(name).length > 80) throw new TypeError("invalid_filter_name");
  return name;
}

export function validateFilterId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.length || Array.from(raw).length > 128) throw new TypeError("invalid_filter_id");
  return raw;
}

export function sanitizeFilterOptions(raw: unknown): FilterOptions {
  const keys = [...Object.keys(FILTER_LABELS), "reference_asset_ids"];
  const value = filterRecord(raw, keys, "filter_options");
  for (const key of Object.keys(FILTER_LABELS)) {
    if (typeof value[key] !== "boolean") throw new TypeError("invalid_filter_options");
  }
  if (!Array.isArray(value.reference_asset_ids) || value.reference_asset_ids.length > 200) {
    throw new TypeError("invalid_filter_options");
  }
  const ids = Array.from(value.reference_asset_ids, validateFilterId);
  return Object.freeze({
    basic_dedup: value.basic_dedup as boolean,
    filter_monochrome: value.filter_monochrome as boolean,
    filter_sketch: value.filter_sketch as boolean,
    filter_character: value.filter_character as boolean,
    similarity_groups: value.similarity_groups as boolean,
    reference_asset_ids: Object.freeze(ids),
  });
}

export function cloneFilterOptions(options: FilterOptions): FilterOptions {
  return sanitizeFilterOptions(options);
}

export function sanitizeFilterConfig(raw: unknown): FilterConfig {
  const value = filterRecord(raw, ["preset_name", "options"], "filter_config");
  return Object.freeze({ preset_name: validateFilterName(value.preset_name), options: sanitizeFilterOptions(value.options) });
}

export function sanitizeFilterPreset(raw: unknown): FilterPreset {
  const value = filterRecord(raw, ["id", "name", "builtin", "options"], "filter_preset");
  if (typeof value.builtin !== "boolean") throw new TypeError("invalid_filter_preset");
  return Object.freeze({
    id: validateFilterId(value.id), name: validateFilterName(value.name),
    builtin: value.builtin, options: sanitizeFilterOptions(value.options),
  });
}

export function sanitizeFilterCapabilities(raw: unknown): FilterCapabilities {
  const value = filterRecord(raw, FILTER_CAPABILITY_KEYS, "filter_capabilities");
  const result = {} as Record<FilterCapabilityKey, { available: boolean; reason: string }>;
  for (const key of FILTER_CAPABILITY_KEYS) {
    const item = filterRecord(value[key], ["available", "reason"], "filter_capability");
    if (typeof item.available !== "boolean" || typeof item.reason !== "string" || (!item.available && !item.reason.trim())) {
      throw new TypeError("invalid_filter_capability");
    }
    result[key] = Object.freeze({ available: item.available, reason: item.reason });
  }
  return Object.freeze(result);
}

export type FilterModelKey = "completeness" | "ccip";
export const FILTER_MODELS = Object.freeze({
  completeness: { label: "完成度模型（线稿/草图、单色共用）", megabytes: 16.8 },
  ccip: { label: "角色模型（CCIP feat + metric）", megabytes: 150.3 },
});

/** Only explicitly selected, unready options; both auxiliary classes share one model. */
export function requiredFilterModels(options: FilterOptions, capabilities: FilterCapabilities | null): readonly FilterModelKey[] {
  const models: FilterModelKey[] = [];
  if ((options.filter_monochrome && capabilities?.filter_monochrome.available !== true)
    || (options.filter_sketch && capabilities?.filter_sketch.available !== true)) models.push("completeness");
  if (options.filter_character && capabilities?.filter_character.available !== true) models.push("ccip");
  return models;
}
/** UI labels for enabled functions; no implicit dependency or feature toggling. */
export function filterOptionsSummary(options: FilterOptions): readonly string[] {
  return Object.entries(FILTER_LABELS).filter(([key]) => options[key as keyof typeof FILTER_LABELS]).map(([, label]) => label);
}

/** Execution blockers only. Unready options and empty references remain valid saved drafts. */
export function filterConfigBlockers(options: FilterOptions, capabilities: FilterCapabilities | null): readonly {
  option: FilterCapabilityKey | "reference_asset_ids"; reason: string;
}[] {
  const blockers: { option: FilterCapabilityKey | "reference_asset_ids"; reason: string }[] = [];
  for (const key of FILTER_CAPABILITY_KEYS) {
    if (options[key] && capabilities?.[key]?.available !== true) {
      blockers.push({ option: key, reason: capabilities?.[key]?.reason || "过滤能力未加载，暂不可执行。" });
    }
  }
  if (options.filter_character && options.reference_asset_ids.length === 0) {
    blockers.push({ option: "reference_asset_ids", reason: "执行角色过滤前需添加参考图；空参考图仍可保存为模板。" });
  }
  return blockers;
}
