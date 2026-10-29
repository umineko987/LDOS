// 设置页（模型、下载、网络）的接口模拟数据。类型来自 schema.d.ts，契约变了会在 `npm run check` 里报错。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { mockApi, type ErrorEnvelope } from "./api";

type Schemas = components["schemas"];
export type ModelItem = Schemas["ModelItem"];
export type DownloadSettingsView = Schemas["DownloadSettingsView"];

export function model(key: string, overrides: Partial<ModelItem> = {}): ModelItem {
  return {
    key,
    family: "dedup",
    display_name: key,
    status: "missing",
    size_bytes: 350 * 1024 * 1024,
    installed_bytes: 0,
    license: "MIT",
    gated: false,
    source_url: `https://example.invalid/${key}`,
    used_by: ["dedup"],
    installs_with: [],
    message: "",
    progress: null,
    job_id: null,
    ...overrides,
  };
}

export const MODELS: ModelItem[] = [
  model("sscd", { display_name: "SSCD 拷贝检测", installs_with: ["dino"], size_bytes: 94 * 1024 * 1024 }),
  model("dino", {
    display_name: "DINOv2 ViT-S/14",
    license: "Apache-2.0",
    installs_with: ["sscd"],
    used_by: ["dedup", "atlas"],
    size_bytes: 88 * 1024 * 1024,
  }),
  model("ccip", { display_name: "角色一致性（CCIP）", status: "installed", license: null, used_by: ["clean"], installed_bytes: 1 }),
  model("wd-vit-v3", { family: "tagger", display_name: "WD ViT v3", status: "installed", size_bytes: null, license: "Apache-2.0", used_by: ["tag"] }),
  model("cl-tagger-v2", {
    family: "tagger",
    display_name: "CL Tagger v2",
    status: "needs_license",
    gated: true,
    size_bytes: null,
    license: "cl-tagger-license",
    used_by: ["tag"],
  }),
];

export const DOWNLOADS: DownloadSettingsView = {
  hf_mirror: null,
  proxy_mode: "none",
  custom_proxy: null,
  custom_proxy_has_credentials: false,
  token_set: false,
  token_hint: null,
};

/** 把一个模型改成安装中（模拟 POST /models/install 之后的表）。 */
export function installing(items: readonly ModelItem[], keys: readonly string[], jobId = "models:dedup"): ModelItem[] {
  return items.map((item) =>
    keys.includes(item.key) ? { ...item, status: "installing", job_id: jobId, progress: { current: 0, total: 0 }, message: "排队中" } : item,
  );
}

export interface InstallReply {
  readonly status?: number;
  readonly body: Schemas["ModelInstallResponse"] | ErrorEnvelope;
}

/** POST /api/v1/models/install 成功时回 202；`reply.status` 可以改成错误码。 */
export async function mockInstall(page: Page, handler: (body: Schemas["ModelInstallBody"], request: Request) => InstallReply): Promise<void> {
  await mockApi(page, "post", "/api/v1/models/install", (request) => {
    const reply = handler(request.postDataJSON() as Schemas["ModelInstallBody"], request);
    return { status: reply.status ?? 202, body: reply.body };
  });
}

/** 模型页的两个只读接口；`models` 每次请求时调用，测试可以随时改它返回的表。 */
export async function mockModelsBackend(
  page: Page,
  { models = () => MODELS, downloads = () => DOWNLOADS }: { models?: () => ModelItem[]; downloads?: () => DownloadSettingsView } = {},
): Promise<void> {
  await mockApi(page, "get", "/api/v1/models", () => ({ body: { items: models() } }));
  await mockApi(page, "get", "/api/v1/settings/downloads", () => ({ body: downloads() }));
}

// ---- 网络 ----

export const SUB_ID = `sub_${"a".repeat(64)}`;
export const NODE_ID = `node_${"b".repeat(64)}`;
export const SESSION_ID = "c".repeat(32);

export const PROXY_STATUS: Schemas["DesktopProxyStatus"] = {
  response_profile: "desktop-proxy-v1",
  enabled: true,
  engine: "mihomo",
  managed_by_backend: true,
  auto_start: false,
  running: true,
  total: 2,
  healthy: 1,
  retry_eligible: 1,
  leases: 0,
  configured_revision: "r2",
  active_revision: "r1",
  reload_required: true,
  last_error: "",
  transport_core: { enabled: true, running: true, listeners: 2, last_error: null },
  sources: { warnings: [] },
  nodes: [
    {
      id: "n1",
      name: "东京 01",
      protocol: "vless",
      endpoint: "jp.example:443",
      tags: [],
      healthy: true,
      retry_eligible: true,
      ref_count: 0,
      success_count: 3,
      fail_count: 0,
      last_latency_ms: 120,
      cooldown_until: null,
      last_error: "",
    },
    {
      id: "n2",
      name: "香港 02",
      protocol: "trojan",
      endpoint: "hk.example:443",
      tags: [],
      healthy: false,
      retry_eligible: false,
      ref_count: 0,
      success_count: 0,
      fail_count: 4,
      last_latency_ms: null,
      cooldown_until: null,
      last_error: "握手超时",
    },
  ],
  node_rows_total: 2,
  node_rows_truncated: false,
};

export const PROXY_SOURCES: Schemas["DesktopProxySources"] = {
  response_profile: "desktop-proxy-sources-v1",
  source: "runtime",
  has_runtime_override: true,
  runtime_override_valid: true,
  configured_revision: "r2",
  active_revision: "r1",
  reload_required: true,
  subscriptions: [
    { id: SUB_ID, source: "runtime", scheme: "https", host: "sub.example", port: null, credentials_redacted: true, sensitive_parts_redacted: false },
  ],
  node_file: { configured: false, source: "none", display_path: null },
  inline_nodes: [
    { id: NODE_ID, source: "runtime", scheme: "socks5", name: "本地", host: "127.0.0.1", port: 1080, requires_transport_core: false },
  ],
  counts: { subscriptions: 1, inline_nodes: 1, node_file: 0, total: 2 },
  subscription_rows_truncated: false,
  inline_node_rows_truncated: false,
};

const anonymous = (site: "danbooru" | "pawchive", label: string): Schemas["VaultSiteStatus"] => ({
  site,
  label,
  method: "anonymous",
  state: "ready",
  authorized: false,
  summary: "匿名访问，无需登录",
  updated_at: null,
  invalidated_at: null,
  actions: [],
});

export const VAULT: Schemas["VaultStatuses"] = {
  response_profile: "vault",
  managed: true,
  secrets_exposed: false,
  browser_profile: { shared: true, present: true, running: false, resetting: false, sites: ["exhentai"] },
  authorization_proxy: { source: "none", credentials_redacted: false, browser_running: false, restart_pending: false, updated_at: null },
  items: [
    anonymous("danbooru", "Danbooru"),
    {
      site: "twitter",
      label: "X / Twitter",
      method: "managed_browser",
      state: "required",
      authorized: false,
      summary: "需要登录",
      updated_at: null,
      invalidated_at: null,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: false, valid: false, cookie_count: 0, updated_at: null },
    },
    {
      site: "pixiv",
      label: "Pixiv",
      method: "oauth",
      state: "authorized",
      authorized: true,
      summary: "已授权",
      updated_at: 1_760_000_000,
      invalidated_at: null,
      actions: ["oauth", "clear"],
    },
    {
      site: "exhentai",
      label: "EH",
      method: "managed_browser",
      state: "authorized",
      authorized: true,
      summary: "Cookie 有效",
      updated_at: 1_760_000_000,
      invalidated_at: null,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: true, valid: true, cookie_count: 6, updated_at: 1_760_000_000 },
    },
    anonymous("pawchive", "Pawchive"),
  ],
};

const POLICY_FIELDS: Schemas["PolicyFields"] = { max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" };

function policyItem(site: string, label: string, overrides: Partial<Schemas["PolicyViewItem"]> = {}): Schemas["PolicyViewItem"] {
  return {
    site,
    label,
    supported: true,
    authorization: "none",
    selection_mode: "auto",
    availability: "available",
    inherited: true,
    has_override: false,
    editable: true,
    reason: "",
    updated_at: null,
    policy: POLICY_FIELDS,
    ...overrides,
  };
}

export const POLICIES: Schemas["PolicyViewSnapshot"] = {
  response_profile: "policy",
  secrets_exposed: false,
  effect_scope: "new_tasks",
  concurrency_protection: "per_site",
  default_source: "config",
  persistence: "runtime",
  default: { editable: false, reason: "默认值来自配置文件", policy: POLICY_FIELDS },
  items: [
    policyItem("danbooru", "Danbooru"),
    policyItem("pixiv", "Pixiv", {
      inherited: false,
      has_override: true,
      updated_at: 1_760_000_000,
      policy: { max_concurrency: 4, retry_limit: 3, backoff_base_seconds: 5, proxy_mode: "required" },
    }),
    policyItem("exhentai", "EH", { editable: false, reason: "该站点由账号设置决定" }),
  ],
  unknown_override_count: 0,
};

export interface NetworkMocks {
  proxyStatus?: () => Schemas["DesktopProxyStatus"] | Schemas["LegacyProxyStatus"];
  proxySources?: () => Schemas["DesktopProxySources"] | Schemas["LegacyProxySources"];
  accounts?: () => Schemas["VaultStatuses"] | Schemas["LegacyAuthStatuses"];
  policies?: () => Schemas["PolicyViewSnapshot"] | Schemas["LegacySitePolicies"];
}

/** 网络页的四个读接口。每次请求都调用对应函数，测试可以在写操作之后换掉返回值。 */
export async function mockNetworkBackend(page: Page, mocks: NetworkMocks = {}): Promise<void> {
  const { proxyStatus = () => PROXY_STATUS, proxySources = () => PROXY_SOURCES, accounts = () => VAULT, policies = () => POLICIES } = mocks;
  await mockApi(page, "get", "/api/v1/proxy/status", () => ({ body: proxyStatus() }));
  await mockApi(page, "get", "/api/v1/proxy/sources", () => ({ body: proxySources() }));
  await mockApi(page, "get", "/api/v1/auth", () => ({ body: accounts() }));
  await mockApi(page, "get", "/api/v1/sites/policies", () => ({ body: policies() }));
}

/** 写请求的记录：方法、路径、view 参数和正文。 */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly view: string | null;
  readonly body: unknown;
}

export function recorded(request: Request): RecordedRequest {
  const url = new URL(request.url());
  const text = request.postData();
  return { method: request.method(), path: url.pathname, view: url.searchParams.get("view"), body: text ? JSON.parse(text) : undefined };
}

/** POST /auth/{site}/login/start 成功时回 202。 */
export async function mockLoginStart(page: Page, handler: (request: Request) => Schemas["VaultBrowserResult"]): Promise<void> {
  await mockApi(page, "post", "/api/v1/auth/{site}/login/start", (request) => ({ status: 202, body: handler(request) }));
}
