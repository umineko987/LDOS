import { describe, expect, it } from "vitest";

import fixture from "./fixtures/tagger_selection_cases.json";
import {
  captionFromTags,
  DEFAULT_TAG_FORMAT,
  effectiveThresholds,
  formatTag,
  groupScores,
  outputCategories,
  selectModel,
  selectTags,
  tagTexts,
  type RatingMode,
  type SelectionModel,
} from "./tagger-select.ts";

interface FixtureModel {
  readonly key: string;
  readonly categories: string[];
  readonly default_thresholds: Record<string, number>;
  readonly candidates: [string, string, number][];
}

/** 和后端 _candidate_body 一样：每个模型一张 [名字, 类别] 表，分数行只写下标。 */
function compile(model: FixtureModel) {
  const table = new Map<string, number>();
  const tags: [string, string][] = [];
  const rows = model.candidates.map(([name, category, score]): [number, number] => {
    const key = JSON.stringify([name, category]);
    let index = table.get(key);
    if (index === undefined) {
      index = tags.length;
      table.set(key, index);
      tags.push([name, category]);
    }
    return [index, score];
  });
  const selection: SelectionModel = { key: model.key, categories: model.categories, default_thresholds: model.default_thresholds, tags };
  return { model: selection, scores: groupScores(selection, rows) };
}

describe("tagger_selection_cases.json", () => {
  it("样例文件是当前版本、数量没变", () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.cases).toHaveLength(45);
  });

  it.each(fixture.cases.map((item) => [item.id, item] as const))("%s", (_id, item) => {
    const policy = {
      thresholds: item.policy.thresholds as Record<string, number>,
      model_thresholds: item.policy.model_thresholds as Record<string, Record<string, number>>,
      categories: item.policy.categories,
      rating_mode: item.policy.rating_mode as RatingMode,
    };
    const entries = (item.models as FixtureModel[]).map(compile);

    const effective = Object.fromEntries(entries.map(({ model }) => [model.key, effectiveThresholds(model, policy)]));
    expect(effective).toEqual(item.expected.effective_thresholds);

    const selected = Object.fromEntries(
      entries.map(({ model, scores }) => [
        model.key,
        selectModel(model, scores, policy).map(({ category, tags }) => ({
          category,
          tags: tags.map(([index, score]) => [model.tags[index]![0], score]),
        })),
      ]),
    );
    expect(selected).toEqual(item.expected.selected);

    const tags = selectTags(entries, policy, item.format);
    expect(tags).toEqual(item.expected.tags);
    expect(captionFromTags(tags)).toBe(item.expected.caption);

    // 预先算好的文本表和阈值走同一条路径，结果不变。
    const cached = entries.map((entry) => ({
      ...entry,
      texts: tagTexts(entry.model, item.format),
      thresholds: effectiveThresholds(entry.model, policy),
    }));
    expect(selectTags(cached, policy, item.format)).toEqual(item.expected.tags);
  });
});

describe("formatTag", () => {
  it("只有纯小写 ASCII 标签换空格，然后转义括号", () => {
    expect(formatTag("long_hair")).toBe("long hair");
    expect(formatTag("Long_Hair")).toBe("Long_Hair");
    expect(formatTag("star_(sky)")).toBe("star_(sky)");
    expect(formatTag("star_(sky)", { underscore_to_space: true, escape_parens: true })).toBe("star_\\(sky\\)");
    expect(formatTag("long_hair", { underscore_to_space: false, escape_parens: false })).toBe("long_hair");
    expect(formatTag(":)", DEFAULT_TAG_FORMAT)).toBe(":)");
  });
});

describe("边界", () => {
  const model: SelectionModel = {
    key: "m",
    categories: ["rating", "general"],
    default_thresholds: { general: 0.4 },
    tags: [
      ["general", "rating"],
      ["sensitive", "rating"],
      ["solo", "general"],
    ],
  };

  it("对不上标签表的下标被丢掉", () => {
    const scores = groupScores(model, [
      [1, 0.9],
      [7, 0.9],
      [2, 0.8],
    ]);
    expect([...scores.keys()]).toEqual(["rating", "general"]);
    expect(scores.get("rating")).toEqual({ tags: [1], scores: [0.9] });
  });

  it("没有 rating 阈值时 argmax 用 0；原型链上的键不算阈值", () => {
    const scores = groupScores(model, [
      [0, 0.2],
      [1, 0.3],
      [2, 0.45],
    ]);
    expect(selectModel(model, scores, {})).toEqual([
      { category: "rating", tags: [[1, 0.3]] },
      { category: "general", tags: [[2, 0.45]] },
    ]);
    // "constructor" 这类键在普通对象的原型上，不能被当成阈值。
    const odd = selectModel({ ...model, categories: ["constructor"] }, new Map([["constructor", { tags: [2], scores: [0.6] }]]), {});
    expect(odd).toEqual([{ category: "constructor", tags: [[2, 0.6]] }]);
    expect(effectiveThresholds(model, { model_thresholds: {} })).toEqual({ general: 0.4 });
  });

  it("显式类别为空数组时用模型的类别", () => {
    expect(outputCategories(model, { categories: [] })).toEqual(["rating", "general"]);
    expect(outputCategories(model, { categories: ["general"] })).toEqual(["general"]);
  });

  it("没有标签时 caption 为空串", () => {
    expect(captionFromTags([])).toBe("");
  });
});
