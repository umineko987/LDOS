import { createContext } from "svelte";

import type { PlatformAdapter } from "./adapter.ts";

/** 根布局创建唯一的适配器并 `setPlatform()`；页面用 `usePlatform().capabilities` 决定是否显示本机操作。 */
export const [usePlatform, setPlatform] = createContext<PlatformAdapter>();
