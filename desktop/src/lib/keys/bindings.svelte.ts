// 组件里注册按键的辅助函数：随组件挂载注册、卸载注销。只能在组件初始化时调用。
//
// 注册表变化会同步通知 keymapView()，它会写一个 $state；注册动作放在 untrack 里，
// 否则这次读写会被记成外层 effect 的依赖，造成循环。

import { untrack } from "svelte";

import { useKeymap } from "./context.ts";
import type { BindingScope, EscapeStep, KeyBinding, KeySection, OverlayOptions } from "./keymap.ts";

/** `bindings` 里读到的响应式状态变化时会重新注册。 */
export function useBindings(scope: BindingScope, bindings: () => readonly KeyBinding[]): void {
  const keymap = useKeymap();
  $effect(() => {
    const list = bindings();
    return untrack(() => keymap.register(scope, list));
  });
}

/** `open()` 为真时压入一个 overlay 层，让页面和全局按键暂停响应。 */
export function useOverlay(open: () => boolean, options: OverlayOptions): void {
  const keymap = useKeymap();
  $effect(() => {
    if (open()) return untrack(() => keymap.pushOverlay(options));
  });
}

/** 在 Esc 链的某一步挂一个处理器，返回 true 表示消费了这次 Esc。 */
export function useEscape(step: EscapeStep, handler: () => boolean): void {
  const keymap = useKeymap();
  $effect(() => untrack(() => keymap.onEscape(step, handler)));
}

/** 跟随注册表变化的命令面板条目和快捷键表分组。 */
export function keymapView() {
  const keymap = useKeymap();
  let version = $state(0);
  $effect(() =>
    keymap.subscribe(() =>
      untrack(() => {
        version += 1;
      }),
    ),
  );
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
