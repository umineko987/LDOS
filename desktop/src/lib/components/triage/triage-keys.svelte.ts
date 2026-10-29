// 分诊卡组的按键，清洗和去重两页共用：1–9 切换保留、←/→ 与 J/K 移动焦点、Enter 采纳并下一组、
// Shift+Enter 上一组、Z 撤销、Space 看原图（页面给 onpreview）。只能在组件初始化时调用。

import { toast } from "svelte-sonner";

import { canToggle, currentGroup, type TriageState } from "#lib/keys/triage.ts";
import { useBindings } from "#lib/keys/bindings.svelte.ts";
import type { KeyBinding, KeyboardEventLike, Text } from "#lib/keys/keymap.ts";
import { m } from "#lib/paraglide/messages.js";

import type { TriageSession } from "./triage-session.svelte.ts";

export const TOGGLE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export interface TriageKeyOptions {
  /** 绑定 id 的前缀（`clean`、`dedup`）。 */
  readonly prefix: string;
  readonly group: Text;
  /** 卡组可操作（运行就绪、有组、没有对话框）。 */
  readonly enabled: () => boolean;
  readonly onpreview?: () => void;
  readonly extra?: () => readonly KeyBinding[];
}

/** 切换第 index 张；会低于这一组的最少保留数时提示一句，不切换。 */
export function toggleAt(session: TriageSession, index: number): void {
  const state: TriageState = session.state;
  const group = currentGroup(state);
  if (!group || index < 0 || index >= group.items.length) return;
  if (!canToggle(state, index)) {
    toast(m.triage_min_keep());
    return;
  }
  session.dispatch({ type: "toggle", index });
}

export function useTriageKeys(session: TriageSession, options: TriageKeyOptions): void {
  const { prefix, group } = options;
  const ready = () => options.enabled() && !session.undoing;
  const hasGroup = () => ready() && currentGroup(session.state) !== undefined;
  useBindings("page", () => [
    {
      id: `${prefix}.toggle`,
      keys: TOGGLE_KEYS,
      label: m.triage_key_toggle,
      group,
      when: hasGroup,
      run: (event?: KeyboardEventLike) => toggleAt(session, Number(event?.key ?? "1") - 1),
    },
    { id: `${prefix}.focus.prev`, keys: ["arrowleft", "k"], label: m.triage_key_focus_prev, group, when: hasGroup, run: () => session.dispatch({ type: "focus", delta: -1 }) },
    { id: `${prefix}.focus.next`, keys: ["arrowright", "j"], label: m.triage_key_focus_next, group, when: hasGroup, run: () => session.dispatch({ type: "focus", delta: 1 }) },
    { id: `${prefix}.adopt`, keys: "enter", label: m.triage_key_adopt, group, when: hasGroup, run: () => session.adopt() },
    { id: `${prefix}.group.prev`, keys: "shift+enter", label: m.triage_key_group_prev, group, when: hasGroup, run: () => session.dispatch({ type: "move", delta: -1 }) },
    { id: `${prefix}.undo`, keys: "z", label: m.triage_key_undo, group, when: ready, run: () => session.undo() },
    ...(options.onpreview
      ? [{ id: `${prefix}.preview`, keys: "space", label: m.triage_key_preview, group, when: hasGroup, run: options.onpreview }]
      : []),
    ...(options.extra?.() ?? []),
  ]);
}
