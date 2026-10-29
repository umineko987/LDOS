import { describe, expect, it } from "vitest";

import { categoryIndex } from "./captions.ts";
import {
  matchQuery,
  parseQuery,
  queryTagState,
  queryTags,
  queryToken,
  tokenizeQuery,
  toggleQueryTag,
  type QueryItem,
} from "./tag-query.ts";

function item(tags: string[], approved = false): QueryItem {
  return { tags, normalized: queryTags(tags), approved };
}

const lookup = categoryIndex([
  [
    ["hatsune_miku", "character"],
    ["vocaloid", "copyright"],
    ["highres", "meta"],
  ],
]);

const context = { triggerWord: "sks", categoryOf: lookup };

describe("tokenizeQuery", () => {
  it("拆出排除、引号和位置", () => {
    expect(tokenizeQuery('1girl  -hat "star (sky)" -"long hair"')).toEqual([
      { negate: false, quoted: false, text: "1girl", start: 0, end: 5 },
      { negate: true, quoted: false, text: "hat", start: 7, end: 11 },
      { negate: false, quoted: true, text: "star (sky)", start: 12, end: 24 },
      { negate: true, quoted: true, text: "long hair", start: 25, end: 37 },
    ]);
  });

  it("缺右引号时到结尾；空引号和单独的 - 丢掉", () => {
    expect(tokenizeQuery('"open ended').map((token) => token.text)).toEqual(["open ended"]);
    expect(tokenizeQuery('"" - x')).toEqual([{ negate: false, quoted: false, text: "x", start: 5, end: 6 }]);
  });
});

describe("parseQuery", () => {
  it("认得标签、类别、untagged 和 is:", () => {
    expect(parseQuery('Long_Hair -hat cat:Character -cat:meta untagged is:approved -is:pending "cat:x"').terms).toEqual([
      { kind: "tag", negate: false, value: "long hair" },
      { kind: "tag", negate: true, value: "hat" },
      { kind: "category", negate: false, value: "character" },
      { kind: "category", negate: true, value: "meta" },
      { kind: "untagged", negate: false },
      { kind: "approved", negate: false, value: true },
      { kind: "approved", negate: true, value: false },
      { kind: "tag", negate: false, value: "cat:x" },
    ]);
  });

  it("不认得的类别和状态记成错误，其余照常", () => {
    const parsed = parseQuery("cat:people is:done solo");
    expect(parsed.errors).toEqual([
      { kind: "unknown_category", value: "people" },
      { kind: "unknown_state", value: "done" },
    ]);
    expect(parsed.terms).toEqual([{ kind: "tag", negate: false, value: "solo" }]);
  });

  it("只有下划线的标签不算一项", () => {
    expect(parseQuery("_ ").terms).toEqual([]);
  });
});

describe("matchQuery", () => {
  const miku = item(["sks", "1girl", "hatsune miku", "long_hair", "star \\(sky\\)"], true);
  const plain = item(["sks", "1girl", "hat"]);
  const empty = item(["sks"]);

  it("各项之间是“且”", () => {
    const query = parseQuery("1girl -hat");
    expect(matchQuery(query, miku, context)).toBe(true);
    expect(matchQuery(query, plain, context)).toBe(false);
  });

  it("下划线、空格、大小写、括号转义都等价", () => {
    expect(matchQuery(parseQuery("long_hair"), miku)).toBe(true);
    expect(matchQuery(parseQuery('"Long Hair"'), miku)).toBe(true);
    expect(matchQuery(parseQuery('"star (sky)"'), miku)).toBe(true);
  });

  it("类别查表；触发词不算任何类别", () => {
    expect(matchQuery(parseQuery("cat:character"), miku, context)).toBe(true);
    expect(matchQuery(parseQuery("cat:character"), plain, context)).toBe(false);
    expect(matchQuery(parseQuery("-cat:general"), empty, context)).toBe(true);
    expect(matchQuery(parseQuery("cat:general"), item(["sks"]), { categoryOf: lookup })).toBe(true);
  });

  it("untagged：没有标签或只有触发词", () => {
    expect(matchQuery(parseQuery("untagged"), empty, context)).toBe(true);
    expect(matchQuery(parseQuery("untagged"), item([]), context)).toBe(true);
    expect(matchQuery(parseQuery("untagged"), plain, context)).toBe(false);
    expect(matchQuery(parseQuery("-untagged"), plain, context)).toBe(true);
    expect(matchQuery(parseQuery("untagged"), empty)).toBe(false);
  });

  it("is:approved / is:pending", () => {
    expect(matchQuery(parseQuery("is:approved"), miku)).toBe(true);
    expect(matchQuery(parseQuery("is:pending"), plain)).toBe(true);
    expect(matchQuery(parseQuery("is:pending"), { tags: [], normalized: new Set() })).toBe(true);
  });

  it("空查询匹配所有", () => {
    expect(matchQuery(parseQuery("   "), plain)).toBe(true);
  });
});

describe("queryToken / queryTagState / toggleQueryTag", () => {
  it("空格换下划线；像语法的加引号", () => {
    expect(queryToken("long hair")).toBe("long_hair");
    expect(queryToken("star (sky)")).toBe("star_(sky)");
    expect(queryToken("-_-")).toBe('"-_-"');
    expect(queryToken("cat:ears")).toBe('"cat:ears"');
    expect(queryToken("untagged")).toBe('"untagged"');
    expect(queryToken('say "hi"')).toBe("say_hi");
  });

  it("queryTagState", () => {
    const parsed = parseQuery("1girl -long_hair");
    expect(queryTagState(parsed, "1girl")).toBe("include");
    expect(queryTagState(parsed, "long hair")).toBe("exclude");
    expect(queryTagState(parsed, "hat")).toBeNull();
  });

  it("没有就加上，同种就去掉，相反就换过来，其余保留", () => {
    expect(toggleQueryTag("1girl", "long hair")).toBe("1girl long_hair");
    expect(toggleQueryTag("1girl long_hair", "long hair")).toBe("1girl");
    expect(toggleQueryTag("1girl long_hair", "long hair", true)).toBe("1girl -long_hair");
    expect(toggleQueryTag('cat:meta "-_-"', "-_-")).toBe("cat:meta");
    expect(toggleQueryTag("cat:meta untagged", "untagged")).toBe('cat:meta untagged "untagged"');
    expect(toggleQueryTag("", "hat", true)).toBe("-hat");
  });
});
