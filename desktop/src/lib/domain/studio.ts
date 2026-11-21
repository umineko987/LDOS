// 标签工作室的纯逻辑：caption 索引和过滤、批量操作的表单、黑名单、校对游标、栏宽。

import { dedupe, parseTagInput, type CaptionOp, type CaptionOpKind } from "./captions.ts";
import { matchQuery, queryTags, type ParsedQuery, type QueryContext } from "./tag-query.ts";

// ---- caption 索引和过滤 ----

export interface StudioCaption {
  readonly asset_id: string;
  readonly name: string;
  readonly tags: readonly string[];
}

export interface IndexedCaption<T extends StudioCaption = StudioCaption> {
  readonly item: T;
  /** normalizeTag 过的标签，查询用；caption 列表不变时不重算。 */
  readonly normalized: ReadonlySet<string>;
}

export function indexCaptions<T extends StudioCaption>(items: readonly T[]): IndexedCaption<T>[] {
  return items.map((item) => ({ item, normalized: queryTags(item.tags) }));
}

/** 按查询过滤，保持原顺序；`approved` 是已校对的图。 */
export function filterCaptions<T extends StudioCaption>(
  indexed: readonly IndexedCaption<T>[],
  query: ParsedQuery,
  approved: ReadonlySet<string>,
  context: QueryContext = {},
): T[] {
  if (!query.terms.length) return indexed.map((entry) => entry.item);
  return indexed
    .filter(({ item, normalized }) =>
      matchQuery(query, { normalized, tags: item.tags, approved: approved.has(item.asset_id) }, context),
    )
    .map((entry) => entry.item);
}

// ---- 批量操作的表单 ----

export interface OpDraft {
  readonly kind: CaptionOpKind;
  /** add / remove / pin / merge 的标签，逗号分隔。 */
  readonly tags: string;
  /** replace 的原标签。 */
  readonly from: string;
  /** replace 的新标签。 */
  readonly to: string;
  /** merge 的目标标签。 */
  readonly into: string;
  readonly position: "front" | "back";
}

export const EMPTY_DRAFT: OpDraft = { kind: "add", tags: "", from: "", to: "", into: "", position: "back" };

/** 表单 → 一个操作；填得不完整（或替换成自己）时返回 null。 */
export function draftOp(draft: OpDraft): CaptionOp | null {
  const tags = parseTagInput(draft.tags);
  switch (draft.kind) {
    case "add":
      return tags.length ? { op: "add", tags, position: draft.position } : null;
    case "remove":
    case "pin":
      return tags.length ? { op: draft.kind, tags } : null;
    case "replace": {
      const from = draft.from.trim();
      const to = draft.to.trim();
      return from && to && from !== to ? { op: "replace", from, to } : null;
    }
    case "merge": {
      const into = draft.into.trim();
      const sources = tags.filter((tag) => tag !== into);
      return into && sources.length ? { op: "merge", tags: sources, into } : null;
    }
  }
}

/** 选中图的当前版本，随批量操作发出去：别处改过的图报冲突，不被覆盖。 */
export function expectedVersions(
  items: readonly { readonly asset_id: string; readonly version: string }[],
  ids: readonly string[],
): Record<string, string> {
  const wanted = new Set(ids);
  const result: Record<string, string> = {};
  for (const item of items) if (wanted.has(item.asset_id) && item.version) result[item.asset_id] = item.version;
  return result;
}

/** 批次历史里最近一个还能撤销的（新→旧）。 */
export function latestUndoable<T extends { readonly can_undo: boolean; readonly undone_at: number | null }>(
  batches: readonly T[] | undefined,
): T | undefined {
  return batches?.find((batch) => batch.can_undo && batch.undone_at === null);
}

// ---- 黑名单 ----

/** 黑名单存在数据集 config 的这个键下；导出时作为 tag_blacklist 的默认值。 */
export const BLACKLIST_KEY = "tag_blacklist";

export function blacklistOf(config: Readonly<Record<string, unknown>> | null | undefined): string[] {
  return storedBlacklist(config) ?? [];
}

/** 标签工作室存过的黑名单；从没存过（或存的不是数组）时为 null，和“存了空表”区分开。 */
export function storedBlacklist(config: Readonly<Record<string, unknown>> | null | undefined): string[] | null {
  const raw = config?.[BLACKLIST_KEY];
  if (!Array.isArray(raw)) return null;
  return dedupe(raw.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()));
}

/** 改黑名单后的完整 config（PATCH 会整体替换 config，其余键原样带上）。 */
export function withBlacklist(config: Readonly<Record<string, unknown>> | null | undefined, tags: readonly string[]): Record<string, unknown> {
  return { ...config, [BLACKLIST_KEY]: dedupe(tags.map((tag) => tag.trim())) };
}

export function toggleBlacklist(list: readonly string[], tag: string): string[] {
  const value = tag.trim();
  if (!value) return [...list];
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

// ---- 校对游标 ----

/**
 * 校对模式当前停在哪一张：当前图还在列表里就是它；不在了（例如 is:pending 下刚校对过、被别处删了）
 * 就落到原来的位置上（超出时取最后一张）。列表为空时返回 -1。
 */
export function triageCursor(order: readonly string[], current: string | null, hint: number): number {
  if (!order.length) return -1;
  if (current !== null) {
    const index = order.indexOf(current);
    if (index >= 0) return index;
  }
  return Math.min(Math.max(0, hint), order.length - 1);
}

// ---- 栏宽 ----

export interface PaneLimits {
  readonly min: number;
  readonly max: number;
}

export function clampPane(width: number, { min, max }: PaneLimits): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}
