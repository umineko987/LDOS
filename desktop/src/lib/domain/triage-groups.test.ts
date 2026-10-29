import { describe, expect, it } from "vitest";

import type { CleanItem, DedupGroup, TriageMember } from "#lib/api/queries/triage.ts";

import {
  CLEAN_BATCH,
  cleanBatches,
  cleanDecisions,
  dedupDecisions,
  dedupGroupInit,
  memberKept,
  restoreDecision,
  splitDedupGroups,
} from "./triage-groups.ts";

function member(asset_id: string, overrides: Partial<TriageMember> = {}): TriageMember {
  return {
    asset_id,
    source_id: "s",
    name: `${asset_id}.png`,
    relative_path: `${asset_id}.png`,
    thumbnail_url: `/api/v1/gallery/assets/${asset_id}/thumbnail`,
    image_url: `/api/v1/gallery/reviews/r/images/${asset_id}`,
    width: 100,
    height: 100,
    size_bytes: 1,
    format: "png",
    readable: true,
    recommended: false,
    selected: true,
    disposition: "pending",
    trashed: false,
    classification: null,
    quality: {},
    review_metrics: null,
    decision: null,
    error: "",
    ...overrides,
  };
}

function item(asset_id: string, overrides: Partial<CleanItem> = {}): CleanItem {
  return { ...member(asset_id), group_id: `g-${asset_id}`, group_kind: "duplicate", automatic: false, decided: false, reasons: ["monochrome"], ...overrides };
}

function group(group_id: string, members: TriageMember[], overrides: Partial<DedupGroup> = {}): DedupGroup {
  return {
    group_id,
    kind: "duplicate",
    automatic: false,
    decided: false,
    match_levels: [],
    reason: "",
    suggested_keep: [],
    winner_asset_id: null,
    members,
    ...overrides,
  };
}

describe("memberKept", () => {
  it("已落地看 disposition，待定看勾选", () => {
    expect(memberKept({ disposition: "kept", selected: false })).toBe(true);
    expect(memberKept({ disposition: "pending", selected: true })).toBe(true);
    expect(memberKept({ disposition: "pending", selected: false })).toBe(false);
    expect(memberKept({ disposition: "rejected", selected: true })).toBe(false);
    expect(memberKept({ disposition: "failed", selected: true })).toBe(false);
  });
});

describe("cleanBatches", () => {
  it("按批切开，id 取第一张；全部定夺过的批带上定夺", () => {
    const items = [
      item("a", { decided: true, disposition: "rejected" }),
      item("b", { decided: true, disposition: "kept" }),
      item("c"),
      item("d", { selected: false }),
      item("e"),
    ];
    const batches = cleanBatches(items, 2);
    expect(batches.map((batch) => batch.id)).toEqual(["batch:a", "batch:c", "batch:e"]);
    expect(batches[0]).toMatchObject({ items: ["a", "b"], suggested: ["b"], decided: ["b"], minKeep: 0 });
    expect(batches[1]).toMatchObject({ items: ["c", "d"], suggested: ["c"], decided: null });
    expect(batches[2]!.members).toHaveLength(1);
  });

  it("默认一批 CLEAN_BATCH 张；批大小至少 1", () => {
    const items = Array.from({ length: CLEAN_BATCH + 1 }, (_, index) => item(`i${index}`));
    expect(cleanBatches(items).map((batch) => batch.items.length)).toEqual([CLEAN_BATCH, 1]);
    expect(cleanBatches(items.slice(0, 2), 0)).toHaveLength(2);
    expect(cleanBatches([])).toEqual([]);
  });

  it("定夺请求：每张图自己一组", () => {
    const [batch] = cleanBatches([item("a"), item("b")]);
    expect(cleanDecisions(batch!, ["b"])).toEqual([
      { group_id: "g-a", keep: [] },
      { group_id: "g-b", keep: ["b"] },
    ]);
  });
});

describe("去重分组", () => {
  it("推荐项预选；没有推荐时用勾选；已定夺时取保留的", () => {
    const pending = group("g1", [member("a", { recommended: true }), member("b", { selected: false })], { suggested_keep: ["a"] });
    expect(dedupGroupInit(pending)).toEqual({ id: "g1", items: ["a", "b"], suggested: ["a"], decided: null, minKeep: 1 });

    const fallback = group("g2", [member("a", { selected: false }), member("b")], { kind: "unreadable" });
    expect(dedupGroupInit(fallback)).toMatchObject({ suggested: ["b"], minKeep: 0 });

    const decided = group("g3", [member("a", { disposition: "rejected" }), member("b", { disposition: "kept" })], { decided: true, suggested_keep: ["a"] });
    expect(dedupGroupInit(decided).decided).toEqual(["b"]);
  });

  it("定夺请求是一组", () => {
    expect(dedupDecisions("g1", new Set(["a"]))).toEqual([{ group_id: "g1", keep: ["a"] }]);
  });

  it("恢复自动组里的一张：带上已经恢复过的", () => {
    const auto = group("x", [member("a", { disposition: "rejected" }), member("b", { disposition: "kept" })], { kind: "auto_exact", automatic: true });
    expect(restoreDecision(auto, "a")).toEqual({ group_id: "x", keep: ["b", "a"] });
    expect(restoreDecision(auto, "b")).toEqual({ group_id: "x", keep: ["b"] });
  });

  it("自动组和卡组分开", () => {
    const manual = group("m", []);
    const auto = group("a", [], { automatic: true, kind: "auto_compression" });
    expect(splitDedupGroups([manual, auto])).toEqual({ manual: [manual], automatic: [auto] });
  });
});
