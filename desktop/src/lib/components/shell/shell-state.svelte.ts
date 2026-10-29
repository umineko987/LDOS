import { createContext } from "svelte";

/** 外壳浮层的开关。侧栏按钮、按键绑定和页面都通过 `useShell()` 打开它们。 */
export class ShellState {
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);
  activityOpen = $state(false);
}

export const [useShell, setShell] = createContext<ShellState>();
