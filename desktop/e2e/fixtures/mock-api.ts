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
  readonly directoryExportScenario?: "completed" | "copying" | "failed" | "conflict";
  readonly galleryScenario?: "ready" | "reconciliation_failed" | "scan_failed";
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

// ---------------------------------------------------------------------------
// Gallery 与内嵌目录导出固定数据。
// 形状必须与 desktop 模型 sanitizer 的键白名单完全一致（strictRecord 会拒绝未知键）。
// ---------------------------------------------------------------------------

const GALLERY_SOURCE_ID = "gal-src-import";
const GALLERY_ROOT_DIR = "gal-dir-root";
const GALLERY_SUB_DIR = "gal-dir-sub";

function gallerySource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: GALLERY_SOURCE_ID,
    root_directory_id: GALLERY_ROOT_DIR,
    kind: "imported",
    batch_id: null,
    display_name: "E2E 导入目录",
    availability: "available",
    asset_count: 6,
    candidate_count: 0,
    kept_count: 6,
    removed_count: 0,
    crawl_complete: true,
    dedup_required: false,
    dedup_state: "not_required",
    content_version: 3,
    dedup_applied_version: 0,
    reconciliation_state: "none",
    reconciliation_error_code: "",
    reconciliation_attempt_count: 0,
    reconciliation_updated_at: null,
    annotation_version: 1,
    indexed_version: 3,
    last_scanned_at: 1_700_000_300,
    created_at: 1_700_000_100,
    updated_at: 1_700_000_300,
    ...overrides,
  };
}

function galleryScanOperation(state: "running" | "succeeded" | "failed"): Record<string, unknown> {
  return {
    operation_id: "gal-scan-1",
    source_id: GALLERY_SOURCE_ID,
    state,
    started_at: 1_700_000_400,
    finished_at: state === "running" ? null : 1_700_000_401,
    error_code: state === "failed" ? "scan_failed" : "",
    stats: state === "succeeded"
      ? {
          asset_count: 6,
          candidate_count: 0,
          kept_count: 6,
          removed_count: 0,
          directory_count: 2,
          content_changed: false,
          annotation_changed: false,
          indexed_version: 3,
          offline: false,
          skipped_temporary: 1,
          skipped_unsupported: 2,
        }
      : null,
  };
}

function galleryDirectory(directoryId: string, name: string, relativePath: string, parentId: string | null, directAssets: number, recursiveAssets: number, directDirectories: number, coverIds: readonly string[] = []): Record<string, unknown> {
  return {
    directory_id: directoryId,
    source_id: GALLERY_SOURCE_ID,
    parent_id: parentId,
    relative_path: relativePath,
    name,
    direct_directory_count: directDirectories,
    direct_asset_count: directAssets,
    recursive_asset_count: recursiveAssets,
    cover_asset_ids: coverIds,
    indexed_version: 3,
  };
}

function galleryAsset(index: number): Record<string, unknown> {
  const padded = String(index + 1).padStart(2, "0");
  return {
    asset_id: `gal-asset-${padded}`,
    source_id: GALLERY_SOURCE_ID,
    directory_id: GALLERY_ROOT_DIR,
    relative_path: `image-${padded}.jpg`,
    name: `image-${padded}.jpg`,
    extension: ".jpg",
    size_bytes: 48_000 + index * 100,
    modified_ns: 1_700_000_000_000_000_000 + index * 1_000_000_000,
    content_sha256: "e".repeat(64),
    content_version: 1,
    format: "jpeg",
    width: 1200,
    height: 800,
    read_state: "ok",
    error_code: "",
    txt_relative_path: `image-${padded}.txt`,
    txt_size_bytes: 64,
    txt_modified_ns: 1_700_000_000_000_000_000 + index * 1_000_000_000,
    txt_version: 1,
    txt_state: "normal",
    dedup_visibility: "candidate",
    lifecycle_state: "active",
    updated_at: 1_700_000_200,
  };
}

function galleryDirectoryPage(directoryId: string): Record<string, unknown> {
  const isRoot = directoryId === GALLERY_ROOT_DIR;
  return {
    directory: isRoot
      ? galleryDirectory(GALLERY_ROOT_DIR, "E2E 导入目录", "", null, 4, 6, 1, ["gal-asset-01", "gal-asset-02", "gal-asset-03", "gal-asset-04"])
      : galleryDirectory(GALLERY_SUB_DIR, "subdir", "subdir", GALLERY_ROOT_DIR, 2, 2, 0, ["gal-asset-05", "gal-asset-06"]),
    directories: isRoot ? [galleryDirectory(GALLERY_SUB_DIR, "subdir", "subdir", GALLERY_ROOT_DIR, 2, 2, 0, ["gal-asset-05", "gal-asset-06"])] : [],
    assets: isRoot
      ? [galleryAsset(0), galleryAsset(1), galleryAsset(2), galleryAsset(3)]
      : [galleryAsset(4), galleryAsset(5)],
    directory_cursor: null,
    asset_cursor: null,
    include_descendants: false,
    limit: 200,
  };
}

function galleryTrashPage(): Record<string, unknown> {
  return {
    operations: [],
    next_cursor: null,
  };
}

const DIRECTORY_EXPORT_OPERATION_ID = "gallery-export-op-01";

function directoryExportOperation(
  state: "copying" | "completed" | "failed" | "cancelled" = "copying",
): Record<string, unknown> {
  const completed = state === "completed";
  const failed = state === "failed";
  const cancelled = state === "cancelled";
  const results = completed
    ? [
        {
          directory_name: "subdir",
          status: "completed",
          copied_file_count: 4,
          copied_byte_count: 128_000,
          error_code: null,
        },
        {
          directory_name: "E2E 导入目录",
          status: "completed",
          copied_file_count: 6,
          copied_byte_count: 192_000,
          error_code: null,
        },
      ]
    : failed
      ? [
          {
            directory_name: "subdir",
            status: "completed",
            copied_file_count: 4,
            copied_byte_count: 128_000,
            error_code: null,
          },
          {
            directory_name: "E2E 导入目录",
            status: "failed",
            copied_file_count: 0,
            copied_byte_count: 0,
            error_code: "source_read_failed",
          },
        ]
      : cancelled
        ? [
            {
              directory_name: "subdir",
              status: "cancelled",
              copied_file_count: 1,
              copied_byte_count: 32_000,
              error_code: null,
            },
          ]
        : [];
  return {
    operation_id: DIRECTORY_EXPORT_OPERATION_ID,
    state,
    current_directory_name: state === "copying" ? "subdir" : null,
    directory_count: 2,
    completed_directory_count: completed ? 2 : failed ? 1 : 0,
    failed_directory_count: failed ? 1 : 0,
    discovered_file_count: 10,
    copied_file_count: completed ? 10 : failed ? 4 : 1,
    discovered_byte_count: 320_000,
    copied_byte_count: completed ? 320_000 : failed ? 128_000 : 32_000,
    error_code: failed ? "directory_copy_failed" : null,
    successful_directory_names: completed
      ? ["subdir", "E2E 导入目录"]
      : failed
        ? ["subdir"]
        : [],
    results,
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
  let gallerySourceMounted = true;
  let galleryDisplayName = "E2E 导入目录";
  let galleryReconciliationRetried = false;

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
    // ---- Gallery（G2+ 正式图库）----
    if (url.pathname === "/api/v1/gallery/sources" && request.method() === "GET") {
      const reconciliationFailed =
        options.galleryScenario === "reconciliation_failed" && !galleryReconciliationRetried;
      const projection = gallerySource({
        display_name: galleryDisplayName,
        ...(options.galleryScenario === "reconciliation_failed"
          ? {
              asset_count: 4,
              candidate_count: 0,
              kept_count: 4,
              removed_count: 2,
              dedup_required: true,
              dedup_state: "applied",
              reconciliation_state: reconciliationFailed ? "failed" : "applied",
              reconciliation_error_code: reconciliationFailed
                ? "review_reconciliation_apply_failed"
                : "",
              reconciliation_attempt_count: reconciliationFailed ? 1 : 2,
            }
          : {}),
      });
      await respond(route, { sources: gallerySourceMounted ? [projection] : [] });
      return;
    }
    const galleryScanMatch = url.pathname.match(/^\/api\/v1\/gallery\/sources\/([^/]+)\/scan$/);
    if (galleryScanMatch && request.method() === "POST") {
      await respond(route, galleryScanOperation("running"), 202);
      return;
    }
    if (galleryScanMatch && request.method() === "GET") {
      await respond(
        route,
        galleryScanOperation(options.galleryScenario === "scan_failed" ? "failed" : "succeeded"),
      );
      return;
    }
    const galleryReconciliationMatch = url.pathname.match(
      /^\/api\/v1\/gallery\/sources\/([^/]+)\/reconciliation\/retry$/,
    );
    if (galleryReconciliationMatch && request.method() === "POST") {
      galleryReconciliationRetried = true;
      await respond(route, gallerySource({
        asset_count: 4,
        candidate_count: 0,
        kept_count: 4,
        removed_count: 2,
        dedup_required: true,
        dedup_state: "applied",
        reconciliation_state: "applied",
        reconciliation_error_code: "",
        reconciliation_attempt_count: 2,
      }));
      return;
    }
    const galleryRelinkMatch = url.pathname.match(/^\/api\/v1\/gallery\/sources\/([^/]+)\/relink$/);
    if (galleryRelinkMatch && request.method() === "POST") {
      gallerySourceMounted = true;
      await respond(route, gallerySource({ display_name: galleryDisplayName }));
      return;
    }
    const gallerySourceMatch = url.pathname.match(/^\/api\/v1\/gallery\/sources\/([^/]+)$/);
    if (gallerySourceMatch && request.method() === "PATCH") {
      const body = requestBody(request);
      if (typeof body === "object" && body !== null && "display_name" in body) {
        const displayName = (body as { display_name?: unknown }).display_name;
        if (typeof displayName === "string") galleryDisplayName = displayName;
      }
      await respond(route, gallerySource({ display_name: galleryDisplayName }));
      return;
    }
    if (gallerySourceMatch && request.method() === "DELETE") {
      gallerySourceMounted = false;
      await respond(route, { source_id: GALLERY_SOURCE_ID, removed: true });
      return;
    }
    const galleryEntriesMatch = url.pathname.match(/^\/api\/v1\/gallery\/directories\/([^/]+)\/entries$/);
    if (galleryEntriesMatch && request.method() === "GET") {
      const directoryId = decodeURIComponent(galleryEntriesMatch[1]);
      const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
      const page = galleryDirectoryPage(directoryId);
      if (query) {
        page.assets = (page.assets as Record<string, unknown>[]).filter((asset) => String(asset.name).toLowerCase().includes(query));
      }
      await respond(route, page);
      return;
    }
    const galleryAssetMatch = url.pathname.match(/^\/api\/v1\/gallery\/assets\/([^/]+)\/(thumbnail|content)$/);
    if (galleryAssetMatch && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgImage(decodeURIComponent(galleryAssetMatch[1])) });
      return;
    }
    const galleryAnnotationMatch = url.pathname.match(/^\/api\/v1\/gallery\/assets\/([^/]+)\/annotation$/);
    if (galleryAnnotationMatch && request.method() === "GET") {
      await respond(route, {
        asset_id: decodeURIComponent(galleryAnnotationMatch[1]),
        txt_state: "normal",
        content: "e2e 标注文本",
        txt_version: 1,
        disk_version: "e2e-disk-version-1",
      });
      return;
    }
    if (galleryAnnotationMatch && request.method() === "PUT") {
      await respond(route, {
        asset_id: decodeURIComponent(galleryAnnotationMatch[1]),
        txt_state: "normal",
        content: "e2e 已保存标注",
        txt_version: 2,
        disk_version: "e2e-disk-version-2",
      });
      return;
    }
    if (url.pathname === "/api/v1/gallery/trash" && request.method() === "GET") {
      await respond(route, galleryTrashPage());
      return;
    }
    if (url.pathname === "/api/v1/gallery/trash" && request.method() === "DELETE") {
      await respond(route, { purged_operations: 0 });
      return;
    }
    const galleryFileOperationMatch = url.pathname.match(/^\/api\/v1\/gallery\/file-operations(\/.*)?$/);
    if (galleryFileOperationMatch) {
      await respond(route, { operation_id: "gal-op-fixture", status: "committed", item_count: 0, error_count: 0 });
      return;
    }
    if (url.pathname === "/api/v1/gallery/imports" && request.method() === "POST") {
      await respond(route, gallerySource(), 201);
      return;
    }

    // ---- Gallery 内短生命周期目录导出 ----
    if (url.pathname === "/api/v1/gallery/directory-exports" && request.method() === "POST") {
      if (options.directoryExportScenario === "conflict") {
        await respond(
          route,
          {
            error: {
              code: "target_top_level_conflict",
              message: "目标目录存在同名条目",
              request_id: "e2e-request",
              details: { names: ["subdir"] },
            },
          },
          409,
        );
        return;
      }
      await respond(route, directoryExportOperation("copying"), 202);
      return;
    }
    const directoryExportCancelMatch = url.pathname.match(
      /^\/api\/v1\/gallery\/directory-exports\/([^/]+)\/cancel$/,
    );
    if (directoryExportCancelMatch && request.method() === "POST") {
      await respond(route, directoryExportOperation("cancelled"));
      return;
    }
    const directoryExportMatch = url.pathname.match(
      /^\/api\/v1\/gallery\/directory-exports\/([^/]+)$/,
    );
    if (directoryExportMatch && request.method() === "GET") {
      await respond(
        route,
        directoryExportOperation(
          options.directoryExportScenario === "failed"
            ? "failed"
            : options.directoryExportScenario === "copying"
              ? "copying"
              : "completed",
        ),
      );
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
