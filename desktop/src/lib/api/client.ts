import createClient, { type Client, type Middleware } from "openapi-fetch";

import { ApiError, apiErrorFromPayload, backendErrorEnvelope, isAbortError } from "./errors.ts";
import { createRequestId, normalizeIdempotencyKey, normalizeRequestId } from "./ids.ts";
import type { paths } from "./schema";

export const API_MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

export type LdosClient = Client<paths>;

export interface Api {
  /** 已校验的本机回环 origin，例如 `http://127.0.0.1:8787`。 */
  readonly origin: string;
  /** 按 schema.d.ts 生成类型的 openapi-fetch 客户端；失败一律抛 ApiError。 */
  readonly client: LdosClient;
  /** 拼出图片等资源的绝对地址，拒绝跳出 origin 的路径。 */
  resourceUrl(path: string): string;
}

export interface ApiOptions {
  readonly fetchImpl?: (input: Request) => Promise<Response>;
}

/**
 * 请求头约定，从旧版 core/api/client.ts 移植：
 * - 每个请求带 `X-Request-ID`；调用方可以自己给，格式不合法直接抛错。
 * - 需要幂等的写操作由调用方传 `headers: idempotent(key)`，这里只校验格式。
 * - 默认 `Accept: application/json`。
 */
function requestHeaders(): Middleware {
  return {
    onRequest({ request }) {
      if (!request.headers.has("Accept")) request.headers.set("Accept", "application/json");

      const suppliedRequestId = request.headers.get("X-Request-ID");
      const requestId = suppliedRequestId === null ? createRequestId() : normalizeRequestId(suppliedRequestId);
      if (!requestId) throw new TypeError("invalid_request_id");
      request.headers.set("X-Request-ID", requestId);

      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (idempotencyKey !== null) request.headers.set("Idempotency-Key", normalizeIdempotencyKey(idempotencyKey));
      return request;
    },
    onError({ error }) {
      if (isAbortError(error)) return error as Error;
      return new ApiError({ code: "network_error" });
    },
  };
}

function parseBody(text: string): { kind: "empty" | "invalid" | "json"; value: unknown } {
  if (!text.trim()) return { kind: "empty", value: null };
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid", value: null };
  }
}

/**
 * 响应归一：非 2xx、2xx 里的错误信封、无效 JSON、超限响应都在这里变成 ApiError，
 * 所以 `client.GET()` 只会以 `{ data }` 返回。
 */
function responseEnvelope(): Middleware {
  return {
    async onResponse({ response }) {
      const requestId = normalizeRequestId(response.headers.get("X-Request-ID"));
      if (response.status === 204) return response;

      // UTF-8 每个 UTF-16 码元至多 3 字节：声明长度超过 3 倍上限时不必读正文。
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declaredLength) && declaredLength > API_MAX_RESPONSE_CHARS * 3) {
        throw new ApiError({ status: response.status, code: "response_too_large", requestId });
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ApiError({ status: response.status, code: "response_read_failed", requestId });
      }
      if (text.length > API_MAX_RESPONSE_CHARS) {
        throw new ApiError({ status: response.status, code: "response_too_large", requestId });
      }

      const body = parseBody(text);
      if (!response.ok) throw apiErrorFromPayload(response.status, body.value, requestId);
      if (body.kind === "invalid") throw new ApiError({ status: response.status, code: "invalid_response", requestId });
      if (backendErrorEnvelope(body.value)) throw apiErrorFromPayload(response.status, body.value, requestId);

      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  };
}

function resourceUrlFor(origin: string, path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new TypeError("invalid_api_path");
  }
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw new TypeError("invalid_api_path");
  return url.href;
}

/** `origin` 必须已经过 `sanitizeRuntimeMetadata()` 校验（见 #lib/platform）。 */
export function createApi(origin: string, { fetchImpl = (request) => globalThis.fetch(request) }: ApiOptions = {}): Api {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");
  const client = createClient<paths>({ baseUrl: origin, fetch: fetchImpl, cache: "no-store" });
  client.use(requestHeaders(), responseEnvelope());
  return Object.freeze({
    origin,
    client,
    resourceUrl: (path: string) => resourceUrlFor(origin, path),
  });
}

/** 写操作的幂等请求头。键在一次逻辑操作里生成一次，重试时复用。 */
export function idempotent(key: string): { "Idempotency-Key": string } {
  return { "Idempotency-Key": normalizeIdempotencyKey(key) };
}

/** 取出 openapi-fetch 结果里的 data；中间件已把失败转成异常，这里只做兜底。 */
export async function data<T>(result: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data: value, error, response } = await result;
  if (error !== undefined) throw apiErrorFromPayload(response.status, error, normalizeRequestId(response.headers.get("X-Request-ID")));
  return value as T;
}
