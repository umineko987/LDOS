// 按 src/lib/api/schema.d.ts 的 `paths` 类型化的接口模拟。
// 路径和方法写错会在 `npm run check`（tsc -p e2e）里报错；有响应模型的接口，正文类型也会被检查。

import type { Page, Request, Route } from "@playwright/test";

import type { components, paths } from "../../src/lib/api/schema";

type Schemas = components["schemas"];

type Method = "get" | "post" | "put" | "patch" | "delete";

type MethodsOf<P extends keyof paths> = {
  [M in Method]: paths[P][M] extends { responses: unknown } ? M : never;
}[Method];

type JsonOf<R> = R extends { content: { "application/json": infer Body } } ? Body : never;

/** 成功响应（200/201）的 JSON 正文类型；schema 里没有模型的接口是 unknown。 */
export type ResponseBody<P extends keyof paths, M extends MethodsOf<P>> = paths[P][M] extends {
  responses: infer Responses;
}
  ? Responses extends { 200: infer Ok }
    ? JsonOf<Ok>
    : Responses extends { 201: infer Created }
      ? JsonOf<Created>
      : never
  : never;

export interface MockReply<Body> {
  readonly status?: number;
  readonly body?: Body | ErrorEnvelope;
  readonly headers?: Record<string, string>;
}

export interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown; readonly request_id?: string };
}

export type MockHandler<Body> = (request: Request) => MockReply<Body> | Promise<MockReply<Body>>;

function pathPattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

/**
 * 模拟一个接口。`reply` 可以直接给正文（按 schema 检查类型），也可以给函数返回 `{ status, body }`。
 * 同一路径后注册的优先（Playwright 的规则），所以测试里可以覆盖 fixture 给的默认值。
 */
export async function mockApi<P extends keyof paths, M extends MethodsOf<P>>(
  page: Page,
  method: M,
  path: P,
  reply: ResponseBody<P, M> | MockHandler<ResponseBody<P, M>>,
): Promise<void> {
  const pattern = pathPattern(path);
  await page.route(
    (url) => pattern.test(url.pathname),
    async (route: Route, request: Request) => {
      if (request.method().toLowerCase() !== method) return route.fallback();
      const result: MockReply<unknown> =
        typeof reply === "function" ? await (reply as MockHandler<unknown>)(request) : { body: reply };
      await route.fulfill({
        status: result.status ?? 200,
        contentType: "application/json",
        headers: result.headers,
        body: result.body === undefined ? "" : JSON.stringify(result.body),
      });
    },
  );
}

/** 后端错误信封，和 gdl_backend 的 `{"error": {...}}` 一致。 */
export function errorEnvelope(code: string, message: string, details?: unknown): ErrorEnvelope {
  return { error: { code, message, details } };
}

export const HEALTHY: Schemas["HealthResponse"] = {
  ok: true,
  components: { process: { status: "ok" }, database: { status: "ok" } },
  time: 1_760_000_000,
};

export const READY: Schemas["ReadinessResponse"] = {
  ready: true,
  time: 1_760_000_000,
  components: {
    database: { status: "ok", required: true, summary: "SQLite 可读写" },
    scheduler: { status: "ok", required: true, summary: "调度器运行中" },
    project_proxy: { status: "optional_missing", required: false, summary: "未配置代理节点" },
    dedup: { status: "disabled", required: false, summary: "去重模型未启用" },
  },
};

export const DIAGNOSTICS_CONFIG: Schemas["DiagnosticsConfigResponse"] = {
  response_profile: "diagnostics",
  secrets_exposed: false,
  server: { loopback_only: true, cors_enabled: false, private_targets_enabled: false },
  proxy: { enabled: true, auto_start: false, transport_core_enabled: true },
  gallery: { managed_auth_cache: true },
  scheduler: { max_concurrent_tasks: 4 },
  dedup: { enabled: true, configured_device: "cuda", sscd_enabled: true, dino_enabled: false },
};

/** 让启动门和外壳正常工作的默认模拟。 */
export async function mockHealthyBackend(page: Page): Promise<void> {
  await mockApi(page, "get", "/healthz", HEALTHY);
  await mockApi(page, "get", "/readyz", READY);
  await mockApi(page, "get", "/api/v1/config", DIAGNOSTICS_CONFIG);
}
