import { describe, expect, it } from "vitest";

import {
  blacklistOf,
  BLACKLIST_KEY,
  clampPane,
  draftOp,
  EMPTY_DRAFT,
  expectedVersions,
  filterCaptions,
  indexCaptions,
  latestUndoable,
  toggleBlacklist,
  triageCursor,
  withBlacklist,
} from "./studio.ts";
import { parseQuery } from "./tag-query.ts";

const ITEMS = [
  { asset_id: "a", name: "a.png", tags: ["sks", "1girl", "hat"] },
  { asset_id: "b", name: "b.png", tags: ["sks", "1girl", "long_hair"] },
  { asset_id: "c", name: "c.png", tags: ["sks"] },
];

describe("indexCaptions / filterCaptions", () => {
  const indexed = indexCaptions(ITEMS);

  it("空查询原样返回，其余按查询过滤并保持顺序", () => {
    expect(filterCaptions(indexed, parseQuery(""), new Set())).toEqual(ITEMS);
    expect(filterCaptions(indexed, parseQuery("1girl -hat"), new Set()).map((item) => item.asset_id)).toEqual(["b"]);
    expect(filterCaptions(indexed, parseQuery("long hair"), new Set()).map((item) => item.asset_id)).toEqual([]);
    expect(filterCaptions(indexed, parseQuery("long_hair"), new Set()).map((item) => item.asset_id)).toEqual(["b"]);
  });

  it("is:approved / is:pending 看已校对集合，untagged 不算触发词", () => {
    const approved = new Set(["a"]);
    expect(filterCaptions(indexed, parseQuery("is:approved"), approved).map((item) => item.asset_id)).toEqual(["a"]);
    expect(filterCaptions(indexed, parseQuery("is:pending"), approved).map((item) => item.asset_id)).toEqual(["b", "c"]);
    expect(
      filterCaptions(indexed, parseQuery("untagged"), approved, { triggerWord: "sks" }).map((item) => item.asset_id),
    ).toEqual(["c"]);
  });
});

describe("draftOp", () => {
  it("各种操作从表单组出来，不完整时为 null", () => {
    expect(draftOp({ ...EMPTY_DRAFT, tags: "hat, smile" })).toEqual({ op: "add", tags: ["hat", "smile"], position: "back" });
    expect(draftOp({ ...EMPTY_DRAFT, tags: "hat", position: "front" })).toEqual({ op: "add", tags: ["hat"], position: "front" });
    expect(draftOp({ ...EMPTY_DRAFT, kind: "remove", tags: "hat，hat" })).toEqual({ op: "remove", tags: ["hat"] });
    expect(draftOp({ ...EMPTY_DRAFT, kind: "pin", tags: "solo" })).toEqual({ op: "pin", tags: ["solo"] });
    expect(draftOp({ ...EMPTY_DRAFT, kind: "remove" })).toBeNull();
    expect(draftOp({ ...EMPTY_DRAFT, kind: "replace", from: " hat ", to: "cap" })).toEqual({ op: "replace", from: "hat", to: "cap" });
    expect(draftOp({ ...EMPTY_DRAFT, kind: "replace", from: "hat", to: "hat" })).toBeNull();
    expect(draftOp({ ...EMPTY_DRAFT, kind: "replace", from: "hat" })).toBeNull();
    expect(draftOp({ ...EMPTY_DRAFT, kind: "merge", tags: "cap, hat", into: "hat" })).toEqual({ op: "merge", tags: ["cap"], into: "hat" });
    expect(draftOp({ ...EMPTY_DRAFT, kind: "merge", tags: "hat", into: "hat" })).toBeNull();
    expect(draftOp({ ...EMPTY_DRAFT, kind: "merge", tags: "hat" })).toBeNull();
  });
});

describe("expectedVersions / latestUndoable", () => {
  it("只带选中、有版本的图", () => {
    const items = [
      { asset_id: "a", version: "v1" },
      { asset_id: "b", version: "" },
      { asset_id: "c", version: "v3" },
    ];
    expect(expectedVersions(items, ["a", "b"])).toEqual({ a: "v1" });
  });

  it("最近一个还能撤销的批次", () => {
    const batches = [
      { batch_id: "3", can_undo: true, undone_at: 9 },
      { batch_id: "2", can_undo: false, undone_at: null },
      { batch_id: "1", can_undo: true, undone_at: null },
    ];
    expect(latestUndoable(batches)?.batch_id).toBe("1");
    expect(latestUndoable(undefined)).toBeUndefined();
  });
});

describe("黑名单", () => {
  it("从 config 读，去空白和重复；坏值当空表", () => {
    expect(blacklistOf({ [BLACKLIST_KEY]: [" watermark ", "watermark", 3, "text"] })).toEqual(["watermark", "text"]);
    expect(blacklistOf({ [BLACKLIST_KEY]: "watermark" })).toEqual([]);
    expect(blacklistOf(null)).toEqual([]);
  });

  it("写回时保留 config 里的其他键", () => {
    expect(withBlacklist({ export: { size: 1024 } }, ["a", " a", "b"])).toEqual({ export: { size: 1024 }, [BLACKLIST_KEY]: ["a", "b"] });
    expect(withBlacklist(undefined, [])).toEqual({ [BLACKLIST_KEY]: [] });
  });

  it("切换：有就去掉，没有就加上，空串不变", () => {
    expect(toggleBlacklist(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleBlacklist(["a", "b"], " a ")).toEqual(["b"]);
    expect(toggleBlacklist(["a"], " ")).toEqual(["a"]);
  });
});

describe("triageCursor / clampPane", () => {
  it("当前图还在就停在它上面，不在了落到原位置", () => {
    expect(triageCursor(["a", "b", "c"], "b", 0)).toBe(1);
    expect(triageCursor(["a", "c"], "b", 1)).toBe(1);
    expect(triageCursor(["a", "c"], "x", 5)).toBe(1);
    expect(triageCursor(["a"], null, -2)).toBe(0);
    expect(triageCursor([], "a", 0)).toBe(-1);
  });

  it("栏宽限制在范围内并取整", () => {
    expect(clampPane(100.4, { min: 200, max: 400 })).toBe(200);
    expect(clampPane(512, { min: 200, max: 400 })).toBe(400);
    expect(clampPane(300.6, { min: 200, max: 400 })).toBe(301);
  });
});
