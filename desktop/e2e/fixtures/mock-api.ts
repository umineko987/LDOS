import type { Page, Request, Route } from "@playwright/test";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface MockApiOptions {
  readonly health?: "ok" | "failed" | "invalid";
  readonly emptyRecent?: boolean;
  readonly failPaths?: readonly string[];
  readonly delayMs?: number;
}

export interface MockApi {
  readonly requests: RecordedRequest[];
  readonly unhandled: RecordedRequest[];
  count(method: string, path: string): number;
}

const REVISION_SAVED = "a".repeat(64);
const REVISION_ACTIVE = "b".repeat(64);
const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const INLINE_ID = `node_${"d".repeat(64)}`;
const SESSION_ID = "0123456789abcdef0123456789abcdef";
const SITE_IDS = ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"] as const;

function site(siteId: (typeof SITE_IDS)[number], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const definitions: Record<(typeof SITE_IDS)[number], Record<string, unknown>> = {
    danbooru: { label: "Danbooru", method: "anonymous", state: "ready", authorized: true, actions: [] },
    twitter: {
      label: "X / Twitter",
      method: "managed_browser",
      state: "authorized",
      authorized: true,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: true, valid: true, cookie_count: 2 },
      login: null,
    },
    pixiv: { label: "Pixiv", method: "oauth", state: "required", authorized: false, actions: ["oauth", "clear"], oauth: null },
    exhentai: {
      label: "EH",
      method: "managed_browser",
      state: "required",
      authorized: false,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: false, valid: false, cookie_count: 0 },
      login: null,
    },
    pawchive: { label: "Pawchive", method: "anonymous", state: "ready", authorized: true, actions: [] },
  };
  return { site: siteId, ...definitions[siteId], ...overrides };
}

function vaultSnapshot(): Record<string, unknown> {
  return {
    items: SITE_IDS.map((siteId) => site(siteId)),
    browser_profile: { shared: true, present: true, running: false, resetting: false },
    authorization_proxy: {
      proxy_url: "https://***@login-proxy.example:8443",
      source: "runtime",
      credentials_redacted: true,
      browser_running: false,
      restart_pending: false,
      updated_at: 1_700_000_100,
    },
    managed: true,
    secrets_exposed: false,
    response_profile: "vault",
  };
}

function policySnapshot(): Record<string, unknown> {
  const labels = {
    danbooru: ["Danbooru", "anonymous"],
    twitter: ["X / Twitter", "managed_browser"],
    pixiv: ["Pixiv", "oauth"],
    exhentai: ["EH", "managed_browser_for_private_content"],
    pawchive: ["Pawchive", "anonymous"],
  } as const;
  const config = (siteId: string) => ({
    max_concurrency: siteId === "pixiv" ? 8 : 20,
    retry_limit: 2,
    backoff_base_seconds: 2,
    proxy_mode: "prefer",
  });
  return {
    response_profile: "policy",
    secrets_exposed: false,
    effect_scope: "new_requests_and_tasks",
    concurrency_protection: "none",
    default_source: "startup_snapshot",
    persistence: "sqlite_atomic",
    default: { editable: true, reason: "", policy: config("default") },
    items: SITE_IDS.map((siteId) => ({
      site: siteId,
      label: labels[siteId][0],
      supported: true,
      authorization: labels[siteId][1],
      selection_mode: "per_request",
      availability: "not_probed",
      inherited: siteId !== "pixiv",
      has_override: siteId === "pixiv",
      editable: true,
      reason: "",
      updated_at: siteId === "pixiv" ? 1_700_000_000 : null,
      policy: config(siteId),
    })),
    unknown_override_count: 0,
  };
}

function proxyStatus(): Record<string, unknown> {
  return {
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    auto_start: false,
    running: false,
    total: 2,
    healthy: 1,
    retry_eligible: 1,
    leases: 0,
    last_error: "",
    configured_revision: REVISION_SAVED,
    active_revision: REVISION_ACTIVE,
    reload_required: true,
    transport_core: { enabled: true, running: false, listeners: 0, last_error: "" },
    sources: {
      subscriptions: 1,
      source_nodes: 2,
      pool_nodes: 2,
      core_candidates: 1,
      core_nodes: 1,
      skipped_nodes: 0,
      warnings: [],
    },
    nodes: [
      {
        id: "proxy-node-jp",
        name: "JP fixture",
        protocol: "http",
        endpoint: "http://***@proxy.example:8080",
        tags: ["jp"],
        healthy: true,
        retry_eligible: false,
        ref_count: 0,
        success_count: 12,
        fail_count: 1,
        last_latency_ms: 48,
        cooldown_until: 0,
        last_error: "",
      },
      {
        id: "proxy-node-us",
        name: "US fixture",
        protocol: "socks5",
        endpoint: "socks5://proxy.example:1080",
        tags: ["us"],
        healthy: false,
        retry_eligible: true,
        ref_count: 0,
        success_count: 3,
        fail_count: 2,
        last_latency_ms: 320,
        cooldown_until: 0,
        last_error: "network_timeout",
      },
    ],
  };
}

function proxySources(): Record<string, unknown> {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: REVISION_SAVED,
    active_revision: REVISION_ACTIVE,
    reload_required: true,
    subscriptions: [{
      id: SUBSCRIPTION_ID,
      source: "runtime",
      scheme: "https",
      host: "provider.example",
      port: 443,
      display_url: "https://provider.example/subscription",
      credentials_redacted: true,
      sensitive_parts_redacted: true,
    }],
    node_file: { configured: true, source: "runtime", display_path: "nodes.yaml" },
    inline_nodes: [{
      id: INLINE_ID,
      source: "runtime",
      scheme: "vless",
      name: "JP-01",
      host: "proxy.example",
      port: 443,
      requires_transport_core: true,
      display_endpoint: "vless://***@proxy.example:443#JP-01",
    }],
    counts: { subscriptions: 1, node_file: 1, inline_nodes: 1, total: 3 },
  };
}

function batch(batchId: string, status: "running" | "succeeded"): Record<string, unknown> {
  const terminal = status === "succeeded";
  return {
    id: batchId,
    status,
    output_dir: "/fixture/output",
    concurrency: 12,
    max_tasks: 150,
    task_count: 150,
    succeeded_task_count: terminal ? 145 : 55,
    failed_task_count: terminal ? 5 : 2,
    cancelled_task_count: 0,
    pre_dedup_skipped_count: 4,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_030,
    finished_at: terminal ? 1_700_000_030 : null,
    cancel_requested: false,
    resumable: terminal,
    current: terminal ? null : {
      address_id: "address-one",
      source_order: 0,
      address_order: 0,
      site: "pixiv",
      status: "running",
      url: "https://www.pixiv.net/users/123",
    },
    sources: [{
      order: 0,
      site: "pixiv",
      status,
      pre_dedup_skipped_count: 4,
      addresses: [{
        id: "address-one",
        address_order: 0,
        label: "画师作品",
        address_type: "account",
        status,
        planned_task_count: 150,
        succeeded_task_count: terminal ? 145 : 55,
        failed_task_count: terminal ? 5 : 2,
        cancelled_task_count: 0,
        pre_dedup_skipped_count: 4,
        probed_proxy_count: 2,
        healthy_proxy_count: 1,
        planning_error: "",
        url: "https://www.pixiv.net/users/123",
      }],
    }],
    review: {
      batch_id: batchId,
      status: terminal ? "ready" : "waiting_for_crawl",
      total_image_count: terminal ? 4 : 55,
      duplicate_group_count: terminal ? 2 : 0,
      decided_group_count: 0,
      total_group_count: terminal ? 2 : 0,
      log_path: "/fixture/review.log",
    },
  };
}

function taskPage(offset: number): Record<string, unknown> {
  const item = (index: number, errorClass: string, status: string) => ({
    id: `task-${index}`,
    crawl_address_id: "address-one",
    site: "pixiv",
    status,
    source_order: 0,
    address_order: 0,
    sequence_no: index,
    attempt_count: 1,
    max_attempts: 3,
    artifact_count: status === "succeeded" ? 2 : 0,
    artifact_bytes: status === "succeeded" ? 5242880 : 0,
    last_error_class: errorClass,
    last_error: errorClass,
    url: `https://www.pixiv.net/artworks/${index}`,
    output_dir: "/fixture/output",
    cookies_file: "/fixture/cookies.txt",
  });
  return {
    items: offset === 0
      ? [item(0, "credentials_unavailable", "failed"), item(1, "proxy_exhausted", "failed"), item(2, "", "succeeded")]
      : [item(100, "network_timeout", "failed")],
    limit: 100,
    offset,
  };
}

function searchResponse(): Record<string, unknown> {
  const candidate = (id: string, label: string, url: string, extra: Record<string, unknown> = {}) => ({
    id,
    label,
    address_type: "account",
    url,
    confidence: "verified",
    media_count: 12,
    evidence_reasons: ["site_search_work_evidence"],
    metadata: {},
    ...extra,
  });
  return {
    keyword: "fixture artist",
    source_count: 2,
    sources: [
      {
        site: "danbooru",
        status: "succeeded",
        evidence_count: 2,
        preview_count: 2,
        attempts: 1,
        auth: { state: "public", authorized: true },
        addresses: [
          candidate("artist-one", "Fixture Artist", "https://danbooru.donmai.us/posts?tags=fixture_artist"),
          candidate("artist-two", "Fixture Studio", "https://danbooru.donmai.us/posts?tags=fixture_studio"),
        ],
        weak_evidence: [],
      },
      {
        site: "exhentai",
        status: "partial",
        attempts: 1,
        auth: { state: "required", authorized: false },
        addresses: [candidate(
          "gallery-one",
          "Fixture Gallery",
          "https://e-hentai.org/g/3001/fixture/",
          { address_type: "gallery", thumbnail_url: "", metadata: { tags: ["artist:fixture", "language:chinese"] } },
        )],
        weak_evidence: [],
        tag_facets: [{
          namespace: "artist",
          label: "画师",
          gallery_count: 1,
          tags: [{ tag: "artist:fixture", count: 1 }],
        }],
      },
    ],
    related_profiles: [{ artist_name: "Fixture Artist", platform: "pixiv", url: "https://www.pixiv.net/users/123" }],
  };
}

function reviewPage(decisions: ReadonlyMap<string, readonly string[]>): Record<string, unknown> {
  const image = (id: string, ordinal: number, recommended: boolean) => ({
    id,
    ordinal,
    readable: true,
    recommended,
    selected: decisions.get(id.startsWith("image-1") || id.startsWith("image-2") ? "group-1" : "group-2")?.includes(id) ?? true,
    relative_path: `/fixture/${id}.svg`,
    metadata: { w: 1200, h: 800 },
  });
  const groups = [
    { id: "group-1", ordinal: 1, kind: "duplicate", images: [image("image-1", 1, true), image("image-2", 2, false)] },
    { id: "group-2", ordinal: 2, kind: "duplicate", images: [image("image-3", 1, true), image("image-4", 2, false)] },
  ].map((group) => ({ ...group, decided: decisions.has(group.id) }));
  return {
    batch_id: "batch-review",
    status: "ready",
    total_image_count: 4,
    total_group_count: 2,
    duplicate_group_count: 2,
    unreadable_image_count: 0,
    automatic_group_count: 0,
    automatic_rejected_image_count: 0,
    selected_image_count: groups.flatMap(({ images }) => images).filter(({ selected }) => selected).length,
    decided_group_count: decisions.size,
    kept_image_count: [...decisions.values()].reduce((total, ids) => total + ids.length, 0),
    rejected_image_count: decisions.size * 2 - [...decisions.values()].reduce((total, ids) => total + ids.length, 0),
    failed_image_count: 0,
    error: "",
    groups: { items: groups, offset: 0, limit: groups.length, total: groups.length },
  };
}

function diagnosticsConfig(): Record<string, unknown> {
  return {
    response_profile: "diagnostics",
    secrets_exposed: false,
    server: { loopback_only: true, cors_enabled: true, private_targets_enabled: false },
    gallery: { managed_auth_cache: true },
    proxy: { enabled: true, auto_start: false, transport_core_enabled: true },
    scheduler: { max_concurrent_tasks: 20 },
    dedup: { enabled: true, configured_device: "cpu", sscd_enabled: true, dino_enabled: false },
  };
}

function diagnosticsScheduler(): Record<string, unknown> {
  return {
    response_profile: "diagnostics",
    secrets_exposed: false,
    tasks: { running: true, active: 3, max_concurrent: 20, active_site_count: 2, dispatch_loop: { state: "ready" } },
    ordered_crawls: { running: true, active_batches: 1, execution_order: "source_then_address", address_parallelism: "media_tasks" },
  };
}

function readiness(): Record<string, unknown> {
  return {
    ready: false,
    components: {
      process: { status: "ok" },
      proxy: { status: "optional_warning", enabled: true, running: false },
      scheduler: { status: "ok", active_tasks: 3 },
      dedup: { status: "ok", configured_resources: { workers: 2, deep_batch_size: 16, neighbor_block_size: 512 } },
    },
  };
}

function requestBody(request: Request): unknown {
  const body = request.postData();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}

async function respond(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "X-Request-ID": "e2e-request" },
    body: JSON.stringify(value),
  });
}

function svgImage(id: string): string {
  const hue = [...id].reduce((total, character) => total + character.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="hsl(${hue} 42% 22%)"/><circle cx="600" cy="360" r="220" fill="hsl(${(hue + 55) % 360} 60% 48%)"/><text x="600" y="710" text-anchor="middle" fill="white" font-size="64">${id}</text></svg>`;
}

export async function installMockApi(page: Page, options: MockApiOptions = {}): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const unhandled: RecordedRequest[] = [];
  const decisions = new Map<string, readonly string[]>();

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:1420") {
      await route.continue();
      return;
    }
    const path = `${url.pathname}${url.search}`;
    const isApi = url.pathname === "/healthz" || url.pathname === "/readyz" || url.pathname.startsWith("/api/v1/");
    if (!isApi) {
      await route.continue();
      return;
    }

    requests.push(Object.freeze({ method: request.method(), path, body: requestBody(request) }));
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.failPaths?.some((candidate) => path.startsWith(candidate))) {
      await respond(route, { error: { code: "fixture_failure", message: "模拟服务错误", request_id: "e2e-request" } }, 503);
      return;
    }

    if (url.pathname === "/healthz") {
      if (options.health === "failed") await respond(route, { ok: false, components: { process: { status: "error" }, database: { status: "ok" } }, time: 1_700_000_000 }, 503);
      else if (options.health === "invalid") await respond(route, { status: "unknown" });
      else await respond(route, { ok: true, components: { process: { status: "ok" }, database: { status: "ok" } }, time: 1_700_000_000 });
      return;
    }
    if (url.pathname === "/readyz") {
      await respond(route, readiness());
      return;
    }

    if (url.pathname === "/api/v1/crawls" && request.method() === "GET") {
      await respond(route, { items: options.emptyRecent ? [] : [batch("batch-running", "running"), batch("batch-review", "succeeded")] });
      return;
    }
    if (url.pathname === "/api/v1/crawls" && request.method() === "POST") {
      await respond(route, { id: "batch-created" });
      return;
    }
    if (url.pathname === "/api/v1/search/autocomplete") {
      await respond(route, { items: [{ value: "fixture_artist", label: "Fixture Artist", category: "artist", post_count: 42 }] });
      return;
    }
    if (url.pathname === "/api/v1/search") {
      await respond(route, searchResponse());
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/crawls\/([^/]+)\/tasks$/);
    if (taskMatch) {
      await respond(route, taskPage(Number(url.searchParams.get("offset") ?? 0)));
      return;
    }
    const reviewImageMatch = url.pathname.match(/^\/api\/v1\/crawls\/batch-review\/review\/images\/([^/]+)$/);
    if (reviewImageMatch) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgImage(decodeURIComponent(reviewImageMatch[1])) });
      return;
    }
    if (url.pathname === "/api/v1/crawls/batch-review/review/decisions" && request.method() === "PUT") {
      const body = requestBody(request) as { groups?: { group_id?: string; selected_image_ids?: string[] }[] };
      for (const group of body.groups ?? []) {
        if (typeof group.group_id === "string" && Array.isArray(group.selected_image_ids)) decisions.set(group.group_id, [...group.selected_image_ids]);
      }
      await respond(route, {});
      return;
    }
    if (url.pathname === "/api/v1/crawls/batch-review/review" && request.method() === "GET") {
      await respond(route, reviewPage(decisions));
      return;
    }
    if (/^\/api\/v1\/crawls\/batch-review\/review\/(start|retry|apply)$/.test(url.pathname)) {
      await respond(route, {});
      return;
    }
    const batchMatch = url.pathname.match(/^\/api\/v1\/crawls\/(batch-[a-z0-9-]+)$/);
    if (batchMatch && request.method() === "GET") {
      await respond(route, batch(batchMatch[1], batchMatch[1] === "batch-review" ? "succeeded" : "running"));
      return;
    }
    if (/^\/api\/v1\/crawls\/(batch-running|batch-review)\/(cancel|retry|rerun)$/.test(url.pathname)) {
      await respond(route, {});
      return;
    }

    if (url.pathname === "/api/v1/proxy/status") {
      await respond(route, proxyStatus());
      return;
    }
    if (url.pathname === "/api/v1/proxy/sources") {
      await respond(route, proxySources());
      return;
    }
    if (url.pathname.startsWith("/api/v1/proxy/")) {
      await respond(route, {});
      return;
    }

    if (url.pathname === "/api/v1/sites/policies" && request.method() === "GET") {
      await respond(route, policySnapshot());
      return;
    }
    if (url.pathname.startsWith("/api/v1/sites/policies/")) {
      await respond(route, {});
      return;
    }

    if (url.pathname === "/api/v1/auth" && request.method() === "GET") {
      await respond(route, vaultSnapshot());
      return;
    }
    if (url.pathname === "/api/v1/auth/proxy" && request.method() === "PUT") {
      await respond(route, {
        proxy_url: "https://***@proxy.example:8443",
        source: "runtime",
        credentials_redacted: true,
        browser_running: false,
        restart_pending: false,
        updated_at: 1_700_000_200,
      });
      return;
    }
    const authSiteMatch = url.pathname.match(/^\/api\/v1\/auth\/(danbooru|twitter|pixiv|exhentai|pawchive)$/);
    if (authSiteMatch && request.method() === "GET") {
      await respond(route, { status: site(authSiteMatch[1] as (typeof SITE_IDS)[number]) });
      return;
    }
    if (url.pathname.startsWith("/api/v1/auth/")) {
      await respond(route, { session_id: SESSION_ID, state: "awaiting_login" });
      return;
    }

    if (url.pathname === "/api/v1/config") {
      await respond(route, diagnosticsConfig());
      return;
    }
    if (url.pathname === "/api/v1/scheduler/status") {
      await respond(route, diagnosticsScheduler());
      return;
    }

    unhandled.push(Object.freeze({ method: request.method(), path, body: requestBody(request) }));
    await respond(route, { error: { code: "missing_e2e_mock", message: `No E2E mock for ${request.method()} ${path}`, request_id: "e2e-request" } }, 501);
  });

  return {
    requests,
    unhandled,
    count(method: string, path: string): number {
      return requests.filter((request) => request.method === method && request.path.startsWith(path)).length;
    },
  };
}
