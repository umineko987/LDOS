// 共享虚拟网格。用法和属性见 virtual-grid.svelte 顶部的说明。
export { default as VirtualGrid } from "./virtual-grid.svelte";
export { default as ThumbCell } from "./thumb-cell.svelte";
export { GridSelection } from "./selection.svelte.ts";
export { MAX_GRID_CELLS, type GridCellContext, type GridMove, type SelectionState } from "./grid-model.ts";
