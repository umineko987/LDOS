import { describe, expect, it } from "vitest";

import type { components } from "#lib/api/schema.d.ts";

import { categoryIndex } from "./captions.ts";
import {
  activeCategories,
  categoryOptions,
  composeTags,
  fromTaggerRequest,
  indexCandidates,
  lastRunInterrupted,
  latestTagBatch,
  planTagging,
  roundThreshold,
  savedTagSettings,
  settingsPolicy,
  sliderCategories,
  thresholdMin,
  thresholdOverrides,
  type CaptionEntry,
  type TagSettings,
} from "./tag-plan.ts";
import { DEFAULT_TAG_FORMAT } from "./tagger-select.ts";

type CandidatesResponse = components["schemas"]["TaggerCandidatesResponse"];

const MODEL = {
  key: "wd",
  adapter: "wd_onnx",
  revision: "r",
  fingerprint: "f",
  vocabulary_fingerprint: "v",
  vocabulary_size: 6,
  categories: ["rating", "general", "character"],
  default_thresholds: { rating: 0, general: 0.35, character: 0.85 },
  tags: [
    ["general", "rating"],
    ["sensitive", "rating"],
    ["1girl", "general"],
    ["long_hair", "general"],
    ["hat", "general"],
    ["hatsune_miku", "character"],
  ] as [string, string][],
};

const RESPONSE: CandidatesResponse = {
  dataset_id: "d1",
  floor: 0.01,
  models: [MODEL],
  items: {
    a: {
      status: "ok",
      reason: "",
      missing_models: [],
      scores: {
        wd: [
          [0, 0.7],
          [1, 0.2],
          [2, 0.99],
          [3, 0.5],
          [4, 0.3],
          [5, 0.9],
        ],
      },
    },
    b: {
      status: "ok",
      reason: "",
      missing_models: [],
      scores: {
        wd: [
          [0, 0.1],
          [1, 0.8],
          [2, 0.95],
          [4, 0.6],
        ],
      },
    },
    c: { status: "missing_scores", reason: "", missing_models: ["wd"], scores: {} },
    d: { status: "ok", reason: "", missing_models: [], scores: {} },
  },
  stats: { total: 4, ok: 3, missing_scores: 1, decode_error: 0, unreadable: 0, unavailable: 0 },
};

const SETTINGS: TagSettings = { thresholds: {}, categories: null, format: DEFAULT_TAG_FORMAT };

describe("indexCandidates / composeTags", () => {
  it("只收 status 为 ok 的图，按模型分组", () => {
    const index = indexCandidates(RESPONSE);
    expect(index.floor).toBe(0.01);
    expect(index.total).toBe(4);
    expect([...index.items.keys()]).toEqual(["a", "b", "d"]);
    expect(index.items.get("a")![0]!.get("general")).toEqual({ tags: [2, 3, 4], scores: [0.99, 0.5, 0.3] });
    expect(index.items.get("d")![0]!.size).toBe(0);
  });

  it("按默认阈值组标签，并记下每个文本的类别", () => {
    const composed = composeTags(indexCandidates(RESPONSE), SETTINGS);
    expect(composed.tags.get("a")).toEqual(["general", "1girl", "long hair", "hatsune miku"]);
    expect(composed.tags.get("b")).toEqual(["sensitive", "1girl", "hat"]);
    expect(composed.tags.get("d")).toEqual([]);
    expect(composed.categories.get("hatsune miku")).toBe("character");
    expect(composed.categories.get("sensitive")).toBe("rating");
  });

  it("阈值覆盖、类别过滤和格式都生效", () => {
    const composed = composeTags(indexCandidates(RESPONSE), {
      thresholds: { wd: { general: 0.55 } },
      categories: ["character", "general"],
      format: { underscore_to_space: false, escape_parens: false },
    });
    expect(composed.tags.get("a")).toEqual(["hatsune_miku", "1girl"]);
    expect(composed.tags.get("b")).toEqual(["1girl", "hat"]);
    expect(settingsPolicy(SETTINGS)).toEqual({ model_thresholds: {}, categories: [], rating_mode: "argmax" });
  });
});

describe("planTagging", () => {
  const composed = composeTags(indexCandidates(RESPONSE), { ...SETTINGS, categories: ["general", "character"] });
  const lookup = categoryIndex([[["my_style", "artist"]]]);
  const captions: CaptionEntry[] = [
    { asset_id: "a", state: "normal", tags: ["sks", "1girl", "my style"] },
    { asset_id: "b", state: "missing", tags: [] },
    { asset_id: "c", state: "normal", tags: ["sks", "solo"] },
    { asset_id: "d", state: "io_error", tags: [] },
    { asset_id: "e", state: "normal", tags: ["sks", "1girl"] },
  ];

  it("merge：保留现有标签，补上打标结果；没结果的跳过", () => {
    const plan = planTagging(captions, composed, { mode: "merge", triggerWord: "sks", categoryOf: lookup });
    expect(plan.total).toBe(5);
    expect(plan.planned).toBe(2);
    expect(plan.skipped).toBe(3);
    expect(plan.changes).toEqual([
      {
        asset_id: "a",
        change: "changed",
        before: ["sks", "1girl", "my style"],
        after: ["sks", "1girl", "my style", "long hair", "hatsune miku"],
        added: ["long hair", "hatsune miku"],
        removed: [],
      },
      { asset_id: "b", change: "new", before: [], after: ["sks", "1girl", "hat"], added: ["sks", "1girl", "hat"], removed: [] },
    ]);
    expect(plan.added).toBe(5);
    expect(plan.removed).toBe(0);
    expect(plan.averageTags).toBe((4 + 2) / 2);
    expect(plan.frequency).toEqual([
      { tag: "1girl", category: "general", count: 3, delta: 1 },
      { tag: "hat", category: "general", count: 1, delta: 1 },
      { tag: "hatsune miku", category: "character", count: 1, delta: 1 },
      { tag: "long hair", category: "general", count: 1, delta: 1 },
      { tag: "my style", category: "artist", count: 1, delta: 0 },
      { tag: "solo", category: "general", count: 1, delta: 0 },
    ]);
  });

  it("overwrite：手加的标签被换掉，频率里显示减少", () => {
    const plan = planTagging(captions, composed, { mode: "overwrite", triggerWord: "sks" });
    expect(plan.changes.map((change) => change.asset_id)).toEqual(["a", "b"]);
    expect(plan.changes[0]!.removed).toEqual(["my style"]);
    expect(plan.removed).toBe(1);
    expect(plan.frequency.find((row) => row.tag === "my style")).toEqual({ tag: "my style", category: "general", count: 0, delta: -1 });
  });

  it("fill_empty：只有空 caption 会变；没有可写的图时平均数为 0", () => {
    const plan = planTagging(captions, composed, { mode: "fill_empty", triggerWord: "sks" });
    expect(plan.changes.map((change) => change.asset_id)).toEqual(["b"]);
    expect(planTagging([], composed, { mode: "merge" }).averageTags).toBe(0);
  });

  it("结果和现有 caption 一样时不算改动", () => {
    const same = planTagging([{ asset_id: "b", state: "normal", tags: ["1girl", "hat"] }], composed, { mode: "overwrite" });
    expect(same.changes).toEqual([]);
    expect(same.planned).toBe(1);
  });
});

describe("thresholdOverrides / thresholdMin / roundThreshold", () => {
  it("只保留和默认值不同、模型认得的类别", () => {
    expect(
      thresholdOverrides([MODEL, { key: "other", default_thresholds: { general: 0.5 } }], {
        wd: { general: 0.35, character: 0.7, artist: 0.5 },
        other: { general: 0.5 },
        missing: { general: 0.2 },
      }),
    ).toEqual({ wd: { character: 0.7 } });
  });

  it("rating 默认 0 时可以拖到 0，其余不低于 floor", () => {
    expect(thresholdMin("rating", 0, 0.01)).toBe(0);
    expect(thresholdMin("rating", 0.41, 0.01)).toBe(0.01);
    expect(thresholdMin("general", 0.35, 0.05)).toBe(0.05);
    expect(thresholdMin("general", 0.35, 0)).toBe(0.01);
  });

  it("对齐到 0.01", () => {
    expect(roundThreshold(0.35000000000000003)).toBe(0.35);
    expect(roundThreshold(0.416)).toBe(0.42);
  });
});

describe("打标页的选项和请求", () => {
  const PIXAI = {
    key: "pixai",
    categories: ["general", "character", "style", "copyright", "meta", "rating", "artist"],
    default_thresholds: { general: 0.17, character: 0.27, style: 0.15, copyright: 0.24, meta: 0.17, rating: 0.41, artist: 0.3 },
  };

  it("类别选项取并集，按 caption 顺序；默认不勾评级、元信息、质量", () => {
    const options = categoryOptions([MODEL, PIXAI]);
    expect(options).toEqual(["character", "copyright", "style", "general", "meta", "rating"]);
    expect(activeCategories(options, null)).toEqual(["character", "copyright", "style", "general"]);
    expect(activeCategories(options, ["rating", "general", "quality"])).toEqual(["general", "rating"]);
    expect(categoryOptions([])).toEqual([]);
  });

  it("滑块只给后端认得、有默认阈值的类别", () => {
    expect(sliderCategories(MODEL)).toEqual(["character", "general", "rating"]);
    expect(sliderCategories(PIXAI)).toEqual(["character", "copyright", "style", "general", "meta", "rating"]);
  });

  it("fromTaggerRequest 只带改过的阈值，格式取反成 keep_underscores", () => {
    expect(
      fromTaggerRequest({
        models: [MODEL],
        thresholds: { wd: { general: 0.4, character: 0.85 } },
        categories: ["character", "general"],
        format: { underscore_to_space: false, escape_parens: true },
        mode: "overwrite",
      }),
    ).toEqual({
      models: ["wd"],
      mode: "overwrite",
      thresholds: { wd: { general: 0.4 } },
      categories: ["character", "general"],
      keep_underscores: true,
      escape_parens: true,
    });
  });

  it("savedTagSettings 从批次参数还原设置，坏字段丢掉", () => {
    expect(
      savedTagSettings({
        models: ["wd", 3, ""],
        thresholds: { wd: { general: 0.4, bad: "x" }, empty: {}, junk: 1 },
        categories: ["general"],
        keep_underscores: true,
        escape_parens: false,
      }),
    ).toEqual({
      models: ["wd"],
      thresholds: { wd: { general: 0.4 } },
      categories: ["general"],
      format: { underscore_to_space: false, escape_parens: false },
    });
    expect(savedTagSettings({ models: ["wd"], categories: [] })).toEqual({
      models: ["wd"],
      thresholds: {},
      categories: null,
      format: DEFAULT_TAG_FORMAT,
    });
    expect(savedTagSettings({ models: "wd" })).toBeNull();
  });

  it("latestTagBatch 取最近一次没撤销的打标写入", () => {
    const batches = [
      { batch_id: "e", kind: "edit" as const, undone_at: null },
      { batch_id: "t2", kind: "from_tagger" as const, undone_at: 5 },
      { batch_id: "t1", kind: "from_tagger" as const, undone_at: null },
    ];
    expect(latestTagBatch(batches)?.batch_id).toBe("t1");
    expect(latestTagBatch(undefined)).toBeUndefined();
  });
});

describe("lastRunInterrupted", () => {
  it("只看最近一次运行，要求 failed + interrupted", () => {
    expect(lastRunInterrupted([{ status: "failed", error_code: "interrupted" }, { status: "succeeded", error_code: "" }])).toBe(true);
    expect(lastRunInterrupted([{ status: "succeeded", error_code: "" }, { status: "failed", error_code: "interrupted" }])).toBe(false);
    expect(lastRunInterrupted([{ status: "failed", error_code: "tagger_failed" }])).toBe(false);
    expect(lastRunInterrupted([])).toBe(false);
    expect(lastRunInterrupted(undefined)).toBe(false);
  });
});
