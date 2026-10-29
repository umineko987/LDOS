import { createContext } from "svelte";

import type { Keymap } from "./keymap.ts";

/** 根布局创建唯一的注册表；组件里用 `#lib/keys/bindings.svelte.ts` 的辅助函数注册。 */
export const [useKeymap, setKeymap] = createContext<Keymap>();
