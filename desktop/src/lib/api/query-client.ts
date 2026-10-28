import { QueryClient } from "@tanstack/svelte-query";

import { isApiError } from "./errors.ts";

/** 4xx 是请求本身的问题，重试没有意义；网络错误和 5xx 最多再试两次。 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 5_000,
        // 桌面窗口频繁获得焦点，进度类数据由 SSE 推送，不靠聚焦刷新。
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
