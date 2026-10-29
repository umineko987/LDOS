// 组件里注册按键的辅助函数：随组件挂载注册、卸载注销。只能在组件初始化时调用。

import { useKeymap } from "./context.ts";
import type { BindingScope, EscapeStep, KeyBinding, KeySection, OverlayOptions } from "./keymap.ts";

/** `bindings` 里读到的响应式状态变化时会重新注册。 */
export function useBindings(scope: BindingScope, bindings: () => readonly KeyBinding[]): void {
  const keymap = useKeymap();
  $effect(() => keymap.register(scope, bindings()));
}

/** `open()` 为真时压入一个 overlay 层，让页面和全局按键暂停响应。 */
export function useOverlay(open: () => boolean, options: OverlayOptions): void {
  const keymap = useKeymap();
  $effect(() => {
    if (open()) return keymap.pushOverlay(options);
  });
}

/** 在 Esc 链的某一步挂一个处理器，返回 true 表示消费了这次 Esc。 */
export function useEscape(step: EscapeStep, handler: () => boolean): void {
  const keymap = useKeymap();
  $effect(() => keymap.onEscape(step, handler));
}

/** 跟随注册表变化的命令面板条目和快捷键表分组。 */
export function keymapView() {
  const keymap = useKeymap();
  let version = $state(0);
  $effect(() => keymap.subscribe(() => (version += 1)));
  return {
    get commands(): KeyBinding[] {
      void version;
      return keymap.commands();
    },
    get sections(): KeySection[] {
      void version;
      return keymap.sections();
    },
  };
}
