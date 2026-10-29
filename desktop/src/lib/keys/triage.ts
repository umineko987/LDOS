// 键盘分诊的纯状态机，清洗和去重两页共用。只有 (state, action) → state，不发请求、不碰 DOM。
//
//   let triage = $state.raw(createTriage(groups, { minKeep: 1 }));
//   const dispatch = (action: TriageAction) => (triage = triageReducer(triage, action));
//
//   dispatch({ type: "toggle", index: 1 });       // 2 键：切换当前组第 2 张的保留
//   const plan = adoptPlan(triage);               // Enter 之前取要提交的 { group, keep }，null 表示不用提交
//   dispatch({ type: "adopt" });                  // 记为已定夺，焦点到下一个待定组
//   dispatch({ type: "undo" });                   // Z：撤销最近一步
//
// 状态：
// - `groups`：分组（id、成员 id、建议保留、服务器已定夺的保留）。1–9 键对应每组前九张。
// - 焦点：`group` 是当前组下标（没有组时 -1），`item` 是组内焦点（空组时 -1）。
// - `keep`：每组当前的保留集合；`decided`：已定夺的组 → 定夺时的保留集合。
//   已定夺的组还能继续改，改过之后 `groupStatus` 是 "changed"，再按 Enter 重新提交。
// - `history`：最多 `historyLimit`（默认 50）步，超出时丢最早的。三种条目：
//   - edit：对同一组连续的切换合并成一步（撤销回到这一串切换之前）；
//   - adopt：一次定夺（撤销回到定夺前，焦点回到那一组）；
//   - mark：页面记下的外部操作（例如去重页恢复自动组里的一张），撤销时状态不变，只是让 Z 的顺序和服务器的批次一致。
//
// 动作（TriageAction）：
// - load：换一份服务器数据（翻页、重新拉取）。已知的组保留本地的保留集合和定夺，新组按服务器初始化；焦点跟着组 id 走。
// - toggle：切换当前组第 index 张（从 0 起），焦点移到这张；会低于该组 minKeep 时不变（用 `canToggle` 先判断）。
// - set：把当前组的保留集合整个换掉（“全部保留 / 全部移除”）。
// - focus / select：组内焦点相对移动（←/→、J/K，不循环）/ 直接定位。
// - move / goto：换组，不定夺（Shift+Enter 是 move -1）。
// - adopt：定夺当前组并跳到后面第一个待定组（后面没有就从头找；全部定夺后停在下一组或最后一组）。
//   当前组已定夺且没改过时只前进，不记历史。
// - undo：撤销最近一步；给了 `entry` 时只在它是最近一步时撤销（异步撤销回来后确认没被别的操作抢先）。
// - revert：服务器拒绝了某次定夺：把那一组恢复成定夺前的状态（保留集合不动），删掉那一步，焦点不动。
// - forget：只删掉某一步，状态不动（服务器那边已经撤不了这一批，例如后端重启过）。
// - mark：压一个外部操作的历史条目。
//
// 选择器：currentGroup、keepOf、decidedOf、groupStatus、canToggle、adoptPlan、lastEntry、progress、isFinished。

export interface TriageGroupInit {
  readonly id: string;
  /** 成员 id，按显示顺序。 */
  readonly items: readonly string[];
  /** 还没人定夺时的初始保留（推荐项）。 */
  readonly suggested: readonly string[];
  /** 服务器上已定夺时保留的成员；待定的组是 null 或不给。 */
  readonly decided?: readonly string[] | null;
  /** 这一组至少保留几张（覆盖 options.minKeep）。 */
  readonly minKeep?: number;
}

export interface TriageOptions {
  /** 每组至少保留几张；默认 0。 */
  readonly minKeep?: number;
  /** 撤销历史的上限；默认 50。 */
  readonly historyLimit?: number;
}

export interface TriageFocus {
  readonly group: string | null;
  readonly item: number;
}

export interface TriageEntry {
  readonly id: number;
  readonly kind: "edit" | "adopt" | "mark";
  /** 受影响的组；mark 条目是 null。 */
  readonly group: string | null;
  /** 这一步之前那一组的保留集合和定夺（null 表示当时待定）。mark 条目两者都是 null。 */
  readonly keep: ReadonlySet<string> | null;
  readonly decided: ReadonlySet<string> | null;
  /** 这一步之前的焦点。 */
  readonly focus: TriageFocus;
  /** mark 条目的说明（页面自己解释）。 */
  readonly label?: string;
}

export interface TriageState {
  readonly groups: readonly TriageGroupInit[];
  readonly group: number;
  readonly item: number;
  readonly keep: ReadonlyMap<string, ReadonlySet<string>>;
  readonly decided: ReadonlyMap<string, ReadonlySet<string>>;
  readonly history: readonly TriageEntry[];
  /** 下一个历史条目的 id。 */
  readonly seq: number;
  readonly minKeep: number;
  readonly historyLimit: number;
}

export type TriageAction =
  | { readonly type: "load"; readonly groups: readonly TriageGroupInit[] }
  | { readonly type: "toggle"; readonly index: number }
  | { readonly type: "set"; readonly keep: readonly string[] }
  | { readonly type: "focus"; readonly delta: number }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "goto"; readonly group: number }
  | { readonly type: "adopt" }
  | { readonly type: "undo"; readonly entry?: number }
  | { readonly type: "revert"; readonly entry: number }
  | { readonly type: "forget"; readonly entry: number }
  | { readonly type: "mark"; readonly label?: string };

export type TriageGroupStatus = "pending" | "decided" | "changed";

export const TRIAGE_HISTORY_LIMIT = 50;

const EMPTY: ReadonlySet<string> = new Set();

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** 只保留组里真有的成员。 */
function within(group: TriageGroupInit, ids: Iterable<string>): Set<string> {
  const members = new Set(group.items);
  return new Set([...ids].filter((id) => members.has(id)));
}

function firstPending(groups: readonly TriageGroupInit[], decided: ReadonlyMap<string, unknown>, from = 0): number {
  for (let offset = 0; offset < groups.length; offset += 1) {
    const index = (from + offset) % groups.length;
    if (!decided.has(groups[index]!.id)) return index;
  }
  return -1;
}

function itemFocus(groups: readonly TriageGroupInit[], group: number, item = 0): number {
  const size = groups[group]?.items.length ?? 0;
  return size === 0 ? -1 : clamp(item, 0, size - 1);
}

export function createTriage(groups: readonly TriageGroupInit[], options: TriageOptions = {}): TriageState {
  const keep = new Map<string, ReadonlySet<string>>();
  const decided = new Map<string, ReadonlySet<string>>();
  for (const group of groups) {
    keep.set(group.id, within(group, group.decided ?? group.suggested));
    if (group.decided) decided.set(group.id, within(group, group.decided));
  }
  const pending = firstPending(groups, decided);
  const group = groups.length === 0 ? -1 : Math.max(0, pending);
  return {
    groups,
    group,
    item: itemFocus(groups, group),
    keep,
    decided,
    history: [],
    seq: 1,
    minKeep: Math.max(0, options.minKeep ?? 0),
    historyLimit: Math.max(1, options.historyLimit ?? TRIAGE_HISTORY_LIMIT),
  };
}

// ---- 选择器 ----

export function currentGroup(state: TriageState): TriageGroupInit | undefined {
  return state.groups[state.group];
}

export function keepOf(state: TriageState, group: string): ReadonlySet<string> {
  return state.keep.get(group) ?? EMPTY;
}

export function decidedOf(state: TriageState, group: string): ReadonlySet<string> | undefined {
  return state.decided.get(group);
}

export function groupStatus(state: TriageState, group: string): TriageGroupStatus {
  const decided = state.decided.get(group);
  if (!decided) return "pending";
  return sameSet(decided, keepOf(state, group)) ? "decided" : "changed";
}

function minKeepOf(state: TriageState, group: TriageGroupInit): number {
  return Math.min(group.items.length, Math.max(0, group.minKeep ?? state.minKeep));
}

/** 切换当前组第 index 张是否允许（不越界、不低于这一组的最少保留数）。 */
export function canToggle(state: TriageState, index: number): boolean {
  const group = currentGroup(state);
  const target = group?.items[index];
  if (!group || target === undefined) return false;
  const keep = keepOf(state, group.id);
  return !keep.has(target) || keep.size - 1 >= minKeepOf(state, group);
}

/** Enter 要提交的内容：当前组和它的保留列表（按成员顺序）。已定夺且没改过、或没有组时是 null。 */
export function adoptPlan(state: TriageState): { readonly group: string; readonly keep: readonly string[] } | null {
  const group = currentGroup(state);
  if (!group || groupStatus(state, group.id) === "decided") return null;
  const keep = keepOf(state, group.id);
  return { group: group.id, keep: group.items.filter((id) => keep.has(id)) };
}

export function lastEntry(state: TriageState): TriageEntry | undefined {
  return state.history.at(-1);
}

export function progress(state: TriageState): { readonly total: number; readonly decided: number; readonly pending: number } {
  const decided = state.groups.reduce((count, group) => count + (state.decided.has(group.id) ? 1 : 0), 0);
  return { total: state.groups.length, decided, pending: state.groups.length - decided };
}

/** 有组且全部已定夺。 */
export function isFinished(state: TriageState): boolean {
  return state.groups.length > 0 && state.groups.every((group) => state.decided.has(group.id));
}

// ---- 归约 ----

function focusOf(state: TriageState): TriageFocus {
  return { group: currentGroup(state)?.id ?? null, item: state.item };
}

function restoreFocus(state: TriageState, focus: TriageFocus): Pick<TriageState, "group" | "item"> {
  const index = focus.group === null ? -1 : state.groups.findIndex((group) => group.id === focus.group);
  if (index < 0) return { group: state.group, item: state.item };
  return { group: index, item: itemFocus(state.groups, index, focus.item) };
}

function push(state: TriageState, entry: Omit<TriageEntry, "id">): Pick<TriageState, "history" | "seq"> {
  const history = [...state.history, { ...entry, id: state.seq }];
  return { history: history.slice(Math.max(0, history.length - state.historyLimit)), seq: state.seq + 1 };
}

/** 改当前组的保留集合；同一组连续的修改合并成一步。 */
function edit(state: TriageState, group: TriageGroupInit, next: ReadonlySet<string>, item: number): TriageState {
  const before = keepOf(state, group.id);
  if (sameSet(before, next)) return item === state.item ? state : { ...state, item };
  const keep = new Map(state.keep).set(group.id, next);
  const top = lastEntry(state);
  if (top?.kind === "edit" && top.group === group.id) return { ...state, keep, item };
  const entry = { kind: "edit" as const, group: group.id, keep: before, decided: state.decided.get(group.id) ?? null, focus: focusOf(state) };
  return { ...state, keep, item, ...push(state, entry) };
}

function load(state: TriageState, groups: readonly TriageGroupInit[]): TriageState {
  const keep = new Map(state.keep);
  const decided = new Map(state.decided);
  for (const group of groups) {
    if (!keep.has(group.id)) keep.set(group.id, within(group, group.decided ?? group.suggested));
    if (!decided.has(group.id) && group.decided && !state.keep.has(group.id)) decided.set(group.id, within(group, group.decided));
  }
  const focused = currentGroup(state)?.id;
  const found = focused === undefined ? -1 : groups.findIndex((group) => group.id === focused);
  let index = found;
  if (groups.length === 0) index = -1;
  else if (found < 0) index = focused === undefined ? Math.max(0, firstPending(groups, decided)) : clamp(state.group, 0, groups.length - 1);
  const item = found >= 0 ? state.item : 0;
  return { ...state, groups, keep, decided, group: index, item: itemFocus(groups, index, item) };
}

function adopt(state: TriageState): TriageState {
  const group = currentGroup(state);
  if (!group) return state;
  let next = state;
  if (groupStatus(state, group.id) !== "decided") {
    const keep = keepOf(state, group.id);
    const entry = { kind: "adopt" as const, group: group.id, keep, decided: state.decided.get(group.id) ?? null, focus: focusOf(state) };
    next = { ...state, decided: new Map(state.decided).set(group.id, keep), ...push(state, entry) };
  }
  const groups = next.groups;
  const after = firstPending(groups, next.decided, state.group + 1);
  const target = after >= 0 ? after : Math.min(state.group + 1, groups.length - 1);
  return { ...next, group: target, item: itemFocus(groups, target) };
}

function restore(state: TriageState, entry: TriageEntry, history: readonly TriageEntry[], withFocus: boolean): TriageState {
  let { keep, decided } = state;
  if (entry.group !== null && entry.keep !== null) {
    keep = new Map(keep).set(entry.group, entry.keep);
    const nextDecided = new Map(decided);
    if (entry.decided) nextDecided.set(entry.group, entry.decided);
    else nextDecided.delete(entry.group);
    decided = nextDecided;
  }
  const next = { ...state, keep, decided, history };
  return withFocus ? { ...next, ...restoreFocus(next, entry.focus) } : next;
}

export function triageReducer(state: TriageState, action: TriageAction): TriageState {
  switch (action.type) {
    case "load":
      return load(state, action.groups);
    case "toggle": {
      const group = currentGroup(state);
      const target = group?.items[action.index];
      if (!group || target === undefined) return state;
      if (!canToggle(state, action.index)) return state.item === action.index ? state : { ...state, item: action.index };
      const next = new Set(keepOf(state, group.id));
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return edit(state, group, next, action.index);
    }
    case "set": {
      const group = currentGroup(state);
      if (!group) return state;
      const next = within(group, action.keep);
      if (next.size < minKeepOf(state, group)) return state;
      return edit(state, group, next, state.item);
    }
    case "focus": {
      const item = itemFocus(state.groups, state.group, state.item + Math.trunc(action.delta));
      return item === state.item ? state : { ...state, item };
    }
    case "select": {
      const item = itemFocus(state.groups, state.group, Math.trunc(action.index));
      return item === state.item ? state : { ...state, item };
    }
    case "move":
      return triageReducer(state, { type: "goto", group: state.group + Math.trunc(action.delta) });
    case "goto": {
      if (state.groups.length === 0) return state;
      const group = clamp(Math.trunc(action.group), 0, state.groups.length - 1);
      return group === state.group ? state : { ...state, group, item: itemFocus(state.groups, group) };
    }
    case "adopt":
      return adopt(state);
    case "undo": {
      const top = lastEntry(state);
      if (!top || (action.entry !== undefined && top.id !== action.entry)) return state;
      return restore(state, top, state.history.slice(0, -1), true);
    }
    case "revert": {
      const entry = state.history.find((candidate) => candidate.id === action.entry);
      if (!entry) return state;
      const history = state.history.filter((candidate) => candidate !== entry);
      // 只撤回定夺本身；之后对这一组的修改保留。
      return restore(state, { ...entry, keep: entry.group === null ? null : keepOf(state, entry.group) }, history, false);
    }
    case "forget": {
      const history = state.history.filter((candidate) => candidate.id !== action.entry);
      return history.length === state.history.length ? state : { ...state, history };
    }
    case "mark":
      return {
        ...state,
        ...push(state, { kind: "mark", group: null, keep: null, decided: null, focus: focusOf(state), label: action.label }),
      };
  }
}
