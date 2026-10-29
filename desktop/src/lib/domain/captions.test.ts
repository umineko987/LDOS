import { describe, expect, it } from "vitest";

import {
  applyOp,
  applyOps,
  categoryIndex,
  countTags,
  dedupe,
  diffTags,
  formatCaption,
  frequencyTable,
  isTagCategory,
  mergeTaggerTags,
  normalizeTag,
  parseCaption,
  parseTagInput,
  pinTrigger,
  previewOps,
  sameTags,
  selectionSummary,
  tagCategory,
} from "./captions.ts";

// 和 gallery-dl-backend/tests/test_caption_tags.py 同一组样例：两边的规则必须一致。
describe("parseCaption / formatCaption", () => {
  it("去首尾空白、丢空标签、重复只留第一次", () => {
    expect(parseCaption("  1girl,solo ,, long hair\nsolo,\r\n smile , 1girl ")).toEqual(["1girl", "solo", "long hair", "smile"]);
  });

  it("空串和 null", () => {
    expect(parseCaption(null)).toEqual([]);
    expect(parseCaption(undefined)).toEqual([]);
    expect(parseCaption("")).toEqual([]);
    expect(parseCaption(" , \n ")).toEqual([]);
  });

  it("和 tagger 的分隔符一致，能往返", () => {
    const tags = ["sks", "1girl", "hatsune miku", "tail \\(animal\\)"];
    const text = formatCaption(tags);
    expect(text).toBe("sks, 1girl, hatsune miku, tail \\(animal\\)");
    expect(parseCaption(text)).toEqual(tags);
  });

  it("按原文精确比较", () => {
    expect(parseCaption("Smile, smile, long_hair, long hair")).toEqual(["Smile", "smile", "long_hair", "long hair"]);
  });

  it("dedupe 丢掉空串", () => {
    expect(dedupe(["a", "", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("applyOp / applyOps", () => {
  const base = ["sks", "1girl", "hat", "smile", "red eyes"];

  it("add 追加或插到最前，跳过已有的", () => {
    expect(applyOp(base, { op: "add", tags: ["smile", "outdoors"] })).toEqual([...base, "outdoors"]);
    expect(applyOp(base, { op: "add", tags: ["outdoors"], position: "front" })).toEqual(["outdoors", ...base]);
    expect(applyOp(base, { op: "add", tags: [" outdoors ", "outdoors", ""] })).toEqual([...base, "outdoors"]);
  });

  it("remove", () => {
    expect(applyOp(base, { op: "remove", tags: ["hat", "absent"] })).toEqual(["sks", "1girl", "smile", "red eyes"]);
  });

  it("replace 原位替换；目标已存在时只删掉来源", () => {
    expect(applyOp(base, { op: "replace", from: "hat", to: "cap" })).toEqual(["sks", "1girl", "cap", "smile", "red eyes"]);
    expect(applyOp(base, { op: "replace", from: "hat", to: "smile" })).toEqual(["sks", "1girl", "smile", "red eyes"]);
    expect(applyOp(base, { op: "replace", from: "absent", to: "x" })).toEqual(base);
    expect(applyOp(base, { op: "replace", from: "hat", to: " hat " })).toEqual(base);
  });

  it("merge 合成一个，放在第一个出现的位置", () => {
    expect(applyOp(base, { op: "merge", tags: ["smile", "hat"], into: "happy" })).toEqual(["sks", "1girl", "happy", "red eyes"]);
    expect(applyOp(base, { op: "merge", tags: ["red eyes"], into: "1girl" })).toEqual(["sks", "1girl", "hat", "smile"]);
    expect(applyOp(base, { op: "merge", tags: ["absent"], into: "x" })).toEqual(base);
  });

  it("pin 按给定顺序移到最前，只移已有的", () => {
    expect(applyOp(base, { op: "pin", tags: ["smile", "absent", "hat"] })).toEqual(["smile", "hat", "sks", "1girl", "red eyes"]);
  });

  it("触发词在结果里时仍在最前；不在时不补", () => {
    const result = applyOps(
      base,
      [
        { op: "add", tags: ["solo"], position: "front" },
        { op: "pin", tags: ["smile"] },
      ],
      "sks",
    );
    expect(result).toEqual(["sks", "smile", "solo", "1girl", "hat", "red eyes"]);
    expect(applyOps(["a"], [{ op: "add", tags: ["b"] }], "sks")).toEqual(["a", "b"]);
    expect(applyOps(["a"], [{ op: "add", tags: ["b"] }])).toEqual(["a", "b"]);
  });

  it("不改输入", () => {
    const tags = [...base];
    applyOp(tags, { op: "remove", tags: ["hat"] });
    expect(tags).toEqual(base);
  });
});

describe("mergeTaggerTags", () => {
  it("overwrite 钉上触发词", () => {
    expect(mergeTaggerTags(["manual"], ["1girl", "sks", "solo"], { mode: "overwrite", triggerWord: "sks" })).toEqual([
      "sks",
      "1girl",
      "solo",
    ]);
  });

  it("fill_empty 只动空的", () => {
    expect(mergeTaggerTags(["manual"], ["1girl"], { mode: "fill_empty" })).toEqual(["manual"]);
    expect(mergeTaggerTags([], ["1girl"], { mode: "fill_empty", triggerWord: "sks" })).toEqual(["sks", "1girl"]);
  });

  it("merge 保留手加和手删", () => {
    const previous = ["1girl", "hat", "smile"];
    const current = ["sks", "1girl", "my style", "smile"];
    const fresh = ["1girl", "hat", "smile", "outdoors"];
    expect(mergeTaggerTags(current, fresh, { previous, mode: "merge", triggerWord: "sks" })).toEqual([
      "sks",
      "my style",
      "1girl",
      "smile",
      "outdoors",
    ]);
  });

  it("没有历史时现有标签全算手加的", () => {
    expect(mergeTaggerTags(["hand written", "1girl"], ["1girl", "solo"], { mode: "merge" })).toEqual([
      "hand written",
      "1girl",
      "solo",
    ]);
  });

  it("上次打标给过、这次不给的标签去掉", () => {
    expect(mergeTaggerTags(["1girl", "hat"], ["1girl"], { previous: ["1girl", "hat"], mode: "merge" })).toEqual(["1girl"]);
  });
});

describe("pinTrigger / diffTags / sameTags", () => {
  it("pinTrigger", () => {
    expect(pinTrigger(["a", "sks", "b"], "sks")).toEqual(["sks", "a", "b"]);
    expect(pinTrigger(["a"], " sks ")).toEqual(["sks", "a"]);
    expect(pinTrigger(["a", "a"], "")).toEqual(["a"]);
  });

  it("diffTags", () => {
    expect(diffTags(["a", "b", "c"], ["c", "d", "a"])).toEqual({ added: ["d"], removed: ["b"] });
  });

  it("sameTags 比较顺序", () => {
    expect(sameTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameTags(["a"], ["a", "b"])).toBe(false);
  });
});

describe("类别", () => {
  it("normalizeTag 去转义、下划线当空格、小写", () => {
    expect(normalizeTag("Star_\\(Sky\\)")).toBe("star (sky)");
    expect(normalizeTag("  long   hair ")).toBe("long hair");
  });

  it("categoryIndex 先给的模型说了算，不认得的类别不收", () => {
    const lookup = categoryIndex([
      [
        ["hatsune_miku", "character"],
        ["weird", "unknown"],
      ],
      [
        ["hatsune_miku", "copyright"],
        ["vocaloid", "copyright"],
      ],
    ]);
    expect(lookup("hatsune miku")).toBe("character");
    expect(lookup("Vocaloid")).toBe("copyright");
    expect(lookup("weird")).toBeUndefined();
    expect(tagCategory("weird", lookup)).toBe("general");
    expect(tagCategory("anything", undefined)).toBe("general");
    expect(isTagCategory("style")).toBe(true);
    expect(isTagCategory("trigger")).toBe(false);
  });
});

describe("frequencyTable", () => {
  const lookup = categoryIndex([
    [
      ["hatsune_miku", "character"],
      ["vocaloid", "copyright"],
    ],
  ]);
  const captions = [
    ["sks", "1girl", "hatsune miku", "vocaloid"],
    ["sks", "1girl", "solo"],
    ["solo", "hat"],
  ];

  it("触发词单独一行，其余按类别分组，组内张数降序、同数按名字", () => {
    const table = frequencyTable(captions, { triggerWord: "sks", categoryOf: lookup });
    expect(table.total).toBe(3);
    expect(table.trigger).toEqual({ tag: "sks", count: 2 });
    expect(table.groups.map((group) => group.category)).toEqual(["character", "copyright", "general"]);
    expect(table.groups[2]!.rows).toEqual([
      { tag: "1girl", count: 2 },
      { tag: "solo", count: 2 },
      { tag: "hat", count: 1 },
    ]);
  });

  it("没有触发词时它也只是普通标签", () => {
    const table = frequencyTable(captions);
    expect(table.trigger).toBeNull();
    expect(table.groups).toHaveLength(1);
    expect(table.groups[0]!.rows[0]).toEqual({ tag: "1girl", count: 2 });
  });

  it("countTags", () => {
    expect(countTags([["a", "b"], ["a"]])).toEqual(
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
    );
  });
});

describe("selectionSummary", () => {
  it("分出全部共有和部分共有，不含触发词", () => {
    const summary = selectionSummary(
      [
        ["sks", "1girl", "hat"],
        ["sks", "1girl"],
        ["sks", "1girl", "hat", "smile"],
      ],
      "sks",
    );
    expect(summary.total).toBe(3);
    expect(summary.all).toEqual([{ tag: "1girl", count: 3, all: true }]);
    expect(summary.partial).toEqual([
      { tag: "hat", count: 2, all: false },
      { tag: "smile", count: 1, all: false },
    ]);
  });

  it("没有触发词时都参与统计", () => {
    expect(selectionSummary([["a"]]).all).toEqual([{ tag: "a", count: 1, all: true }]);
  });
});

describe("previewOps", () => {
  it("只列出会变的图，带增删", () => {
    const preview = previewOps(
      [
        { asset_id: "a", tags: ["sks", "1girl", "hat"] },
        { asset_id: "b", tags: ["sks", "1girl"] },
      ],
      [{ op: "remove", tags: ["hat"] }],
      "sks",
    );
    expect(preview.total).toBe(2);
    expect(preview.changes).toEqual([
      { asset_id: "a", before: ["sks", "1girl", "hat"], after: ["sks", "1girl"], added: [], removed: ["hat"] },
    ]);
  });
});

describe("parseTagInput", () => {
  it("逗号（含全角）和换行分隔，合并空白，去重", () => {
    expect(parseTagInput(" red  eyes，smile,\nsmile, ")).toEqual(["red eyes", "smile"]);
  });
});
