import {
  clickSelection,
  EMPTY_SELECTION,
  extendSelection,
  retainSelection,
  selectAll,
  selectionTargets,
  type ClickModifiers,
  type SelectionState,
} from "./grid-model.ts";

/**
 * 网格的多选状态。页面创建一个交给 `<VirtualGrid selection>`，工具栏读 `size`、
 * 用 `targets()` 取操作对象；网格负责点选、Shift 范围、全选和 Esc 清空。
 */
export class GridSelection {
  #state = $state.raw<SelectionState>(EMPTY_SELECTION);

  get state(): SelectionState {
    return this.#state;
  }

  get size(): number {
    return this.#state.selected.size;
  }

  get ids(): ReadonlySet<string> {
    return this.#state.selected;
  }

  has(id: string): boolean {
    return this.#state.selected.has(id);
  }

  click(order: readonly string[], id: string, modifiers?: ClickModifiers): void {
    this.#state = clickSelection(this.#state, order, id, modifiers);
  }

  extend(order: readonly string[], from: number, to: number): void {
    this.#state = extendSelection(this.#state, order, from, to);
  }

  selectAll(order: readonly string[]): void {
    this.#state = selectAll(this.#state, order);
  }

  retain(order: readonly string[]): void {
    const next = retainSelection(this.#state, order);
    if (next !== this.#state) this.#state = next;
  }

  /** 清空选择；本来就是空的返回 false（Esc 链继续往下走）。 */
  clear(): boolean {
    if (this.#state.selected.size === 0 && this.#state.anchor === null) return false;
    const had = this.#state.selected.size > 0;
    this.#state = EMPTY_SELECTION;
    return had;
  }

  /** 操作对象：有选择用选择（按列表顺序），否则用焦点那一格。 */
  targets(order: readonly string[], focus: number): string[] {
    return selectionTargets(this.#state, order, focus);
  }
}
