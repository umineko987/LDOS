// 虚拟网格的纯逻辑：列数和格子尺寸、DOM 预算内的预渲染行数、焦点移动、多选。
// 组件（virtual-grid.svelte）只负责把这些接到 @tanstack/virtual-core 和按键注册表上。

/** WebKitGTK 预算：网格里同时存在的 DOM 格子不超过这个数。 */
export const MAX_GRID_CELLS = 300;

export interface GridLayoutOptions {
  /** 格子最小宽度；容器越宽列越多，格子在 [min, min + gap + min) 之间伸缩。 */
  readonly minCellWidth: number;
  readonly gap: number;
  /** 高 / 宽。缩略图默认 4/3（竖图 3:4）。 */
  readonly aspect: number;
  /** 左右内边距（单侧）。 */
  readonly padding: number;
  readonly maxColumns?: number;
}

export interface GridLayout {
  readonly columns: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** 一行占的高度：格子高 + 行间距。 */
  readonly rowHeight: number;
}

export function gridLayout(width: number, { minCellWidth, gap, aspect, padding, maxColumns }: GridLayoutOptions): GridLayout {
  const inner = Math.max(0, (Number.isFinite(width) ? width : 0) - 2 * padding);
  const fit = Math.floor((inner + gap) / (Math.max(1, minCellWidth) + gap));
  const columns = Math.max(1, Math.min(maxColumns ?? Number.POSITIVE_INFINITY, fit));
  const cellWidth = Math.max(0, Math.floor((inner - gap * (columns - 1)) / columns));
  const cellHeight = Math.round(cellWidth * aspect);
  return { columns, cellWidth, cellHeight, rowHeight: cellHeight + gap };
}

export function rowCount(count: number, columns: number): number {
  return count > 0 ? Math.ceil(count / Math.max(1, columns)) : 0;
}

/**
 * 视口上下各预渲染几行：可见行加上两侧预渲染不超过 {@link MAX_GRID_CELLS} 个格子，最多 `preferred` 行。
 */
export function overscanRows(
  viewportHeight: number,
  rowHeight: number,
  columns: number,
  { maxCells = MAX_GRID_CELLS, preferred = 3 }: { maxCells?: number; preferred?: number } = {},
): number {
  if (rowHeight <= 0 || columns <= 0) return 0;
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const budget = Math.floor(maxCells / columns);
  return Math.max(0, Math.min(preferred, Math.floor((budget - visible) / 2)));
}

export type GridMove = "left" | "right" | "up" | "down" | "home" | "end" | "pageup" | "pagedown";

/**
 * 移动焦点。上下按列走；最后一行不满时向下落到最后一格；已经在边上就不动。
 * 没有焦点（-1）时任何移动都落到第一格（`end` 落到最后一格）。
 */
export function moveFocus(index: number, move: GridMove, columns: number, count: number, pageRows = 1): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const cols = Math.max(1, columns);
  if (index < 0 || index > last) return move === "end" ? last : 0;
  const page = cols * Math.max(1, pageRows);
  switch (move) {
    case "left":
      return Math.max(0, index - 1);
    case "right":
      return Math.min(last, index + 1);
    case "up":
      return index - cols >= 0 ? index - cols : index;
    case "down":
      if (index + cols <= last) return index + cols;
      return Math.floor(index / cols) < Math.floor(last / cols) ? last : index;
    case "home":
      return 0;
    case "end":
      return last;
    case "pageup":
      return Math.max(index % cols, index - page);
    case "pagedown":
      return index + page <= last ? index + page : last;
  }
}

export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  /** Shift 范围选择的起点。 */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = Object.freeze({ selected: new Set<string>(), anchor: null });

export interface ClickModifiers {
  /** Shift：从锚点到这一格。 */
  readonly range?: boolean;
  /** Ctrl / ⌘：切换这一格。 */
  readonly toggle?: boolean;
}

function range(order: readonly string[], from: number, to: number): string[] {
  const [low, high] = from <= to ? [from, to] : [to, from];
  return order.slice(low, high + 1);
}

/**
 * 鼠标点选：
 * - 单击：只选这一格；已经是唯一选中的那一格时取消选择；
 * - Ctrl/⌘：切换这一格，并把它设为锚点；
 * - Shift：选中锚点到这一格的范围（同时按 Ctrl/⌘ 时并入已有选择），锚点不变。
 */
export function clickSelection(
  state: SelectionState,
  order: readonly string[],
  id: string,
  { range: isRange = false, toggle = false }: ClickModifiers = {},
): SelectionState {
  const target = order.indexOf(id);
  const anchor = state.anchor === null ? -1 : order.indexOf(state.anchor);
  if (isRange && target >= 0 && anchor >= 0) {
    const ids = range(order, anchor, target);
    return { selected: new Set(toggle ? [...state.selected, ...ids] : ids), anchor: state.anchor };
  }
  if (toggle) {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
  }
  const only = state.selected.size === 1 && state.selected.has(id);
  return { selected: only ? new Set() : new Set([id]), anchor: id };
}

/** Shift+方向键：选中锚点（没有时取移动前的焦点）到新焦点的范围。 */
export function extendSelection(state: SelectionState, order: readonly string[], from: number, to: number): SelectionState {
  if (to < 0 || to >= order.length) return state;
  const anchorId = state.anchor !== null && order.includes(state.anchor) ? state.anchor : (order[from] ?? order[to]!);
  return { selected: new Set(range(order, order.indexOf(anchorId), to)), anchor: anchorId };
}

export function selectAll(state: SelectionState, order: readonly string[]): SelectionState {
  return { selected: new Set(order), anchor: state.anchor ?? order[0] ?? null };
}

/** 列表变了（换过滤条件、删了图）：去掉已经不在列表里的选择。 */
export function retainSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const present = new Set(order);
  const selected = [...state.selected].filter((id) => present.has(id));
  if (selected.length === state.selected.size && (state.anchor === null || present.has(state.anchor))) return state;
  return { selected: new Set(selected), anchor: state.anchor !== null && present.has(state.anchor) ? state.anchor : null };
}

/** 操作对象：有选择时是选择（按列表顺序），否则是焦点那一格。 */
export function selectionTargets(state: SelectionState, order: readonly string[], focus: number): string[] {
  if (state.selected.size > 0) return order.filter((id) => state.selected.has(id));
  const focused = order[focus];
  return focused === undefined ? [] : [focused];
}

/** `<VirtualGrid>` 的 `cell` 片段参数。 */
export interface GridCellContext<Item> {
  readonly item: Item;
  readonly index: number;
  readonly selected: boolean;
  readonly focused: boolean;
  /** 格子的像素尺寸（随容器宽度变化）。 */
  readonly width: number;
  readonly height: number;
}
