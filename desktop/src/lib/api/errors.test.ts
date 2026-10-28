import { describe, expect, it } from "vitest";

import { ApiError, apiErrorFromPayload, backendErrorEnvelope, isAbortError, isApiError } from "./errors.ts";

describe("ApiError", () => {
  it("规范化错误码、文案、状态码和请求 ID", () => {
    const error = new ApiError({ status: 1.5, code: " ", message: "  ", requestId: "bad id" });
    expect(error.name).toBe("ApiError");
    expect(error.code).toBe("request_failed");
    expect(error.message).toBe("request_failed");
    expect(error.status).toBe(0);
    expect(error.requestId).toBe("");
    expect(error.details).toBeNull();
    expect(error.payload).toBeNull();
    expect(new ApiError({ code: "x".repeat(200) }).code).toHaveLength(128);
  });

  it("类型守卫只认 ApiError 和 AbortError", () => {
    expect(isApiError(new ApiError({ code: "conflict" }))).toBe(true);
    expect(isApiError(new Error("conflict"))).toBe(false);
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "NetworkError"))).toBe(false);
    expect(isAbortError({ name: "AbortError" })).toBe(false);
  });
});

describe("backendErrorEnvelope", () => {
  it("只接受普通对象里的对象型 error 字段", () => {
    expect(backendErrorEnvelope({ error: { code: "x" } })).toEqual({ code: "x" });
    expect(backendErrorEnvelope({ error: "x" })).toBeNull();
    expect(backendErrorEnvelope([{ error: {} }])).toBeNull();
    expect(backendErrorEnvelope(null)).toBeNull();
    const inherited = Object.create({ error: { code: "x" } }) as Record<string, unknown>;
    expect(backendErrorEnvelope(inherited)).toBeNull();
  });
});

describe("apiErrorFromPayload", () => {
  it("信封里缺字段时用兜底值，请求 ID 退回响应头", () => {
    expect(apiErrorFromPayload(500, { error: { request_id: "bad id" } }, "header-id")).toMatchObject({
      status: 500,
      code: "backend_error",
      message: "backend_error",
      requestId: "header-id",
      payload: null,
    });
  });

  it("没有信封时保留原始正文", () => {
    expect(apiErrorFromPayload(503, { ready: false }, "")).toMatchObject({
      code: "http_error",
      payload: { ready: false },
    });
  });
});
