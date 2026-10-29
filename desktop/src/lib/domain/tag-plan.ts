// 打标页的实时预览：候选分数 → 当前阈值下每张图会得到的标签 → 按写入方式和现有 caption 比较。
//
// 候选分数（GET tagger/candidates）只含 >= floor 的行（rating 总是完整的），阈值不低于 floor 时
// 结果和后端 compose 一致。merge 模式要用到“上一次打标写进去的标签”，前端拿不到，按从没打过标
// 处理（现有标签全算手加的）；所以 merge 下的计数是估计值，以 dry-run 为准。

import type { components } from "#lib/api/schema.d.ts";

import {
  diffTags,
  mergeTaggerTags,
  sameTags,
  tagCategory,
  type CaptionMode,
  type CategoryLookup,
  type TagCategory,
  isTagCategory,
} from "./captions.ts";
import {
  effectiveThresholds,
  groupScores,
  selectTags,
  tagTexts,
  type GroupedScores,
  type SelectionModel,
  type SelectionPolicy,
  type TagFormat,
  type Thresholds,
} from "./tagger-select.ts";

type CandidatesResponse = components["schemas"]["TaggerCandidatesResponse"];
type CaptionState = components["schemas"]["CaptionItem"]["state"];

/** 后端能改写的 caption 状态（caption_service.EDITABLE_STATES），其余的会被跳过。 */
export const EDITABLE_CAPTION_STATES: ReadonlySet<CaptionState> = new Set(["normal", "blank", "missing"]);

export interface CandidateIndex {
  readonly floor: number;
  readonly models: readonly SelectionModel[];
  /** asset_id → 各模型（和 models 对齐）的分组分数；只收 status 为 ok 的图，其余的 compose 也会跳过。 */
  readonly items: ReadonlyMap<string, readonly GroupedScores[]>;
  /** 候选接口统计的图数（tag 阶段的输入）。 */
  readonly total: number;
}

export function indexCandidates(response: CandidatesResponse): CandidateIndex {
  const models: SelectionModel[] = response.models.map(({ key, categories, default_thresholds, tags }) => ({
    key,
    categories,
    default_thresholds,
    tags,
  }));
  const items = new Map<string, GroupedScores[]>();
  for (const [assetId, item] of Object.entries(response.items)) {
    if (item.status !== "ok") continue;
    items.set(
      assetId,
      models.map((model) => groupScores(model, item.scores[model.key] ?? [])),
    );
  }
  return { floor: response.floor, models, items, total: response.stats.total };
}

export interface TagSettings {
  /** 按模型覆盖的阈值（模型 key → 类别 → 值），对应 from-tagger 请求的 thresholds。 */
  readonly thresholds: Readonly<Record<string, Thresholds>>;
  /** 输出的类别；null 表示模型的全部类别。 */
  readonly categories: readonly string[] | null;
  readonly format: TagFormat;
}

export function settingsPolicy(settings: TagSettings): SelectionPolicy {
  return { model_thresholds: settings.thresholds, categories: settings.categories ?? [], rating_mode: "argmax" };
}

export interface ComposedTags {
  /** asset_id → 打标结果（caption 文本，合并后的顺序）。 */
  readonly tags: ReadonlyMap<string, readonly string[]>;
  /** caption 文本 → 选中它的类别（第一次出现的）。 */
  readonly categories: ReadonlyMap<string, string>;
}

export function composeTags(index: CandidateIndex, settings: TagSettings): ComposedTags {
  const policy = settingsPolicy(settings);
  const prepared = index.models.map((model) => ({
    model,
    texts: tagTexts(model, settings.format),
    thresholds: effectiveThresholds(model, policy),
  }));
  const tags = new Map<string, string[]>();
  const categories = new Map<string, string>();
  for (const [assetId, scores] of index.items) {
    const entries = prepared.map((entry, position) => ({ ...entry, scores: scores[position]! }));
    const selected = selectTags(entries, policy, settings.format);
    const texts: string[] = [];
    for (const tag of selected) {
      texts.push(tag.text);
      if (!categories.has(tag.text)) categories.set(tag.text, tag.category);
    }
    tags.set(assetId, texts);
  }
  return { tags, categories };
}

export interface CaptionEntry {
  readonly asset_id: string;
  readonly state: CaptionState;
  readonly tags: readonly string[];
}

export interface TagPlanChange {
  readonly asset_id: string;
  readonly change: "changed" | "new";
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface TagFrequencyRow {
  readonly tag: string;
  readonly category: TagCategory;
  /** 应用后带着这个标签的图数。 */
  readonly count: number;
  /** 相对现有 caption 的变化。 */
  readonly delta: number;
}

export interface TagPlan {
  /** review 阶段输入里的 caption 数。 */
  readonly total: number;
  /** 有打标结果、可以写的图。 */
  readonly planned: number;
  /** 没有打标结果或 caption 不可写，会被跳过的图。 */
  readonly skipped: number;
  /** 会改变的图（changed + new），按 caption 顺序。 */
  readonly changes: readonly TagPlanChange[];
  readonly added: number;
  readonly removed: number;
  /** 应用后平均每张的标签数（不含触发词），只算有结果的图。 */
  readonly averageTags: number;
  /** 应用后的标签频率（不含触发词）：张数降序，同数按变化大小、再按标签名。 */
  readonly frequency: readonly TagFrequencyRow[];
}

export interface PlanOptions {
  readonly mode: CaptionMode;
  readonly triggerWord?: string;
  /** 打标结果里没有的标签（手加的）用它查类别。 */
  readonly categoryOf?: CategoryLookup;
}

export function planTagging(
  captions: readonly CaptionEntry[],
  composed: ComposedTags,
  { mode, triggerWord = "", categoryOf }: PlanOptions,
): TagPlan {
  const trigger = triggerWord.trim();
  const counts = new Map<string, number>();
  const deltas = new Map<string, number>();
  const bump = (map: Map<string, number>, tags: readonly string[], step: number) => {
    for (const tag of tags) if (tag !== trigger) map.set(tag, (map.get(tag) ?? 0) + step);
  };
  const changes: TagPlanChange[] = [];
  let planned = 0;
  let added = 0;
  let removed = 0;
  let tagTotal = 0;
  for (const caption of captions) {
    const tagger = EDITABLE_CAPTION_STATES.has(caption.state) ? composed.tags.get(caption.asset_id) : undefined;
    const before = caption.tags;
    bump(deltas, before, -1);
    if (tagger === undefined) {
      bump(counts, before, 1);
      continue;
    }
    planned += 1;
    const after = mergeTaggerTags(before, tagger, { mode, triggerWord: trigger });
    bump(counts, after, 1);
    tagTotal += after.filter((tag) => tag !== trigger).length;
    if (sameTags(before, after)) continue;
    const diff = diffTags(before, after);
    added += diff.added.length;
    removed += diff.removed.length;
    changes.push({ asset_id: caption.asset_id, change: before.length ? "changed" : "new", before, after, ...diff });
  }
  for (const [tag, count] of counts) deltas.set(tag, (deltas.get(tag) ?? 0) + count);
  const categoryFor = (tag: string): TagCategory => {
    const selected = composed.categories.get(tag);
    return selected !== undefined && isTagCategory(selected) ? selected : tagCategory(tag, categoryOf);
  };
  const frequency = [...deltas]
    .map(([tag, delta]) => ({ tag, category: categoryFor(tag), count: counts.get(tag) ?? 0, delta }))
    .sort((a, b) => b.count - a.count || Math.abs(b.delta) - Math.abs(a.delta) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return {
    total: captions.length,
    planned,
    skipped: captions.length - planned,
    changes,
    added,
    removed,
    averageTags: planned ? tagTotal / planned : 0,
    frequency,
  };
}

/** 阈值和模型默认值不同的才放进请求（后端只认 0.01..0.99；等于默认值时不必覆盖）。 */
export function thresholdOverrides(
  models: readonly Pick<SelectionModel, "key" | "default_thresholds">[],
  values: Readonly<Record<string, Thresholds>>,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const model of models) {
    const current = values[model.key];
    if (!current) continue;
    const overrides: Record<string, number> = {};
    for (const [category, value] of Object.entries(current)) {
      if (!Object.hasOwn(model.default_thresholds, category)) continue;
      if (value === model.default_thresholds[category]) continue;
      overrides[category] = value;
    }
    if (Object.keys(overrides).length) result[model.key] = overrides;
  }
  return result;
}

/** 滑块的最小值：非 rating 类别不能低于候选 floor（否则预览少算）；rating 的行是完整的，默认 0 时可以拖回 0。 */
export function thresholdMin(category: string, defaultValue: number, floor: number): number {
  const minimum = Math.max(0.01, floor);
  if (category === "rating" && defaultValue < minimum) return defaultValue;
  return minimum;
}

export const THRESHOLD_MAX = 0.99;
export const THRESHOLD_STEP = 0.01;

/** 滑块值对齐到 0.01，避免 0.35000000000000003 这种值进请求。 */
export function roundThreshold(value: number): number {
  return Math.round(value * 100) / 100;
}
