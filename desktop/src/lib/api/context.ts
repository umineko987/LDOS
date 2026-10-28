import { createContext } from "svelte";

import type { Api } from "./client.ts";

/**
 * 启动门拿到运行时 origin 后在根布局里 `setApi(createApi(origin))`，
 * 外壳和页面组件用 `useApi()` 取。只能在组件初始化时调用。
 */
export const [useApi, setApi] = createContext<Api>();
