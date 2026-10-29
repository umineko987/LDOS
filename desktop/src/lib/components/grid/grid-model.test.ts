import { describe, expect, it } from "vitest";

import {
  clickSelection,
  EMPTY_SELECTION,
  extendSelection,
  gridLayout,
  MAX_GRID_CELLS,
  moveFocus,
  overscanRows,
  retainSelection,
  rowCount,
  selectAll,
  selectionTargets,
  type SelectionState,
} from "./grid-model.ts";

const OPTIONS = { minCellWidth: 112, gap: 6, aspect: 4 / 3, padding: 28 };
const ORDER = ["a", "b", "c", "d", "e", "f"];
const ids = (state: SelectionState) => [...state.selected].sort();

describe("gridLayout", () => {
  it("按最小宽度算列数，格子把剩余宽度分掉", () => {
    const layout = gridLayout(1000, OPTIONS);
    // 内宽 944：(944 + 6) / 118 = 8 列，每格 (944 − 42) / 8 = 112.75 → 112。
    expect(layout).toEqual({ columns: 8, cellWidth: 112, cellHeight: 149, rowHeight: 155 });
  });

  it("至少一列，可以限制最大列数，宽度无效当 0", () => {
    expect(gridLayout(40, OPTIONS).columns).toBe(1);
    expect(gridLayout(40, OPTIONS).cellWidth).toBe(0);
    expect(gridLayout(4000, { ...OPTIONS, maxColumns: 4 }).columns).toBe(4);
    expect(gridLayout(Number.NaN, OPTIONS)).toMatchObject({ columns: 1, cellWidth: 0, cellHeight: 0, rowHeight: 6 });
  });
});

describe("rowCount / overscanRows", () => {
  it("向上取整", () => {
    expect(rowCount(0, 4)).toBe(0);
    expect(rowCount(9, 4)).toBe(3);
    expect(rowCount(9, 0)).toBe(9);
  });

  it("可见行加上两侧预渲染不超过 DOM 预算", () => {
    // 8 列：预算 37 行；视口 800 / 155 → 7 行可见，预渲染取偏好的 3。
    expect(overscanRows(800, 155, 8)).toBe(3);
    // 20 列：预算 15 行，可见 7 行 → 每侧 4，取上限 3；预算更紧时降下来。
    expect(overscanRows(800, 155, 20, { maxCells: 200 })).toBe(1);
    expect(overscanRows(1600, 80, 30)).toBe(0);
    for (const columns of [1, 4, 8, 12, 20]) {
      const overscan = overscanRows(800, 155, columns);
      const visible = Math.ceil(800 / 155) + 1;
      expect((visible + 2 * overscan) * columns).toBeLessThanOrEqual(Math.max(MAX_GRID_CELLS, visible * columns));
    }
    expect(overscanRows(800, 0, 8)).toBe(0);
  });
});

describe("moveFocus", () => {
  // 10 格、4 列：
  //  0 1 2 3
  //  4 5 6 7
  //  8 9
  it("左右在两端停住", () => {
    expect(moveFocus(0, "left", 4, 10)).toBe(0);
    expect(moveFocus(3, "right", 4, 10)).toBe(4);
    expect(moveFocus(9, "right", 4, 10)).toBe(9);
  });

  it("上下按列走，最后一行不满时落到最后一格", () => {
    expect(moveFocus(5, "up", 4, 10)).toBe(1);
    expect(moveFocus(1, "up", 4, 10)).toBe(1);
    expect(moveFocus(1, "down", 4, 10)).toBe(5);
    expect(moveFocus(6, "down", 4, 10)).toBe(9);
    expect(moveFocus(9, "down", 4, 10)).toBe(9);
  });

  it("Home / End / 翻页", () => {
    expect(moveFocus(6, "home", 4, 10)).toBe(0);
    expect(moveFocus(2, "end", 4, 10)).toBe(9);
    expect(moveFocus(1, "pagedown", 4, 10, 2)).toBe(9);
    expect(moveFocus(0, "pagedown", 4, 10, 1)).toBe(4);
    expect(moveFocus(9, "pageup", 4, 10, 1)).toBe(5);
    expect(moveFocus(6, "pageup", 4, 10, 5)).toBe(2);
  });

  it("空列表返回 -1，没有焦点时落到第一格", () => {
    expect(moveFocus(3, "right", 4, 0)).toBe(-1);
    expect(moveFocus(-1, "down", 4, 10)).toBe(0);
    expect(moveFocus(-1, "end", 4, 10)).toBe(9);
    expect(moveFocus(42, "left", 4, 10)).toBe(0);
  });
});

describe("clickSelection", () => {
  it("单击只选这一格，再点一次取消", () => {
    const once = clickSelection(EMPTY_SELECTION, ORDER, "b");
    expect(ids(once)).toEqual(["b"]);
    expect(once.anchor).toBe("b");
    expect(ids(clickSelection(once, ORDER, "b"))).toEqual([]);
    expect(ids(clickSelection(once, ORDER, "c"))).toEqual(["c"]);
  });

  it("Ctrl 切换并移动锚点，Shift 选范围", () => {
    let state = clickSelection(EMPTY_SELECTION, ORDER, "b", { toggle: true });
    state = clickSelection(state, ORDER, "e", { toggle: true });
    expect(ids(state)).toEqual(["b", "e"]);
    state = clickSelection(state, ORDER, "c", { range: true });
    expect(ids(state)).toEqual(["c", "d", "e"]);
    expect(state.anchor).toBe("e");
    state = clickSelection(state, ORDER, "a", { range: true, toggle: true });
    expect(ids(state)).toEqual(["a", "b", "c", "d", "e"]);
    state = clickSelection(state, ORDER, "d", { toggle: true });
    expect(ids(state)).toEqual(["a", "b", "c", "e"]);
  });

  it("没有锚点时 Shift 单击当普通单击", () => {
    expect(ids(clickSelection(EMPTY_SELECTION, ORDER, "c", { range: true }))).toEqual(["c"]);
  });
});

describe("extendSelection / selectAll / retainSelection / selectionTargets", () => {
  it("Shift+方向键从锚点或移动前的焦点扩展", () => {
    const fromFocus = extendSelection(EMPTY_SELECTION, ORDER, 1, 3);
    expect(ids(fromFocus)).toEqual(["b", "c", "d"]);
    expect(fromFocus.anchor).toBe("b");
    expect(ids(extendSelection(fromFocus, ORDER, 3, 0))).toEqual(["a", "b"]);
    expect(extendSelection(fromFocus, ORDER, 3, 99)).toBe(fromFocus);
    expect(ids(extendSelection(EMPTY_SELECTION, ORDER, -1, 2))).toEqual(["c"]);
  });

  it("全选保留锚点", () => {
    expect(ids(selectAll(EMPTY_SELECTION, ORDER))).toEqual(ORDER);
    expect(selectAll(EMPTY_SELECTION, ORDER).anchor).toBe("a");
    expect(selectAll(EMPTY_SELECTION, []).anchor).toBeNull();
  });

  it("列表变了时去掉不在里面的选择", () => {
    const state: SelectionState = { selected: new Set(["a", "z"]), anchor: "z" };
    const kept = retainSelection(state, ORDER);
    expect(ids(kept)).toEqual(["a"]);
    expect(kept.anchor).toBeNull();
    const unchanged: SelectionState = { selected: new Set(["a"]), anchor: "a" };
    expect(retainSelection(unchanged, ORDER)).toBe(unchanged);
  });

  it("操作对象：有选择用选择（按列表顺序），否则用焦点", () => {
    expect(selectionTargets({ selected: new Set(["e", "b"]), anchor: null }, ORDER, 0)).toEqual(["b", "e"]);
    expect(selectionTargets(EMPTY_SELECTION, ORDER, 2)).toEqual(["c"]);
    expect(selectionTargets(EMPTY_SELECTION, ORDER, -1)).toEqual([]);
  });
});
