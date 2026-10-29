import { describe, expect, it } from "vitest";

import {
  adoptPlan,
  canToggle,
  createTriage,
  currentGroup,
  decidedOf,
  groupStatus,
  isFinished,
  keepOf,
  lastEntry,
  progress,
  TRIAGE_HISTORY_LIMIT,
  triageReducer,
  type TriageAction,
  type TriageGroupInit,
  type TriageState,
} from "./triage.ts";

const g = (id: string, items: string[], suggested: string[] = items.slice(0, 1), extra: Partial<TriageGroupInit> = {}): TriageGroupInit => ({
  id,
  items,
  suggested,
  ...extra,
});

const GROUPS = [g("g1", ["a", "b", "c"]), g("g2", ["d", "e"]), g("g3", ["f", "g"])];

function run(state: TriageState, ...actions: TriageAction[]): TriageState {
  return actions.reduce(triageReducer, state);
}

const keep = (state: TriageState, group: string) => [...keepOf(state, group)].sort();

describe("createTriage", () => {
  it("按建议初始化保留集合，焦点在第一个待定组", () => {
    const state = createTriage([g("g1", ["a", "b"], ["a"], { decided: ["b"] }), g("g2", ["c"], ["c"])]);
    expect(state.group).toBe(1);
    expect(state.item).toBe(0);
    expect(keep(state, "g1")).toEqual(["b"]);
    expect([...decidedOf(state, "g1")!]).toEqual(["b"]);
    expect(decidedOf(state, "g2")).toBeUndefined();
    expect(groupStatus(state, "g1")).toBe("decided");
    expect(groupStatus(state, "g2")).toBe("pending");
    expect(state.minKeep).toBe(0);
    expect(state.historyLimit).toBe(TRIAGE_HISTORY_LIMIT);
  });

  it("没有组时焦点是 -1；全部已定夺时焦点在第一组", () => {
    const empty = createTriage([]);
    expect(empty.group).toBe(-1);
    expect(empty.item).toBe(-1);
    expect(currentGroup(empty)).toBeUndefined();
    expect(adoptPlan(empty)).toBeNull();
    expect(isFinished(empty)).toBe(false);

    const done = createTriage([g("g1", ["a"], [], { decided: [] })]);
    expect(done.group).toBe(0);
    expect(isFinished(done)).toBe(true);
  });

  it("空组的组内焦点是 -1；建议里不在组内的 id 被忽略", () => {
    const state = createTriage([g("g1", [], ["x"])]);
    expect(state.item).toBe(-1);
    expect(keep(state, "g1")).toEqual([]);
  });

  it("选项会被约束在合法范围", () => {
    const state = createTriage([], { minKeep: -3, historyLimit: 0 });
    expect(state.minKeep).toBe(0);
    expect(state.historyLimit).toBe(1);
  });
});

describe("toggle / set", () => {
  it("切换第 n 张并把焦点移过去", () => {
    const state = run(createTriage(GROUPS), { type: "toggle", index: 1 });
    expect(keep(state, "g1")).toEqual(["a", "b"]);
    expect(state.item).toBe(1);
    const again = run(state, { type: "toggle", index: 0 });
    expect(keep(again, "g1")).toEqual(["b"]);
  });

  it("同一组连续的修改合并成一步历史", () => {
    const state = run(createTriage(GROUPS), { type: "toggle", index: 1 }, { type: "toggle", index: 2 }, { type: "toggle", index: 0 });
    expect(state.history).toHaveLength(1);
    expect(lastEntry(state)).toMatchObject({ kind: "edit", group: "g1", focus: { group: "g1", item: 0 } });
    const undone = run(state, { type: "undo" });
    expect(keep(undone, "g1")).toEqual(["a"]);
    expect(undone.history).toHaveLength(0);
  });

  it("越界或没有组时不变", () => {
    const state = createTriage(GROUPS);
    expect(run(state, { type: "toggle", index: 5 })).toBe(state);
    const empty = createTriage([]);
    expect(run(empty, { type: "toggle", index: 0 })).toBe(empty);
    expect(run(empty, { type: "set", keep: [] })).toBe(empty);
  });

  it("不能低于最少保留数，但焦点仍会移过去", () => {
    const state = createTriage(GROUPS, { minKeep: 1 });
    expect(canToggle(state, 0)).toBe(false);
    expect(canToggle(state, 1)).toBe(true);
    expect(canToggle(state, 9)).toBe(false);
    expect(run(state, { type: "toggle", index: 0 })).toBe(state);
    const moved = run(state, { type: "select", index: 2 }, { type: "toggle", index: 0 });
    expect(moved.item).toBe(0);
    expect(keep(moved, "g1")).toEqual(["a"]);
  });

  it("组自己的 minKeep 覆盖全局；不超过组大小", () => {
    const state = createTriage([g("u", ["a"], ["a"], { minKeep: 0 }), g("big", ["b"], ["b"], { minKeep: 5 })], { minKeep: 1 });
    expect(canToggle(state, 0)).toBe(true);
    const next = run(state, { type: "goto", group: 1 });
    expect(canToggle(next, 0)).toBe(false);
  });

  it("set 换掉整组保留集合，忽略组外 id；低于下限时不变", () => {
    const state = run(createTriage(GROUPS), { type: "set", keep: ["a", "b", "c", "zz"] });
    expect(keep(state, "g1")).toEqual(["a", "b", "c"]);
    expect(run(state, { type: "set", keep: ["a", "b", "c"] })).toBe(state);
    const strict = createTriage(GROUPS, { minKeep: 1 });
    expect(run(strict, { type: "set", keep: [] })).toBe(strict);
  });

  it("set 成相同集合但焦点不同时只换焦点", () => {
    const base = run(createTriage(GROUPS), { type: "select", index: 2 });
    const same = run(base, { type: "toggle", index: 0 }, { type: "toggle", index: 0 });
    expect(keep(same, "g1")).toEqual(["a"]);
    expect(same.item).toBe(0);
  });
});

describe("焦点", () => {
  it("组内焦点不循环", () => {
    const state = createTriage(GROUPS);
    expect(run(state, { type: "focus", delta: -1 })).toBe(state);
    const right = run(state, { type: "focus", delta: 1 }, { type: "focus", delta: 5 });
    expect(right.item).toBe(2);
    expect(run(right, { type: "select", index: 2 })).toBe(right);
    expect(run(right, { type: "select", index: 0 }).item).toBe(0);
  });

  it("换组时组内焦点回到 0；越界被约束", () => {
    const state = run(createTriage(GROUPS), { type: "focus", delta: 2 }, { type: "move", delta: 1 });
    expect(state.group).toBe(1);
    expect(state.item).toBe(0);
    expect(run(state, { type: "move", delta: 9 }).group).toBe(2);
    expect(run(state, { type: "goto", group: -4 }).group).toBe(0);
    expect(run(state, { type: "goto", group: 1 })).toBe(state);
    const empty = createTriage([]);
    expect(run(empty, { type: "move", delta: 1 })).toBe(empty);
  });
});

describe("adopt", () => {
  it("记为已定夺，跳到后面第一个待定组", () => {
    const start = createTriage([g("g1", ["a"]), g("g2", ["b"], ["b"], { decided: ["b"] }), g("g3", ["c"])]);
    expect(adoptPlan(start)).toEqual({ group: "g1", keep: ["a"] });
    const state = run(start, { type: "adopt" });
    expect(state.group).toBe(2);
    expect(groupStatus(state, "g1")).toBe("decided");
    expect(lastEntry(state)).toMatchObject({ kind: "adopt", group: "g1", decided: null, focus: { group: "g1", item: 0 } });
    expect(progress(state)).toEqual({ total: 3, decided: 2, pending: 1 });
  });

  it("后面没有待定组时从头找", () => {
    const start = run(createTriage(GROUPS), { type: "goto", group: 2 }, { type: "adopt" });
    expect(start.group).toBe(0);
  });

  it("全部定夺后停在下一组，最后一组之后停在最后一组", () => {
    const state = run(createTriage(GROUPS), { type: "adopt" }, { type: "adopt" }, { type: "adopt" });
    expect(isFinished(state)).toBe(true);
    expect(state.group).toBe(2);
    expect(state.history).toHaveLength(3);
    const back = run(state, { type: "goto", group: 0 }, { type: "adopt" });
    expect(back.group).toBe(1);
    expect(back.history).toHaveLength(3);
  });

  it("保留列表按成员顺序", () => {
    const state = run(createTriage(GROUPS), { type: "toggle", index: 2 }, { type: "toggle", index: 1 });
    expect(adoptPlan(state)).toEqual({ group: "g1", keep: ["a", "b", "c"] });
  });

  it("已定夺的组改过后状态是 changed，再次定夺会记一步", () => {
    const decided = run(createTriage(GROUPS), { type: "adopt" }, { type: "goto", group: 0 });
    expect(adoptPlan(decided)).toBeNull();
    const changed = run(decided, { type: "toggle", index: 1 });
    expect(groupStatus(changed, "g1")).toBe("changed");
    expect(adoptPlan(changed)).toEqual({ group: "g1", keep: ["a", "b"] });
    const readopted = run(changed, { type: "adopt" });
    expect(lastEntry(readopted)).toMatchObject({ kind: "adopt", group: "g1" });
    expect([...lastEntry(readopted)!.decided!]).toEqual(["a"]);
    const undone = run(readopted, { type: "undo" });
    expect(groupStatus(undone, "g1")).toBe("changed");
    expect(undone.group).toBe(0);
  });

  it("没有组时不变", () => {
    const empty = createTriage([]);
    expect(run(empty, { type: "adopt" })).toBe(empty);
  });
});

describe("undo / revert / mark", () => {
  it("撤销定夺：回到待定，焦点回到那一组那一张", () => {
    const state = run(createTriage(GROUPS), { type: "focus", delta: 1 }, { type: "adopt" }, { type: "undo" });
    expect(groupStatus(state, "g1")).toBe("pending");
    expect(state.group).toBe(0);
    expect(state.item).toBe(1);
    expect(state.history).toHaveLength(0);
  });

  it("给了 entry 时只撤销最近的那一步", () => {
    const state = run(createTriage(GROUPS), { type: "adopt" });
    const entry = lastEntry(state)!.id;
    const later = run(state, { type: "toggle", index: 1 });
    expect(run(later, { type: "undo", entry })).toBe(later);
    expect(groupStatus(run(state, { type: "undo", entry }), "g1")).toBe("pending");
  });

  it("没有历史时撤销不变", () => {
    const state = createTriage(GROUPS);
    expect(run(state, { type: "undo" })).toBe(state);
  });

  it("焦点所在的组没了时撤销保留当前焦点", () => {
    const state = run(createTriage(GROUPS), { type: "adopt" }, { type: "load", groups: GROUPS.slice(1) });
    const undone = run(state, { type: "undo" });
    expect(undone.group).toBe(state.group);
  });

  it("revert 只撤回定夺本身，之后的修改和焦点都保留", () => {
    const adopted = run(createTriage(GROUPS), { type: "adopt" });
    const entry = lastEntry(adopted)!.id;
    const edited = run(adopted, { type: "goto", group: 0 }, { type: "toggle", index: 2 }, { type: "move", delta: 1 });
    const reverted = run(edited, { type: "revert", entry });
    expect(groupStatus(reverted, "g1")).toBe("pending");
    expect(keep(reverted, "g1")).toEqual(["a", "c"]);
    expect(reverted.group).toBe(1);
    expect(reverted.history.map((item) => item.kind)).toEqual(["edit"]);
    expect(run(reverted, { type: "revert", entry })).toBe(reverted);
  });

  it("mark 压一步不改状态的历史，撤销时只弹出它", () => {
    const state = run(createTriage(GROUPS), { type: "toggle", index: 1 }, { type: "mark", label: "auto:x" });
    expect(lastEntry(state)).toMatchObject({ kind: "mark", group: null, label: "auto:x" });
    const undone = run(state, { type: "undo" });
    expect(keep(undone, "g1")).toEqual(["a", "b"]);
    expect(lastEntry(undone)?.kind).toBe("edit");
    // mark 之后再改同一组是新的一步，不和 mark 之前的合并。
    const again = run(state, { type: "toggle", index: 2 });
    expect(again.history).toHaveLength(3);
    const reverted = run(state, { type: "revert", entry: lastEntry(state)!.id });
    expect(reverted.history).toHaveLength(1);
  });

  it("历史超过上限时丢最早的", () => {
    let state = createTriage(GROUPS, { historyLimit: 3 });
    for (let index = 0; index < 5; index += 1) state = run(state, { type: "mark" });
    expect(state.history.map((entry) => entry.id)).toEqual([3, 4, 5]);
    expect(state.seq).toBe(6);
  });
});

describe("load", () => {
  it("已知组保留本地状态，新组按服务器初始化，焦点跟着组 id", () => {
    const local = run(createTriage(GROUPS.slice(0, 2)), { type: "toggle", index: 1 }, { type: "adopt" }, { type: "focus", delta: 1 });
    expect(local.group).toBe(1);
    const refreshed = [
      g("g0", ["z"], ["z"], { decided: ["z"] }),
      g("g1", ["a", "b", "c"], ["c"], { decided: ["c"] }),
      g("g2", ["d", "e"], ["e"]),
      g("g3", ["f"], [], { decided: [] }),
    ];
    const state = run(local, { type: "load", groups: refreshed });
    expect(state.group).toBe(2);
    expect(state.item).toBe(1);
    expect(keep(state, "g1")).toEqual(["a", "b"]);
    expect(keep(state, "g2")).toEqual(["d"]);
    expect(keep(state, "g0")).toEqual(["z"]);
    expect(groupStatus(state, "g0")).toBe("decided");
    expect(groupStatus(state, "g3")).toBe("decided");
    expect(groupStatus(state, "g2")).toBe("pending");
  });

  it("焦点组没了时约束下标；从空状态加载时到第一个待定组", () => {
    const state = run(createTriage(GROUPS), { type: "goto", group: 2 }, { type: "load", groups: GROUPS.slice(0, 1) });
    expect(state.group).toBe(0);
    const fresh = run(createTriage([]), { type: "load", groups: [g("x", ["a"], [], { decided: [] }), g("y", ["b"])] });
    expect(fresh.group).toBe(1);
    const cleared = run(fresh, { type: "load", groups: [] });
    expect(cleared.group).toBe(-1);
    expect(cleared.item).toBe(-1);
  });
});
