// caption 标签的纯函数：解析、序列化、批量操作的预览、频率表和检查器统计。
//
// 解析和操作是后端 gdl_backend/caption_tags.py 的移植（那边是唯一的写入方，这里只用来即时预览，
// 应用前仍以 dry-run 的结果为准）：
// - 逗号和换行都是分隔符，去首尾空白，丢空标签，重复只留第一次出现；标签按原文精确比较；
// - 触发词（数据集的 trigger_word）在任何变换之后都钉在最前面。

export const CAPTION_SEPARATOR = ", ";

/** 频率表和查询里认得的类别，按标签工作室里分组显示的顺序。 */
export const TAG_CATEGORIES = ["character", "copyright", "artist", "style", "general", "meta", "quality", "rating"] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** 没有词表信息的标签（手加的、模型没见过的）算 general。 */
export const FALLBACK_CATEGORY: TagCategory = "general";

export function isTagCategory(value: string): value is TagCategory {
  return (TAG_CATEGORIES as readonly string[]).includes(value);
}

export function dedupe(tags: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

export function parseCaption(text: string | null | undefined): string[] {
  if (!text) return [];
  return dedupe(text.split(/[,\r\n]/).map((part) => part.trim()));
}

export function formatCaption(tags: Iterable<string>): string {
  return [...tags].join(CAPTION_SEPARATOR);
}

/** 触发词放到最前面；caption 里没有它时补上（触发词为空则只去重）。 */
export function pinTrigger(tags: readonly string[], triggerWord: string): string[] {
  const trigger = triggerWord.trim();
  if (!trigger) return dedupe(tags);
  return dedupe([trigger, ...tags.filter((tag) => tag !== trigger)]);
}

function clean(values: readonly string[]): string[] {
  return dedupe(values.map((value) => value.trim()));
}

export type CaptionOp =
  | { readonly op: "add"; readonly tags: readonly string[]; readonly position?: "front" | "back" }
  | { readonly op: "remove"; readonly tags: readonly string[] }
  | { readonly op: "replace"; readonly from: string; readonly to: string }
  | { readonly op: "merge"; readonly tags: readonly string[]; readonly into: string }
  | { readonly op: "pin"; readonly tags: readonly string[] };

export type CaptionOpKind = CaptionOp["op"];

/**
 * 对一张图的标签执行一个批量操作，返回新列表（输入不变）：
 * - add：追加没有的标签，position=front 时插到最前面；
 * - remove：删掉列出的标签；
 * - replace：from 换成 to，位置不变；to 已存在时只删 from；
 * - merge：tags 里出现的那些（连同 into 本身）合成一个 into，放在第一个出现的位置；
 * - pin：把列出的标签按给定顺序移到最前面（只移动已有的）。
 */
export function applyOp(tags: readonly string[], op: CaptionOp): string[] {
  const current = [...tags];
  switch (op.op) {
    case "add": {
      const additions = clean(op.tags).filter((tag) => !current.includes(tag));
      return dedupe(op.position === "front" ? [...additions, ...current] : [...current, ...additions]);
    }
    case "remove": {
      const removed = new Set(clean(op.tags));
      return current.filter((tag) => !removed.has(tag));
    }
    case "replace": {
      const source = op.from.trim();
      const target = op.to.trim();
      if (!current.includes(source) || source === target) return current;
      if (current.includes(target)) return current.filter((tag) => tag !== source);
      return current.map((tag) => (tag === source ? target : tag));
    }
    case "merge": {
      const sources = new Set(clean(op.tags));
      const target = op.into.trim();
      if (!current.some((tag) => sources.has(tag))) return current;
      const result: string[] = [];
      let placed = false;
      for (const tag of current) {
        if (sources.has(tag) || tag === target) {
          if (!placed) result.push(target);
          placed = true;
          continue;
        }
        result.push(tag);
      }
      return result;
    }
    case "pin": {
      const pinned = clean(op.tags).filter((tag) => current.includes(tag));
      return dedupe([...pinned, ...current]);
    }
  }
}

/** 按顺序执行多个操作；触发词若在结果里，仍放在最前面。 */
export function applyOps(tags: readonly string[], ops: readonly CaptionOp[], triggerWord = ""): string[] {
  let result = [...tags];
  for (const op of ops) result = applyOp(result, op);
  const trigger = triggerWord.trim();
  if (trigger && result.includes(trigger)) result = pinTrigger(result, trigger);
  return result;
}

export const CAPTION_MODES = ["merge", "overwrite", "fill_empty"] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

/**
 * 打标结果和现有 caption 合并成新的标签列表（后端 merge_tagger_tags）：
 * - overwrite：触发词 + 打标结果；
 * - fill_empty：现有 caption 为空时同 overwrite，否则不变；
 * - merge：保留手改。`previous` 是上一次打标写进这张图的标签；不知道时（null）现有标签全算手加的。
 */
export function mergeTaggerTags(
  current: readonly string[],
  taggerTags: readonly string[],
  { previous = null, mode, triggerWord = "" }: { previous?: readonly string[] | null; mode: CaptionMode; triggerWord?: string },
): string[] {
  if (mode === "overwrite") return pinTrigger(taggerTags, triggerWord);
  if (mode === "fill_empty") return current.length ? [...current] : pinTrigger(taggerTags, triggerWord);
  const before = new Set(previous ?? []);
  const now = new Set(current);
  const manualAdded = current.filter((tag) => !before.has(tag));
  const manualRemoved = new Set([...before].filter((tag) => !now.has(tag)));
  const fresh = taggerTags.filter((tag) => !manualRemoved.has(tag));
  return pinTrigger([...manualAdded, ...fresh], triggerWord);
}

export interface TagDiff {
  readonly added: string[];
  readonly removed: string[];
}

export function diffTags(before: readonly string[], after: readonly string[]): TagDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((tag) => !beforeSet.has(tag)),
    removed: before.filter((tag) => !afterSet.has(tag)),
  };
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

// ---- 类别 ----

/** 标签 → 类别；查不到时回 undefined（调用方按 FALLBACK_CATEGORY 处理）。 */
export type CategoryLookup = (tag: string) => TagCategory | undefined;

/** 比较用的标签写法：去掉括号转义、下划线当空格、合并空白、小写。查询和类别查表都用它。 */
export function normalizeTag(tag: string): string {
  return tag
    .replace(/\\([()])/g, "$1")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 从模型标签表（[名字, 类别]）建类别查表；同一个标签多个模型都有时，先给的模型说了算。 */
export function categoryIndex(tables: Iterable<readonly (readonly [string, string])[]>): CategoryLookup {
  const index = new Map<string, TagCategory>();
  for (const table of tables) {
    for (const [name, category] of table) {
      const key = normalizeTag(name);
      if (!index.has(key) && isTagCategory(category)) index.set(key, category);
    }
  }
  return (tag) => index.get(normalizeTag(tag));
}

export function tagCategory(tag: string, lookup: CategoryLookup | undefined): TagCategory {
  return lookup?.(tag) ?? FALLBACK_CATEGORY;
}

// ---- 频率表 ----

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

export interface FrequencyGroup {
  readonly category: TagCategory;
  readonly rows: readonly TagCount[];
}

export interface FrequencyTable {
  /** 统计了多少张图。 */
  readonly total: number;
  /** 触发词单独一行（有图带着它时）。 */
  readonly trigger: TagCount | null;
  /** 按 TAG_CATEGORIES 顺序，组内按张数降序、同数按标签名。没有标签的类别不出现。 */
  readonly groups: readonly FrequencyGroup[];
}

const byCount = (a: TagCount, b: TagCount) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

export function countTags(captions: Iterable<readonly string[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tags of captions) for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
}

export function frequencyTable(
  captions: readonly (readonly string[])[],
  { triggerWord = "", categoryOf }: { triggerWord?: string; categoryOf?: CategoryLookup } = {},
): FrequencyTable {
  const trigger = triggerWord.trim();
  const groups = new Map<TagCategory, TagCount[]>();
  let triggerRow: TagCount | null = null;
  for (const [tag, count] of countTags(captions)) {
    if (trigger && tag === trigger) {
      triggerRow = { tag, count };
      continue;
    }
    const category = tagCategory(tag, categoryOf);
    let rows = groups.get(category);
    if (!rows) {
      rows = [];
      groups.set(category, rows);
    }
    rows.push({ tag, count });
  }
  return {
    total: captions.length,
    trigger: triggerRow,
    groups: TAG_CATEGORIES.flatMap((category) => {
      const rows = groups.get(category);
      return rows ? [{ category, rows: rows.sort(byCount) }] : [];
    }),
  };
}

// ---- 检查器 ----

export interface SelectionTag extends TagCount {
  /** 选中的图全都带着它。 */
  readonly all: boolean;
}

export interface SelectionSummary {
  readonly total: number;
  /** 所有选中图共有的标签（不含触发词），按张数降序。 */
  readonly all: readonly SelectionTag[];
  /** 只有部分图带着的标签，按张数降序。 */
  readonly partial: readonly SelectionTag[];
}

export function selectionSummary(captions: readonly (readonly string[])[], triggerWord = ""): SelectionSummary {
  const trigger = triggerWord.trim();
  const total = captions.length;
  const rows = [...countTags(captions)]
    .filter(([tag]) => !trigger || tag !== trigger)
    .map(([tag, count]) => ({ tag, count, all: count === total }))
    .sort(byCount);
  return { total, all: rows.filter((row) => row.all), partial: rows.filter((row) => !row.all) };
}

// ---- 批量操作预览 ----

export interface CaptionTarget {
  readonly asset_id: string;
  readonly tags: readonly string[];
}

export interface CaptionChange extends TagDiff {
  readonly asset_id: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface OpsPreview {
  readonly total: number;
  readonly changes: readonly CaptionChange[];
}

/** 在本地对选中的图预演一组操作，只列出真的会变的图（和后端 dry-run 的 changed + new 对应）。 */
export function previewOps(targets: readonly CaptionTarget[], ops: readonly CaptionOp[], triggerWord = ""): OpsPreview {
  const changes: CaptionChange[] = [];
  for (const { asset_id, tags } of targets) {
    const after = applyOps(tags, ops, triggerWord);
    if (!sameTags(tags, after)) changes.push({ asset_id, before: tags, after, ...diffTags(tags, after) });
  }
  return { total: targets.length, changes };
}

/** 输入框里的标签：逗号（含全角）或换行分隔，合并空白，去重。 */
export function parseTagInput(text: string): string[] {
  return dedupe(text.split(/[,，\r\n]/).map((tag) => tag.replace(/\s+/g, " ").trim()));
}
