import { describe, expect, it, vi } from "vitest";

import { ApiError, buildRequestOptions, createApiClient, createIdempotencyKey, createRequestId } from "./client";

const runtime = Object.freeze({ apiOrigin: "http://127.0.0.1:8787", backendVersion: "0.5.2" });

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("API client", () => {
  it("owns the absolute origin, GET options, request ID, and AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      jsonResponse({ ok: true }, { headers: { "X-Request-ID": "response-1" } })
    ));
    const client = createApiClient(runtime, { fetchImpl });

    await expect(client.get("/healthz?view=short", {
      requestId: "request-1",
      signal: controller.signal,
    })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8787/healthz?view=short");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", signal: controller.signal });
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-Request-ID")).toBe("request-1");
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("serializes POST and PUT JSON, supports DELETE, and preserves explicit headers", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const client = createApiClient(runtime, {
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return new Response(null, { status: 204 });
      },
    });

    await client.post("/api/v1/crawls", { source: "pixiv" }, {
      headers: { Accept: "application/problem+json" },
      idempotencyKey: "crawl-request-0001",
      requestId: "post-1",
    });
    await client.put("/api/v1/auth/proxy", { proxy_url: "" }, { idempotencyKey: true, requestId: "put-1" });
    await client.delete("/api/v1/auth/proxy", { requestId: "delete-1" });

    expect(calls.map(([, init]) => init?.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(calls[0][1]?.body).toBe('{"source":"pixiv"}');
    expect(new Headers(calls[0][1]?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(calls[0][1]?.headers).get("Accept")).toBe("application/problem+json");
    expect(new Headers(calls[0][1]?.headers).get("Idempotency-Key")).toBe("crawl-request-0001");
    expect(new Headers(calls[1][1]?.headers).get("Idempotency-Key")).toMatch(/^desktop-/);
    expect(new Headers(calls[2][1]?.headers).has("Content-Type")).toBe(false);
  });

  it("normalizes backend, HTTP, embedded, and invalid response errors", async () => {
    const responses = [
      jsonResponse({ error: {
        code: "conflict",
        message: "操作冲突",
        details: { field: "name", secret: "never" },
        request_id: "body-request-id",
      } }, { status: 409, headers: { "X-Request-ID": "header-request-id" } }),
      new Response("<html>gateway</html>", { status: 502, headers: { "X-Request-ID": "gateway-id" } }),
      jsonResponse({ error: { code: "unexpected_success_error", message: "拒绝" } }),
      new Response("{broken", { status: 200, headers: { "X-Request-ID": "invalid-id" } }),
    ];
    const client = createApiClient(runtime, { fetchImpl: async () => responses.shift()! });

    await expect(client.post("/conflict", {}, { requestId: "one" })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect([apiError.status, apiError.code, apiError.message, apiError.requestId]).toEqual([
        409, "conflict", "操作冲突", "body-request-id",
      ]);
      expect(apiError.details).toEqual({ field: "name" });
      return true;
    });
    await expect(client.get("/gateway", { requestId: "two" })).rejects.toMatchObject({
      status: 502,
      code: "http_error",
      requestId: "gateway-id",
    });
    await expect(client.get("/embedded", { requestId: "three" })).rejects.toMatchObject({
      code: "unexpected_success_error",
    });
    await expect(client.get("/invalid", { requestId: "four" })).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      requestId: "invalid-id",
    });
  });

  it("normalizes a transport response without an HTTP status", async () => {
    const response = {
      status: 0,
      ok: false,
      headers: new Headers(),
      text: async () => "",
    } as Response;
    const client = createApiClient(runtime, { fetchImpl: async () => response });
    await expect(client.get("/statusless", { requestId: "statusless-1" })).rejects.toMatchObject({
      status: 0,
      code: "http_error",
      message: "请求失败",
    });
  });

  it("returns null for empty responses and preserves AbortError", async () => {
    const emptyResponses = [
      new Response(null, { status: 204 }),
      new Response("", { status: 200 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ];
    const emptyClient = createApiClient(runtime, { fetchImpl: async () => emptyResponses.shift()! });
    await expect(emptyClient.get("/first", { requestId: "empty-1" })).resolves.toBeNull();
    await expect(emptyClient.get("/second", { requestId: "empty-2" })).resolves.toBeNull();
    await expect(emptyClient.post("/third", undefined, { requestId: "empty-3" })).resolves.toBeNull();
    await expect(emptyClient.put("/fourth", undefined, { requestId: "empty-4" })).resolves.toBeNull();

    const aborted = new DOMException("aborted", "AbortError");
    const abortClient = createApiClient(runtime, { fetchImpl: async () => { throw aborted; } });
    await expect(abortClient.get("/abort", { requestId: "abort-1" })).rejects.toBe(aborted);

    const networkClient = createApiClient(runtime, { fetchImpl: async () => { throw new Error("private raw error"); } });
    await expect(networkClient.get("/offline", { requestId: "offline-1" })).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: "无法连接到 ImageWeave 服务",
    });
  });

  it("normalizes response read failures without exposing raw errors", async () => {
    const response = jsonResponse({ ok: true }, { headers: { "X-Request-ID": "read-failure" } });
    vi.spyOn(response, "text").mockRejectedValue(new Error("private body reader"));
    const client = createApiClient(runtime, { fetchImpl: async () => response });
    await expect(client.get("/read-failure", { requestId: "read-1" })).rejects.toMatchObject({
      status: 200,
      code: "network_error",
      message: "读取服务响应失败",
      requestId: "read-failure",
    });

    const aborted = new DOMException("aborted while reading", "AbortError");
    const abortedResponse = jsonResponse({ ok: true });
    vi.spyOn(abortedResponse, "text").mockRejectedValue(aborted);
    const abortClient = createApiClient(runtime, { fetchImpl: async () => abortedResponse });
    await expect(abortClient.get("/read-abort", { requestId: "read-2" })).rejects.toBe(aborted);
  });

  it("rejects paths, methods, bodies, IDs, keys, and unavailable fetch before transport", async () => {
    const client = createApiClient(runtime, { fetchImpl: async () => jsonResponse({}) });
    for (const path of ["", "healthz", "//evil.example/x", "/\\evil.example/x", "/healthz#secret"]) {
      await expect(client.get(path, { requestId: "valid-id" })).rejects.toThrow("invalid_api_path");
    }
    expect(() => buildRequestOptions("PATCH" as never)).toThrow("unsupported_http_method");
    expect(() => buildRequestOptions("GET", { body: {} })).toThrow("get_body_not_allowed");
    expect(() => buildRequestOptions("GET", [] as never)).toThrow("invalid_request_options");
    expect(() => buildRequestOptions("GET", { requestId: "bad id" })).toThrow("invalid_request_id");
    expect(() => buildRequestOptions("POST", { idempotencyKey: "short" })).toThrow("invalid_idempotency_key");
    expect(() => createApiClient(runtime, { fetchImpl: null as never })).toThrow("fetch_unavailable");
    expect(() => buildRequestOptions("POST", { body: BigInt(1), requestId: "body-1" })).toThrow(ApiError);
    expect(() => buildRequestOptions("POST", { body: undefined, requestId: "body-2" })).not.toThrow();
    expect(() => buildRequestOptions("POST", { body: () => undefined, requestId: "body-3" })).toThrow(ApiError);
    expect(() => buildRequestOptions("POST", { idempotencyKey: 42 as never, requestId: "key-1" }))
      .toThrow("invalid_idempotency_key");
    expect(new Headers(buildRequestOptions("GET").headers).get("X-Request-ID")).toMatch(/^desktop-/);

    expect(new ApiError({ status: 1.5, code: null as never, message: "fallback" })).toMatchObject({
      status: 0,
      code: "request_failed",
    });
    expect(new ApiError({ code: " ", message: "fallback" }).code).toBe("request_failed");
  });

  it("creates opaque request and idempotency IDs without business data", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(createRequestId({ cryptoObject: { randomUUID: () => uuid } })).toBe(`desktop-${uuid}`);
    expect(createIdempotencyKey("crawl", {
      cryptoObject: null,
      now: () => 1_000,
      random: () => 0.5,
    })).toMatch(/^crawl-[a-z0-9]+-[a-z0-9]+$/);
    expect(createRequestId({
      cryptoObject: { randomUUID: () => { throw new Error("blocked"); } },
      now: () => -1,
      random: () => 2,
    })).toMatch(/^desktop-0-/);
    expect(createRequestId({
      cryptoObject: null,
      now: () => Number.NaN,
      random: () => Number.NaN,
    })).toMatch(/^desktop-0-0000000$/);
    expect(() => createIdempotencyKey("invalid prefix")).toThrow("invalid_identifier_prefix");
  });
});
