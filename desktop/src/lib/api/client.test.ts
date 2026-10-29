import { describe, expect, it, vi } from "vitest";

import { API_MAX_RESPONSE_CHARS, createApi, data, idempotent } from "./client.ts";
import { ApiError } from "./errors.ts";

const ORIGIN = "http://127.0.0.1:8787";

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function recorder(...responses: Response[]) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (request: Request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return next;
  });
  return { requests, fetchImpl, api: createApi(ORIGIN, { fetchImpl }) };
}

describe("createApi", () => {
  it("给每个请求加 Accept、X-Request-ID 和 no-store，并透传 AbortSignal", async () => {
    const { api, requests } = recorder(json({ ok: true }));
    const controller = new AbortController();

    await expect(data(api.client.GET("/healthz", { signal: controller.signal }))).resolves.toEqual({ ok: true });

    const [request] = requests;
    expect(request!.url).toBe(`${ORIGIN}/healthz`);
    expect(request!.method).toBe("GET");
    expect(request!.headers.get("Accept")).toBe("application/json");
    expect(request!.headers.get("X-Request-ID")).toMatch(/^desktop-/);
    expect(request!.cache).toBe("no-store");
    expect(request!.signal.aborted).toBe(false);
    controller.abort();
    expect(request!.signal.aborted).toBe(true);
  });

  it("保留调用方给的请求 ID、Accept 和幂等键，并序列化 JSON 请求体", async () => {
    const { api, requests } = recorder(new Response(null, { status: 204 }));

    await data(
      api.client.PATCH("/api/v1/gallery/sources/{source_id}", {
        params: { path: { source_id: "source-1" } },
        body: { display_name: "新名字" },
        headers: { Accept: "application/problem+json", "X-Request-ID": " caller-1 ", ...idempotent("rename-0001") },
      }),
    );

    const [request] = requests;
    expect(request!.method).toBe("PATCH");
    expect(request!.url).toBe(`${ORIGIN}/api/v1/gallery/sources/source-1`);
    expect(request!.headers.get("Accept")).toBe("application/problem+json");
    expect(request!.headers.get("X-Request-ID")).toBe("caller-1");
    expect(request!.headers.get("Idempotency-Key")).toBe("rename-0001");
    expect(request!.headers.get("Content-Type")).toBe("application/json");
    expect(await request!.text()).toBe('{"display_name":"新名字"}');
  });

  it("请求发出前拒绝不合法的请求 ID 和幂等键", async () => {
    const { api, fetchImpl } = recorder();
    await expect(api.client.GET("/healthz", { headers: { "X-Request-ID": "bad id" } })).rejects.toThrow(
      "invalid_request_id",
    );
    await expect(api.client.GET("/healthz", { headers: { "Idempotency-Key": "short" } })).rejects.toThrow(
      "invalid_idempotency_key",
    );
    expect(() => idempotent("short")).toThrow("invalid_idempotency_key");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createApi(ORIGIN, { fetchImpl: null as never })).toThrow("fetch_unavailable");
  });

  it("把后端错误信封归一成 ApiError，并去掉详情里的敏感字段", async () => {
    const { api } = recorder(
      json(
        {
          error: {
            code: "conflict",
            message: "操作冲突",
            details: { field: "name", secret: "never", output_path: "/home/x" },
            request_id: "body-request-id",
          },
        },
        { status: 409, headers: { "X-Request-ID": "header-request-id" } },
      ),
    );
    const error = await api.client.GET("/healthz").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      message: "操作冲突",
      requestId: "body-request-id",
      details: { field: "name" },
      payload: null,
    });
  });

  it("没有信封的非 2xx 响应保留正文，供调用方按需读取", async () => {
    const { api } = recorder(
      json({ ready: false }, { status: 503, headers: { "X-Request-ID": "ready-1" } }),
      new Response("<html>gateway</html>", { status: 502 }),
      new Response("", { status: 500 }),
    );
    await expect(api.client.GET("/readyz")).rejects.toMatchObject({
      status: 503,
      code: "http_error",
      message: "http_error",
      requestId: "ready-1",
      payload: { ready: false },
    });
    await expect(api.client.GET("/readyz")).rejects.toMatchObject({ status: 502, code: "http_error", payload: null });
    await expect(api.client.GET("/readyz")).rejects.toMatchObject({ status: 500, code: "http_error" });
  });

  it("2xx 里的错误信封、无效 JSON、超限响应都会失败", async () => {
    const { api } = recorder(
      json({ error: { code: "unexpected_success_error", message: "拒绝" } }),
      new Response("{broken", { status: 200, headers: { "X-Request-ID": "invalid-id" } }),
      new Response(JSON.stringify({ data: "x".repeat(API_MAX_RESPONSE_CHARS) }), {
        status: 200,
        headers: { "X-Request-ID": "large-id" },
      }),
      new Response("{}", { status: 200, headers: { "Content-Length": String(API_MAX_RESPONSE_CHARS * 3 + 1) } }),
      json({ error: "not an envelope", ok: true }),
      json({ status: "failed", error: { code: "atlas_model_unavailable", message: "上次运行失败" } }),
    );
    await expect(api.client.GET("/healthz")).rejects.toMatchObject({ code: "unexpected_success_error", message: "拒绝" });
    await expect(api.client.GET("/healthz")).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
      requestId: "invalid-id",
    });
    await expect(api.client.GET("/healthz")).rejects.toMatchObject({ code: "response_too_large", requestId: "large-id" });
    await expect(api.client.GET("/healthz")).rejects.toMatchObject({ code: "response_too_large" });
    await expect(data(api.client.GET("/healthz"))).resolves.toEqual({ error: "not an envelope", ok: true });
    // 只有 `error` 一个键才是错误信封；正常响应里带失败原因的 `error` 字段照常返回。
    await expect(data(api.client.GET("/healthz"))).resolves.toEqual({
      status: "failed",
      error: { code: "atlas_model_unavailable", message: "上次运行失败" },
    });
  });

  it("空响应返回 undefined", async () => {
    const { api } = recorder(new Response(null, { status: 204 }), new Response("", { status: 200 }));
    await expect(data(api.client.GET("/healthz"))).resolves.toBeUndefined();
    await expect(data(api.client.GET("/healthz"))).resolves.toBeUndefined();
  });

  it("网络错误归一成 network_error，AbortError 原样抛出", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    const offline = createApi(ORIGIN, {
      fetchImpl: async () => {
        throw new Error("private raw error");
      },
    });
    const cancelled = createApi(ORIGIN, {
      fetchImpl: async () => {
        throw aborted;
      },
    });
    await expect(offline.client.GET("/healthz")).rejects.toMatchObject({ status: 0, code: "network_error" });
    await expect(cancelled.client.GET("/healthz")).rejects.toBe(aborted);
  });

  it("读取正文失败时不暴露原始异常", async () => {
    const broken = json({ ok: true }, { headers: { "X-Request-ID": "read-failure" } });
    vi.spyOn(broken, "text").mockRejectedValue(new Error("private body reader"));
    const aborted = new DOMException("aborted while reading", "AbortError");
    const abortedRead = json({ ok: true });
    vi.spyOn(abortedRead, "text").mockRejectedValue(aborted);
    const { api } = recorder(broken, abortedRead);

    await expect(api.client.GET("/healthz")).rejects.toMatchObject({
      status: 200,
      code: "response_read_failed",
      requestId: "read-failure",
    });
    await expect(api.client.GET("/healthz")).rejects.toBe(aborted);
  });

  it("data() 把漏网的 error 结果转成 ApiError", async () => {
    const response = new Response(null, { status: 418, headers: { "X-Request-ID": "teapot" } });
    await expect(data(Promise.resolve({ error: { detail: "x" }, response }))).rejects.toMatchObject({
      status: 418,
      code: "http_error",
      requestId: "teapot",
    });
  });

  it("resourceUrl 只接受 origin 内的绝对路径", () => {
    const { api } = recorder();
    expect(api.origin).toBe(ORIGIN);
    expect(api.resourceUrl("/api/v1/gallery/images/1/thumbnail")).toBe(`${ORIGIN}/api/v1/gallery/images/1/thumbnail`);
    for (const path of ["", "healthz", "//evil.example/x", "/\\evil.example/x", "/healthz#secret", 42 as never]) {
      expect(() => api.resourceUrl(path)).toThrow("invalid_api_path");
    }
  });
});
