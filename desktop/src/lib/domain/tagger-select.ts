// 打标阈值筛选的前端移植：tagger/postprocess.py 的 select()、format_tag()、merge_selections()。
//
// 打标页拖动阈值时，用候选分数（GET tagger/candidates）在浏览器里重算每张图会得到的标签，
// 不重跑推理。结果必须和后端 compose 逐位一致：fixtures/tagger_selection_cases.json 由生产代码生成，
// 测试逐个样例比对。规则（详见 tagger/tools/gen_selection_cases.py 的说明）：
// - 生效阈值 = {...模型默认, ...全局, ...按模型覆盖}；
// - 输出类别 = policy.categories（非空时原样使用，重复项保留），否则模型词表里类别首次出现的顺序；
// - rating + argmax：按词表顺序取第一个最大值，>= thresholds.rating（缺省 0）才选中；
// - 其余类别：score >= (thresholds[类别] ?? 0.5)，保持词表顺序；双精度比较，不取整；
// - 合并：模型顺序 → 输出类别顺序 → 词表顺序，按最终文本去重，先出现者保留。

export type RatingMode = "argmax" | "threshold";
export type Thresholds = Readonly<Record<string, number>>;

export interface SelectionPolicy {
  /** 全局阈值（类别 → 值）。 */
  readonly thresholds?: Thresholds;
  /** 按模型覆盖的阈值（模型 key → 类别 → 值），优先于全局。 */
  readonly model_thresholds?: Readonly<Record<string, Thresholds>>;
  /** 输出哪些类别、按什么顺序；空表示模型的全部类别。 */
  readonly categories?: readonly string[];
  readonly rating_mode?: RatingMode;
}

export interface TagFormat {
  /** 纯 [a-z0-9_] 的标签把下划线换成空格（后端 keep_underscores 的反面）。 */
  readonly underscore_to_space: boolean;
  /** 括号转义成 \( \)。 */
  readonly escape_parens: boolean;
}

export const DEFAULT_TAG_FORMAT: TagFormat = { underscore_to_space: true, escape_parens: false };

/** 一个模型的词表信息（与 TaggerCandidateModel 同构）：类别顺序、默认阈值、标签表（下标 → [名字, 类别]）。 */
export interface SelectionModel {
  readonly key: string;
  readonly categories: readonly string[];
  readonly default_thresholds: Thresholds;
  readonly tags: readonly (readonly [string, string])[];
}

/** 一个类别里的候选：标签下标和分数一一对应，保持词表顺序。 */
export interface ScoreGroup {
  readonly tags: readonly number[];
  readonly scores: readonly number[];
}

/** 一张图在一个模型下的候选分数，按类别分组。 */
export type GroupedScores = ReadonlyMap<string, ScoreGroup>;

/** select() 的一项输出：类别和选中的 [标签下标, 分数]，保持词表顺序。 */
export interface CategorySelection {
  readonly category: string;
  readonly tags: readonly (readonly [number, number])[];
}

export interface SelectedTag {
  readonly name: string;
  readonly text: string;
  readonly category: string;
  readonly score: number;
  readonly model: string;
}

const PLAIN_TAG = /^[a-z0-9_]+$/;

function own(record: Thresholds | undefined, key: string): number | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function effectiveThresholds(
  model: Pick<SelectionModel, "key" | "default_thresholds">,
  policy: SelectionPolicy,
): Record<string, number> {
  const overrides = policy.model_thresholds && Object.hasOwn(policy.model_thresholds, model.key)
    ? policy.model_thresholds[model.key]
    : undefined;
  return { ...model.default_thresholds, ...policy.thresholds, ...overrides };
}

export function outputCategories(model: Pick<SelectionModel, "categories">, policy: SelectionPolicy): readonly string[] {
  return policy.categories?.length ? policy.categories : model.categories;
}

/** 分数行（[标签下标, 分数]，词表顺序）按类别分组。对不上标签表的下标丢掉。 */
export function groupScores(model: Pick<SelectionModel, "tags">, rows: readonly (readonly [number, number])[]): GroupedScores {
  const groups = new Map<string, { tags: number[]; scores: number[] }>();
  for (const [index, score] of rows) {
    const entry = model.tags[index];
    if (!entry) continue;
    let group = groups.get(entry[1]);
    if (!group) {
      group = { tags: [], scores: [] };
      groups.set(entry[1], group);
    }
    group.tags.push(index);
    group.scores.push(score);
  }
  return groups;
}

/** 一张图在一个模型下的筛选结果，和输出类别一一对齐（没选中的类别为空）。 */
export function selectModel(
  model: SelectionModel,
  scores: GroupedScores,
  policy: SelectionPolicy,
  thresholds: Thresholds = effectiveThresholds(model, policy),
): CategorySelection[] {
  const argmax = (policy.rating_mode ?? "argmax") === "argmax";
  return outputCategories(model, policy).map((category) => {
    const group = scores.get(category);
    if (!group || group.tags.length === 0) return { category, tags: [] };
    if (category === "rating" && argmax) {
      let best = 0;
      for (let index = 1; index < group.scores.length; index += 1) {
        if (group.scores[index]! > group.scores[best]!) best = index;
      }
      const score = group.scores[best]!;
      return { category, tags: score >= (own(thresholds, "rating") ?? 0) ? [[group.tags[best]!, score]] : [] };
    }
    const threshold = own(thresholds, category) ?? 0.5;
    // 同一类别内重名（同一个下标）：位置取首次，分数取最后一个过阈值的，和 Python dict 一样。
    const picked = new Map<number, number>();
    for (let index = 0; index < group.tags.length; index += 1) {
      const score = group.scores[index]!;
      if (score >= threshold) picked.set(group.tags[index]!, score);
    }
    return { category, tags: [...picked] };
  });
}

/** 标签写进 caption 的文本：只有纯 [a-z0-9_] 标签把下划线换成空格，然后按需转义括号。 */
export function formatTag(name: string, format: TagFormat = DEFAULT_TAG_FORMAT): string {
  let tag = format.underscore_to_space && PLAIN_TAG.test(name) ? name.replaceAll("_", " ") : name;
  if (format.escape_parens) tag = tag.replaceAll("(", "\\(").replaceAll(")", "\\)");
  return tag;
}

/** 一个模型整张标签表的 caption 文本（下标对齐），格式不变时可以复用。 */
export function tagTexts(model: Pick<SelectionModel, "tags">, format: TagFormat = DEFAULT_TAG_FORMAT): string[] {
  return model.tags.map(([name]) => formatTag(name, format));
}

export interface ModelScores {
  readonly model: SelectionModel;
  readonly scores: GroupedScores;
  /** tagTexts(model, format) 的结果；不给时现算。 */
  readonly texts?: readonly string[];
  /** effectiveThresholds(model, policy) 的结果；不给时现算。 */
  readonly thresholds?: Thresholds;
}

/** 多个模型的筛选结果按 模型 → 类别 → 词表 顺序合并，按最终文本去重，先出现者保留。 */
export function selectTags(
  entries: readonly ModelScores[],
  policy: SelectionPolicy,
  format: TagFormat = DEFAULT_TAG_FORMAT,
): SelectedTag[] {
  const merged: SelectedTag[] = [];
  const seen = new Set<string>();
  for (const { model, scores, texts, thresholds } of entries) {
    for (const { category, tags } of selectModel(model, scores, policy, thresholds)) {
      for (const [index, score] of tags) {
        const name = model.tags[index]![0];
        const text = texts?.[index] ?? formatTag(name, format);
        if (seen.has(text)) continue;
        seen.add(text);
        merged.push({ name, text, category, score, model: model.key });
      }
    }
  }
  return merged;
}

export function captionFromTags(tags: readonly Pick<SelectedTag, "text">[]): string {
  return tags.map((tag) => tag.text).join(", ");
}
