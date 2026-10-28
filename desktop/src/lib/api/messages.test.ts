import { describe, expect, it } from "vitest";

import { ApiError } from "./errors.ts";
import { apiErrorMessage } from "./messages.ts";

// node 环境下 Paraglide 固定用基础语言 zh-CN；切换语言由 e2e/locale.spec.ts 覆盖。
describe("apiErrorMessage", () => {
  it("客户端错误码映射到翻译文案", () => {
    expect(apiErrorMessage(new ApiError({ code: "network_error" }))).toBe("无法连接到 LDOS 服务");
    expect(apiErrorMessage(new ApiError({ code: "response_too_large" }))).toBe("服务响应超出安全大小限制");
    expect(apiErrorMessage(new ApiError({ status: 502, code: "http_error" }))).toBe("请求失败（HTTP 502）");
    expect(apiErrorMessage(new ApiError({ code: "http_error" }))).toBe("请求失败");
  });

  it("后端错误用后端文案，其余情况给通用说明", () => {
    expect(apiErrorMessage(new ApiError({ status: 409, code: "conflict", message: "操作冲突" }))).toBe("操作冲突");
    expect(apiErrorMessage(new ApiError({ status: 500, code: "backend_error" }))).toBe("发生了意外错误");
    expect(apiErrorMessage(new ApiError({ code: "toString" }))).toBe("发生了意外错误");
    expect(apiErrorMessage(new Error("private raw error"))).toBe("发生了意外错误");
  });
});
