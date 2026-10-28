import { describe, expect, it } from "vitest";

import { ApiError } from "./errors.ts";
import { createQueryClient, shouldRetry } from "./query-client.ts";

describe("query client", () => {
  it("4xx 不重试，其余失败最多重试两次", () => {
    expect(shouldRetry(0, new ApiError({ status: 404, code: "not_found" }))).toBe(false);
    expect(shouldRetry(0, new ApiError({ status: 503, code: "http_error" }))).toBe(true);
    expect(shouldRetry(1, new ApiError({ code: "network_error" }))).toBe(true);
    expect(shouldRetry(2, new Error("x"))).toBe(false);
  });

  it("默认选项：不在聚焦时刷新，写操作不重试", () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.queries).toMatchObject({ retry: shouldRetry, staleTime: 5_000, refetchOnWindowFocus: false });
    expect(defaults.mutations).toMatchObject({ retry: false });
  });
});
