const SITE_ORDER = Object.freeze([
  "danbooru",
  "twitter",
  "pixiv",
  "exhentai",
  "pawchive",
] as const);

export const VAULT_SITE_IDS = SITE_ORDER;
export const VAULT_AUTH_PROXY_MAX_LENGTH = 300;
export const AUTHORIZATION_POLL_INTERVAL_MS = 800;

export type VaultSiteId = typeof SITE_ORDER[number];
export type VaultSiteMethod = "anonymous" | "managed_browser" | "oauth";
export type VaultSessionKind = "managed_browser" | "oauth";
export type VaultWorkspacePhase = "loading" | "idle" | "partial" | "error" | "writing";

export interface VaultSiteDefinition {
  readonly id: VaultSiteId;
  readonly label: string;
  readonly mark: string;
  readonly method: VaultSiteMethod;
  readonly authorizeAction: "managed_browser_login" | "oauth" | "";
}

const SITE_DEFINITIONS: Readonly<Record<VaultSiteId, VaultSiteDefinition>> = Object.freeze({
  danbooru: Object.freeze({ id: "danbooru", label: "Danbooru", mark: "D", method: "anonymous", authorizeAction: "" }),
  twitter: Object.freeze({ id: "twitter", label: "X / Twitter", mark: "X", method: "managed_browser", authorizeAction: "managed_browser_login" }),
  pixiv: Object.freeze({ id: "pixiv", label: "Pixiv", mark: "P", method: "oauth", authorizeAction: "oauth" }),
  exhentai: Object.freeze({ id: "exhentai", label: "EH", mark: "EH", method: "managed_browser", authorizeAction: "managed_browser_login" }),
  pawchive: Object.freeze({ id: "pawchive", label: "Pawchive", mark: "PA", method: "anonymous", authorizeAction: "" }),
});

const SITE_STATES = new Set(["ready", "authorized", "authorizing", "required"]);
const SESSION_STATES = new Set([
  "starting", "starting_browser", "awaiting_login", "awaiting_code", "exchanging",
  "authorized", "cancelled", "timed_out", "failed", "token_ready",
]);
const MANAGED_ACTIVE_STATES = new Set(["starting", "awaiting_login"]);
const PIXIV_ACTIVE_STATES = new Set(["starting", "starting_browser", "awaiting_login", "awaiting_code", "exchanging"]);
const PROXY_SOURCES = new Set(["runtime", "config", "none"]);
const PROXY_SCHEMES = new Set(["http", "https", "socks4", "socks5", "socks5h"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_HOST_PATTERN = /^(?:\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)$/i;
const MAX_TIMESTAMP = 4_102_444_800;
const MAX_COOKIE_COUNT = 100_000;
const VAULT_REQUEST_LANES = new Set(["status", "site", "session"]);
export type VaultRequestLane = "status" | "site" | "session";
export interface VaultRequestTicket {
  readonly lane: VaultRequestLane;
  readonly laneVersion: number;
  readonly lifecycleVersion: number;
  readonly writeVersion: number;
}

export interface VaultSessionReference {
  readonly site: VaultSiteId;
  readonly kind: VaultSessionKind;
  readonly sessionId: string;
}

export interface VaultSessionSummary {
  readonly present: boolean;
  readonly active: boolean;
  readonly state: string;
  readonly createdAt: number | null;
  readonly expiresAt: number | null;
}

export interface VaultSiteStatus {
  readonly site: VaultSiteId;
  readonly label: string;
  readonly method: VaultSiteMethod;
  readonly state: string;
  readonly authorized: boolean;
  readonly configured: boolean;
  readonly materialValid: boolean;
  readonly invalidated: boolean;
  readonly updatedAt: number | null;
  readonly cookieCount: number;
  readonly session: VaultSessionSummary;
  readonly capabilities: Readonly<{ authorize: boolean; clear: boolean }>;
}

export interface VaultBrowserProfile {
  readonly shared: boolean;
  readonly present: boolean;
  readonly running: boolean;
  readonly resetting: boolean;
}

export interface VaultAuthorizationProxy {
  readonly source: "runtime" | "config" | "none";
  readonly configured: boolean;
  readonly direct: boolean;
  readonly scheme: string;
  readonly displayEndpoint: string;
  readonly credentialsRedacted: boolean;
  readonly browserRunning: boolean;
  readonly restartPending: boolean;
  readonly updatedAt: number | null;
  readonly valid: boolean;
}

export interface VaultSnapshot {
  readonly sites: Readonly<Record<string, VaultSiteStatus>>;
  readonly siteOrder: readonly VaultSiteId[];
  readonly browserProfile: VaultBrowserProfile | null;
  readonly authorizationProxy: VaultAuthorizationProxy | null;
}

export interface VaultSiteItem {
  readonly definition: VaultSiteDefinition;
  readonly status: VaultSiteStatus | null;
}

export interface VaultSiteRead {
  readonly status: VaultSiteStatus;
  readonly session: VaultSessionReference | null;
}

export interface VaultFullRead {
  readonly snapshot: VaultSnapshot;
  readonly session: VaultSessionReference | null;
}

export interface VaultInputValidation {
  readonly valid: boolean;
  readonly mode: "direct" | "proxy" | "invalid";
  readonly error: string;
}

export interface VaultErrorPresentation {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
  readonly requestId: string;
}

export interface VaultControl {
  readonly disabled: boolean;
  readonly reason: string;
  readonly label: string;
}

export interface VaultSiteControls {
  readonly authorize: VaultControl;
  readonly cancel: VaultControl;
  readonly clear: VaultControl;
  readonly showAuthorize: boolean;
  readonly showCancel: boolean;
  readonly showClear: boolean;
}

export interface VaultControls {
  readonly sites: Readonly<Record<VaultSiteId, VaultSiteControls>>;
  readonly refresh: VaultControl;
  readonly profileClear: VaultControl;
  readonly proxySave: VaultControl;
  readonly proxyReset: VaultControl;
  readonly reveal: VaultControl;
  readonly activeSite: VaultSiteId | "";
}

export function createVaultRequestGate() {
  let lifecycleVersion = 0;
  let writeVersion = 0;
  const laneVersions = new Map<VaultRequestLane, number>([
    ["status", 0], ["site", 0], ["session", 0],
  ]);
  const advanceLifecycle = (): number => { lifecycleVersion += 1; return lifecycleVersion; };
  const beginWrite = (): VaultRequestTicket => {
    writeVersion += 1;
    return Object.freeze({ lifecycleVersion, writeVersion, lane: "status", laneVersion: laneVersions.get("status") ?? 0 });
  };
  const beginRead = (lane: VaultRequestLane): VaultRequestTicket => {
    if (!VAULT_REQUEST_LANES.has(lane)) throw new TypeError("invalid_vault_request_lane");
    const laneVersion = (laneVersions.get(lane) ?? 0) + 1;
    laneVersions.set(lane, laneVersion);
    return Object.freeze({ lane, laneVersion, lifecycleVersion, writeVersion });
  };
  const isReadCurrent = (ticket: VaultRequestTicket | null): boolean => Boolean(
    ticket && VAULT_REQUEST_LANES.has(ticket.lane)
      && ticket.lifecycleVersion === lifecycleVersion
      && ticket.writeVersion === writeVersion
      && ticket.laneVersion === laneVersions.get(ticket.lane),
  );
  const isWriteCurrent = (ticket: VaultRequestTicket | null): boolean => Boolean(
    ticket && ticket.lifecycleVersion === lifecycleVersion && ticket.writeVersion === writeVersion,
  );
  return Object.freeze({
    advanceLifecycle, beginWrite, beginRead, isReadCurrent, isWriteCurrent,
    currentLifecycle: () => lifecycleVersion,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Object.hasOwn(descriptor, "value")) result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new TypeError(code);
  return result;
}

function own(value: Record<string, unknown> | null, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}


function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP ? value : null;
}

function safeInteger(value: unknown, maximum = MAX_COOKIE_COUNT): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function safeSiteState(value: unknown): string {
  return typeof value === "string" && SITE_STATES.has(value) ? value : "required";
}

function safeSessionState(value: unknown): string {
  return typeof value === "string" && SESSION_STATES.has(value) ? value : "none";
}

function safeSource(value: unknown): "runtime" | "config" | "none" {
  return typeof value === "string" && PROXY_SOURCES.has(value) ? value as "runtime" | "config" : "none";
}

function safeHost(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || CONTROL_CHARACTERS.test(value)) return "";
  const host = value.trim();
  if (!SAFE_HOST_PATTERN.test(host)) return "";
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare || (!bare.includes(":") && bare.split(".").some((label) => !label || label.length > 63))) return "";
  return host;
}


function explicitPort(value: string): number {
  const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0].split("@").at(-1) ?? "";
  const raw = authority.startsWith("[")
    ? authority.match(/^\[[^\]]+\]:(\d{1,5})$/)?.[1] ?? ""
    : authority.match(/^[^:]+:(\d{1,5})$/)?.[1] ?? "";
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
}

function safeSessionId(value: unknown): string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : "";
}

function sessionFor(status: Record<string, unknown>, definition: VaultSiteDefinition): Record<string, unknown> | null {
  return record(own(status, definition.method === "oauth" ? "oauth" : "login"));
}

function sessionSummary(status: Record<string, unknown>, definition: VaultSiteDefinition): VaultSessionSummary {
  const raw = sessionFor(status, definition);
  const state = safeSessionState(own(raw, "state"));
  const id = safeSessionId(own(raw, "session_id"));
  const activeStates = definition.method === "oauth" ? PIXIV_ACTIVE_STATES : MANAGED_ACTIVE_STATES;
  return Object.freeze({
    present: Boolean(raw),
    active: Boolean(raw && id && activeStates.has(state)),
    state,
    createdAt: safeTimestamp(own(raw, "created_at")),
    expiresAt: safeTimestamp(own(raw, "expires_at")),
  });
}

export function getVaultSiteDefinition(siteId: unknown): VaultSiteDefinition | null {
  return typeof siteId === "string" && Object.hasOwn(SITE_DEFINITIONS, siteId)
    ? SITE_DEFINITIONS[siteId as VaultSiteId]
    : null;
}

export function sanitizeVaultSiteStatus(value: unknown): VaultSiteStatus {
  const status = requireRecord(value, "invalid_vault_site_status");
  const definition = getVaultSiteDefinition(own(status, "site"));
  if (!definition || own(status, "method") !== definition.method) throw new TypeError("invalid_vault_site_status");
  const cookies = record(own(status, "cookies"));
  const authorized = own(status, "authorized") === true;
  const configured = definition.method === "managed_browser"
    ? own(cookies, "present") === true
    : definition.method === "oauth" ? authorized : false;
  const materialValid = definition.method === "managed_browser"
    ? own(cookies, "valid") === true && authorized
    : definition.method === "oauth" ? authorized : true;
  return Object.freeze({
    site: definition.id,
    label: definition.label,
    method: definition.method,
    state: safeSiteState(own(status, "state")),
    authorized,
    configured,
    materialValid,
    invalidated: safeTimestamp(own(status, "invalidated_at")) !== null,
    updatedAt: safeTimestamp(own(status, "updated_at")) ?? safeTimestamp(own(cookies, "updated_at")),
    cookieCount: definition.method === "managed_browser" ? safeInteger(own(cookies, "cookie_count")) : 0,
    session: sessionSummary(status, definition),
    capabilities: Object.freeze({
      authorize: Boolean(definition.authorizeAction && Array.isArray(own(status, "actions")) && (own(status, "actions") as unknown[]).includes(definition.authorizeAction)),
      clear: Array.isArray(own(status, "actions")) && (own(status, "actions") as unknown[]).includes("clear"),
    }),
  });
}

export function extractVaultSessionReference(value: unknown, siteHint = ""): VaultSessionReference | null {
  const root = record(value);
  const status = record(own(root, "status")) ?? root;
  if (!status) return null;
  const siteId = siteHint || own(status, "site");
  const definition = getVaultSiteDefinition(siteId);
  if (!definition) return null;
  const direct = record(own(root, "session"));
  const session = direct ?? (own(root, "session_id") !== undefined ? root : sessionFor(status, definition));
  const sessionId = safeSessionId(own(session, "session_id"));
  const state = safeSessionState(own(session, "state"));
  const activeStates = definition.method === "oauth" ? PIXIV_ACTIVE_STATES : MANAGED_ACTIVE_STATES;
  if (!sessionId || !activeStates.has(state)) return null;
  return Object.freeze({
    site: definition.id,
    kind: definition.method === "oauth" ? "oauth" : "managed_browser",
    sessionId,
  });
}

export function extractVaultSessionFromSnapshot(value: unknown, siteHint = ""): VaultSessionReference | null {
  const root = record(value);
  const items = own(root, "items");
  if (!Array.isArray(items)) return null;
  for (const item of items.slice(0, SITE_ORDER.length * 2)) {
    const reference = extractVaultSessionReference(item);
    if (reference && (!siteHint || reference.site === siteHint)) return reference;
  }
  return null;
}

function sanitizeBrowserProfile(value: unknown): VaultBrowserProfile {
  const profile = requireRecord(value, "invalid_vault_browser_profile");
  return Object.freeze({
    shared: own(profile, "shared") === true,
    present: own(profile, "present") === true,
    running: own(profile, "running") === true,
    resetting: own(profile, "resetting") === true,
  });
}

function parseProxyUrl(value: unknown, allowSecrets: boolean): {
  mode: "direct" | "proxy";
  value: string;
  scheme?: string;
  host?: string;
  port?: number;
  hasCredentials?: boolean;
} {
  if (typeof value !== "string") throw new TypeError("invalid_authorization_proxy");
  const text = value.trim();
  if (!text) return Object.freeze({ mode: "direct", value: "" });
  if (text.length > VAULT_AUTH_PROXY_MAX_LENGTH || CONTROL_CHARACTERS.test(text) || /\s/.test(text)) {
    throw new TypeError("invalid_authorization_proxy");
  }
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new TypeError("invalid_authorization_proxy"); }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!PROXY_SCHEMES.has(scheme) || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new TypeError("invalid_authorization_proxy");
  }
  const host = safeHost(parsed.hostname);
  const port = explicitPort(text);
  const authority = text.slice(text.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  const hasCredentials = Boolean(parsed.username || parsed.password || authority.includes("@"));
  if (!host || !port || (scheme.startsWith("socks") && hasCredentials)) throw new TypeError("invalid_authorization_proxy");
  if (!allowSecrets && hasCredentials && !text.includes("***@")) throw new TypeError("invalid_authorization_proxy");
  return Object.freeze({ mode: "proxy", value: text, scheme, host, port, hasCredentials });
}

export function validateAuthorizationProxyInput(value: unknown): VaultInputValidation {
  try {
    const parsed = parseProxyUrl(value, true);
    return Object.freeze({ valid: true, mode: parsed.mode, error: "" });
  } catch {
    return Object.freeze({ valid: false, mode: "invalid", error: "请输入协议://主机:端口；不支持路径、查询参数或带凭据的 SOCKS 代理。" });
  }
}

export function buildAuthorizationProxyPayload(value: unknown): Readonly<{ proxy_url: string }> {
  return Object.freeze({ proxy_url: parseProxyUrl(value, true).value });
}

export function formatVaultTime(value: number | null | undefined): string {
  const timestamp = safeTimestamp(value);
  if (timestamp === null) return "尚无记录";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(timestamp * 1_000));
  } catch {
    return "时间不可用";
  }
}

export function sanitizeAuthorizationProxy(value: unknown): VaultAuthorizationProxy {
  const proxy = requireRecord(value, "invalid_vault_authorization_proxy");
  const raw = own(proxy, "proxy_url");
  if (raw === null) {
    return Object.freeze({ source: safeSource(own(proxy, "source")), configured: false, direct: true, scheme: "", displayEndpoint: "", credentialsRedacted: own(proxy, "credentials_redacted") === true, browserRunning: own(proxy, "browser_running") === true, restartPending: own(proxy, "restart_pending") === true, updatedAt: safeTimestamp(own(proxy, "updated_at")), valid: true });
  }
  try {
    const parsed = parseProxyUrl(raw, false);
    return Object.freeze({ source: safeSource(own(proxy, "source")), configured: true, direct: false, scheme: parsed.scheme ?? "", displayEndpoint: `${(parsed.scheme ?? "").toUpperCase()} · ${parsed.host ?? ""}:${parsed.port ?? 0}`, credentialsRedacted: own(proxy, "credentials_redacted") === true || Boolean(parsed.hasCredentials), browserRunning: own(proxy, "browser_running") === true, restartPending: own(proxy, "restart_pending") === true, updatedAt: safeTimestamp(own(proxy, "updated_at")), valid: true });
  } catch {
    return Object.freeze({ source: safeSource(own(proxy, "source")), configured: false, direct: false, scheme: "", displayEndpoint: "", credentialsRedacted: true, browserRunning: own(proxy, "browser_running") === true, restartPending: own(proxy, "restart_pending") === true, updatedAt: safeTimestamp(own(proxy, "updated_at")), valid: false });
  }
}

export function sanitizeVaultSnapshot(value: unknown): VaultSnapshot {
  const root = requireRecord(value, "invalid_vault_snapshot");
  if (own(root, "secrets_exposed") !== false || !Array.isArray(own(root, "items"))) throw new TypeError("invalid_vault_snapshot");
  const sites = Object.create(null) as Record<string, VaultSiteStatus>;
  for (const item of (own(root, "items") as unknown[]).slice(0, SITE_ORDER.length * 2)) {
    try {
      const status = sanitizeVaultSiteStatus(item);
      if (!Object.hasOwn(sites, status.site)) sites[status.site] = status;
    } catch { /* An invalid site projection cannot contaminate valid sites. */ }
  }
  return Object.freeze({
    sites: Object.freeze(sites),
    siteOrder: Object.freeze([...SITE_ORDER]),
    browserProfile: sanitizeBrowserProfile(own(root, "browser_profile")),
    authorizationProxy: sanitizeAuthorizationProxy(own(root, "authorization_proxy")),
  });
}

export function mergeVaultSite(snapshot: VaultSnapshot | null, status: VaultSiteStatus): VaultSnapshot {
  const sites = Object.create(null) as Record<string, VaultSiteStatus>;
  if (snapshot) Object.assign(sites, snapshot.sites);
  sites[status.site] = status;
  return Object.freeze({
    sites: Object.freeze(sites),
    siteOrder: Object.freeze([...SITE_ORDER]),
    browserProfile: snapshot?.browserProfile ?? null,
    authorizationProxy: snapshot?.authorizationProxy ?? null,
  });
}

export function sanitizeVaultSiteRead(value: unknown, siteHint = ""): VaultSiteRead {
  const root = record(value);
  const rawStatus = own(root, "status") ?? value;
  const status = sanitizeVaultSiteStatus(rawStatus);
  if (siteHint && status.site !== siteHint) throw new TypeError("invalid_vault_site_status");
  return Object.freeze({ status, session: extractVaultSessionReference(value, status.site) });
}

export function vaultSiteItems(snapshot: VaultSnapshot | null): readonly VaultSiteItem[] {
  return Object.freeze(SITE_ORDER.map((id) => Object.freeze({ definition: SITE_DEFINITIONS[id], status: snapshot?.sites[id] ?? null })));
}

const SITE_VIEW_KEYS = new Set(["site", "label", "method", "state", "authorized", "configured", "materialValid", "invalidated", "updatedAt", "cookieCount", "session", "capabilities"]);
const SESSION_VIEW_KEYS = new Set(["present", "active", "state", "createdAt", "expiresAt"]);
const CAPABILITY_KEYS = new Set(["authorize", "clear"]);
const PROFILE_VIEW_KEYS = new Set(["shared", "present", "running", "resetting"]);
const PROXY_VIEW_KEYS = new Set(["source", "configured", "direct", "scheme", "displayEndpoint", "credentialsRedacted", "browserRunning", "restartPending", "updatedAt", "valid"]);
const SNAPSHOT_VIEW_KEYS = new Set(["sites", "siteOrder", "browserProfile", "authorizationProxy"]);
const SAFE_PROXY_DISPLAY_PATTERN = /^(?:HTTP|HTTPS|SOCKS4|SOCKS5|SOCKS5H) · (?:\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/;

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function validateVaultSiteViewModel(value: unknown): VaultSiteStatus {
  const site = requireRecord(value, "invalid_vault_site_view");
  if (!hasOnlyKeys(site, SITE_VIEW_KEYS)) throw new TypeError("invalid_vault_site_view");
  const definition = getVaultSiteDefinition(own(site, "site"));
  if (!definition || own(site, "label") !== definition.label || own(site, "method") !== definition.method) throw new TypeError("invalid_vault_site_view");
  const siteState = own(site, "state");
  if (typeof siteState !== "string" || !SITE_STATES.has(siteState)) throw new TypeError("invalid_vault_site_view");
  for (const key of ["authorized", "configured", "materialValid", "invalidated"] as const) if (typeof own(site, key) !== "boolean") throw new TypeError("invalid_vault_site_view");
  const updatedAt = own(site, "updatedAt");
  if (updatedAt !== null && safeTimestamp(updatedAt) === null) throw new TypeError("invalid_vault_site_view");
  if (!Number.isInteger(own(site, "cookieCount")) || Number(own(site, "cookieCount")) < 0 || Number(own(site, "cookieCount")) > MAX_COOKIE_COUNT) throw new TypeError("invalid_vault_site_view");
  const session = requireRecord(own(site, "session"), "invalid_vault_session_view");
  const sessionState = own(session, "state");
  if (!hasOnlyKeys(session, SESSION_VIEW_KEYS) || typeof own(session, "present") !== "boolean" || typeof own(session, "active") !== "boolean" || typeof sessionState !== "string" || (sessionState !== "none" && !SESSION_STATES.has(sessionState))) throw new TypeError("invalid_vault_session_view");
  for (const key of ["createdAt", "expiresAt"] as const) { const timestamp = own(session, key); if (timestamp !== null && safeTimestamp(timestamp) === null) throw new TypeError("invalid_vault_session_view"); }
  const capabilities = requireRecord(own(site, "capabilities"), "invalid_vault_capabilities");
  if (!hasOnlyKeys(capabilities, CAPABILITY_KEYS) || typeof own(capabilities, "authorize") !== "boolean" || typeof own(capabilities, "clear") !== "boolean") throw new TypeError("invalid_vault_capabilities");
  return site as unknown as VaultSiteStatus;
}

function validateBrowserProfileView(value: unknown): VaultBrowserProfile {
  const profile = requireRecord(value, "invalid_vault_browser_profile");
  if (!hasOnlyKeys(profile, PROFILE_VIEW_KEYS)) throw new TypeError("invalid_vault_browser_profile");
  for (const key of ["shared", "present", "running", "resetting"] as const) if (typeof own(profile, key) !== "boolean") throw new TypeError("invalid_vault_browser_profile");
  return profile as unknown as VaultBrowserProfile;
}

function validateAuthorizationProxyView(value: unknown): VaultAuthorizationProxy {
  const proxy = requireRecord(value, "invalid_vault_proxy_view");
  const source = own(proxy, "source");
  if (!hasOnlyKeys(proxy, PROXY_VIEW_KEYS) || typeof source !== "string" || !PROXY_SOURCES.has(source)) throw new TypeError("invalid_vault_proxy_view");
  const scheme = own(proxy, "scheme");
  if (typeof scheme !== "string" || (scheme !== "" && !PROXY_SCHEMES.has(scheme))) throw new TypeError("invalid_vault_proxy_view");
  if (typeof own(proxy, "displayEndpoint") !== "string" || (own(proxy, "displayEndpoint") !== "" && !SAFE_PROXY_DISPLAY_PATTERN.test(String(own(proxy, "displayEndpoint"))))) throw new TypeError("invalid_vault_proxy_view");
  for (const key of ["configured", "direct", "credentialsRedacted", "browserRunning", "restartPending", "valid"] as const) if (typeof own(proxy, key) !== "boolean") throw new TypeError("invalid_vault_proxy_view");
  if (own(proxy, "updatedAt") !== null && safeTimestamp(own(proxy, "updatedAt")) === null) throw new TypeError("invalid_vault_proxy_view");
  return proxy as unknown as VaultAuthorizationProxy;
}

export function validateVaultSnapshot(value: unknown): VaultSnapshot {
  const snapshot = requireRecord(value, "invalid_vault_view_model");
  if (!hasOnlyKeys(snapshot, SNAPSHOT_VIEW_KEYS)) throw new TypeError("invalid_vault_view_model");
  const order = own(snapshot, "siteOrder");
  if (!Array.isArray(order) || order.length !== SITE_ORDER.length || order.some((id, index) => id !== SITE_ORDER[index])) throw new TypeError("invalid_vault_view_model");
  const sites = requireRecord(own(snapshot, "sites"), "invalid_vault_view_model");
  for (const key of Object.keys(sites)) {
    if (!getVaultSiteDefinition(key)) throw new TypeError("invalid_vault_view_model");
    validateVaultSiteViewModel(sites[key]);
  }
  const profile = own(snapshot, "browserProfile");
  const proxy = own(snapshot, "authorizationProxy");
  if (profile !== null) validateBrowserProfileView(profile);
  if (proxy !== null) validateAuthorizationProxyView(proxy);
  return snapshot as unknown as VaultSnapshot;
}

export const sanitizeVaultStatus = sanitizeVaultSnapshot;

export function vaultWorkspacePresentation(snapshot: VaultSnapshot | null, siteId: VaultSiteId, phase: VaultWorkspacePhase) {
  const site = snapshot?.sites[siteId] ?? null;
  const hasSnapshot = Boolean(snapshot && (Object.keys(snapshot.sites).length > 0 || snapshot.browserProfile || snapshot.authorizationProxy));
  const complete = Boolean(snapshot && SITE_ORDER.every((id) => snapshot.sites[id]) && snapshot.browserProfile && snapshot.authorizationProxy);
  if (phase === "writing") return Object.freeze({ state: "writing", kind: "running", label: "正在写入", message: "操作完成后将权威重读当前站点和完整授权状态。" });
  if (phase === "error" && !hasSnapshot) return Object.freeze({ state: "error", kind: "error", label: "授权状态读取失败", message: "未获得可显示的安全授权事实；请刷新后重试。" });
  if (!hasSnapshot) return Object.freeze({ state: "loading", kind: "running", label: "正在加载", message: "正在读取五个站点、共享授权浏览器数据和登录代理状态。" });
  if (phase === "partial" || !complete || !site) return Object.freeze({ state: "partial", kind: "warning", label: "部分授权信息不可用", message: "保留已取得的安全事实；请刷新以补齐当前站点与共享状态。" });
  if (site.session.active) return Object.freeze({ state: "authorizing", kind: "running", label: "授权进行中", message: `${site.label} 正等待授权浏览器操作；仅当前站点会自动轮询。` });
  if (site.method !== "anonymous" && site.authorized && site.materialValid) return Object.freeze({ state: "authorized", kind: "ready", label: "站点材料已保存", message: `${site.label} 已有可供任务使用的托管授权材料。` });
  if (site.method !== "anonymous") return Object.freeze({ state: "required", kind: site.invalidated || site.configured ? "warning" : "disabled", label: site.invalidated ? "需要重新授权" : "尚未授权", message: site.invalidated ? `${site.label} 的现有材料已失效，请重新授权。` : `${site.label} 当前没有可供任务使用的托管授权材料。` });
  return Object.freeze({ state: "ready", kind: "ready", label: "公开访问就绪", message: `${site.label} 无需登录材料即可使用。` });
}

export function deriveVaultWorkspacePresentation(
  input: VaultSnapshot | null | { readonly snapshot?: VaultSnapshot | null; readonly siteId?: VaultSiteId; readonly phase?: VaultWorkspacePhase },
  siteId: VaultSiteId = "danbooru",
  phase: VaultWorkspacePhase = "idle",
 ) {
  if (input !== null && typeof input === "object" && Object.hasOwn(input, "snapshot")) {
    const view = input as { readonly snapshot?: VaultSnapshot | null; readonly siteId?: VaultSiteId; readonly phase?: VaultWorkspacePhase };
    return vaultWorkspacePresentation(view.snapshot ?? null, view.siteId ?? "danbooru", view.phase ?? "idle");
  }
  return vaultWorkspacePresentation(input as VaultSnapshot | null, siteId, phase);
}

function control(disabled: boolean, reason: string, label: string): VaultControl {
  return Object.freeze({ disabled, reason: disabled ? reason : "", label });
}

export function deriveVaultControls(snapshot: VaultSnapshot | null, { busy = "", proxyInputValid = true }: { readonly busy?: string; readonly proxyInputValid?: boolean } = {}): VaultControls {
  const isBusy = Boolean(busy);
  const activeSite = VAULT_SITE_IDS.find((id) => snapshot?.sites[id]?.session.active) ?? "";
  const sites = Object.create(null) as Record<VaultSiteId, VaultSiteControls>;
  const profile = snapshot?.browserProfile ?? null;
  const proxy = snapshot?.authorizationProxy ?? null;
  for (const id of SITE_ORDER) {
    const status = snapshot?.sites[id] ?? null;
    const definition = SITE_DEFINITIONS[id];
    const busyReason = "正在执行其他授权操作";
    const authorizeReason = isBusy ? busyReason : !status ? "请先刷新该站点状态" : !status.capabilities.authorize ? "该站点不支持浏览器授权" : profile?.resetting ? "正在清除授权浏览器数据" : activeSite && activeSite !== id ? `授权浏览器正用于 ${SITE_DEFINITIONS[activeSite].label}` : status.session.active ? "该站点已有活动授权会话" : "";
    const cancelReason = isBusy ? busyReason : !status?.session.active ? "当前没有可取消的授权会话" : "";
    const clearReason = isBusy ? busyReason : !status?.capabilities.clear ? "该站点不支持删除凭证" : !status.configured ? "当前没有可删除的站点凭证" : status.session.active ? "请先取消当前授权会话" : "";
    sites[id] = Object.freeze({
      authorize: control(Boolean(authorizeReason), authorizeReason, busy === `authorize:${id}` ? "正在打开…" : status?.authorized ? "重新授权" : "在授权浏览器中登录"),
      cancel: control(Boolean(cancelReason), cancelReason, busy === `cancel:${id}` ? "正在关闭…" : "关闭授权标签页"),
      clear: control(Boolean(clearReason), clearReason, busy === `clear:${id}` ? "正在删除…" : "删除站点凭证"),
      showAuthorize: Boolean(definition.authorizeAction),
      showCancel: Boolean(status?.session.active),
      showClear: Boolean(status?.capabilities.clear && status.configured),
    });
  }
  const profileReason = isBusy ? "正在执行其他授权操作" : !profile ? "请先刷新授权浏览器状态" : profile.resetting ? "正在清除授权浏览器数据" : activeSite ? `请先关闭 ${SITE_DEFINITIONS[activeSite].label} 授权标签页` : !profile.present ? "当前没有可清除的授权浏览器数据" : "";
  const saveReason = isBusy ? "正在执行其他授权操作" : !proxy ? "请先刷新登录代理状态" : !proxyInputValid ? "请修正登录代理地址格式" : "";
  const resetReason = isBusy ? "正在执行其他授权操作" : !proxy ? "请先刷新登录代理状态" : proxy.source !== "runtime" ? "当前没有授权管理中保存的设置" : "";
  return Object.freeze({
    sites: Object.freeze(sites),
    refresh: control(isBusy, isBusy ? "正在执行其他授权操作" : "", busy === "refresh" ? "正在刷新…" : "刷新授权状态"),
    profileClear: control(Boolean(profileReason), profileReason, busy === "profile-clear" ? "正在清除…" : "清除共享授权浏览器数据"),
    proxySave: control(Boolean(saveReason), saveReason, busy === "proxy-save" ? "正在保存…" : "保存登录代理设置"),
    proxyReset: control(Boolean(resetReason), resetReason, busy === "proxy-reset" ? "正在恢复…" : "恢复默认设置"),
    reveal: control(isBusy, isBusy ? "正在执行其他授权操作" : "", "显示或隐藏代理输入"),
    activeSite,
  });
}

const ERROR_NEXT_STEPS: Readonly<Record<string, string>> = Object.freeze({
  unsupported_auth_site: "请刷新状态并使用页面提供的站点操作。",
  managed_browser_unsupported: "请刷新状态并使用站点卡片中提供的操作。",
  browser_login_session_not_found: "请刷新站点状态；如仍未授权，请重新开始。",
  browser_login_start_failed: "请检查 Chrome 配置与桌面会话，然后手动重试。",
  shared_browser_busy: "请完成或取消当前授权，刷新状态后重试。",
  pixiv_oauth_start_failed: "请检查 Chrome 与授权代理，然后重试。",
  pixiv_oauth_start_timeout: "请检查 Chrome 与网络线路，刷新状态后重试。",
  pixiv_oauth_session_not_found: "请刷新 Pixiv 状态并重新开始授权。",
  pixiv_oauth_exchange_failed: "请重新授权；不要把 Token 粘贴到页面。",
  invalid_authorization_proxy: "请使用协议://主机:端口格式，不要添加路径或查询参数。",
  browser_profile_reset_active: "请等待当前清理操作结束后刷新。",
  browser_profile_busy: "请关闭残留的授权浏览器窗口，再刷新后重试。",
  invalid_browser_profile_path: "请检查授权浏览器数据目录配置后重试。",
  chrome_not_found: "请在服务配置中设置 Chrome/Chromium，然后重试。",
  auth_cache_clear_failed: "请刷新确认站点材料；必要时检查服务权限。",
  network_error: "服务恢复后使用“刷新授权状态”重试。",
  invalid_response: "请刷新；若持续发生，请检查服务与桌面界面的版本是否匹配。",
  auth_request_too_large: "请缩短代理地址并确认没有粘贴 Cookie、Header 或配置文件内容。",
  invalid_content_length: "请刷新页面后重新输入完整代理地址。",
  pixiv_oauth_session_expired: "请重新开始，并在授权浏览器中完成登录。",
  pixiv_oauth_exchange_active: "请等待状态自动更新，不要重复提交。",
  pixiv_oauth_process_ended: "请刷新状态后重新开始授权。",
  pixiv_oauth_exchange_timeout: "请检查授权代理与外部网络，然后重新开始。",
  pixiv_oauth_cache_failed: "请检查私有凭证目录权限后重新授权。",
  invalid_pixiv_oauth_code: "请重新开始 Pixiv 授权，不要粘贴浏览器回调内容。",
});
const ERROR_GUIDANCE: Readonly<Record<string, Readonly<{ title: string; message: string }>>> = Object.freeze({
  invalid_authorization_proxy: Object.freeze({ title: "登录代理格式无效", message: "服务未接受该登录代理地址。" }),
  auth_request_too_large: Object.freeze({ title: "登录代理请求过大", message: "请求超过登录代理接口的大小上限。" }),
  invalid_content_length: Object.freeze({ title: "请求大小信息无效", message: "服务未接受请求大小信息。" }),
  unsupported_auth_site: Object.freeze({ title: "站点不支持授权", message: "当前版本不支持该站点授权。" }),
  managed_browser_unsupported: Object.freeze({ title: "授权方式不支持", message: "该站点不能使用授权浏览器登录。" }),
  shared_browser_busy: Object.freeze({ title: "授权浏览器正忙", message: "另一项授权或浏览器数据清理正在进行。" }),
  chrome_not_found: Object.freeze({ title: "未找到 Chrome / Chromium", message: "服务无法启动授权浏览器。" }),
  browser_profile_busy: Object.freeze({ title: "授权浏览器数据正在使用", message: "服务暂时无法使用授权浏览器数据。" }),
  browser_login_start_failed: Object.freeze({ title: "授权浏览器启动失败", message: "服务未能打开授权浏览器标签页。" }),
  browser_login_session_not_found: Object.freeze({ title: "授权会话已失效", message: "服务找不到刚才的浏览器授权会话。" }),
  pixiv_oauth_session_not_found: Object.freeze({ title: "Pixiv 会话已失效", message: "服务找不到当前 Pixiv 授权会话。" }),
  pixiv_oauth_session_expired: Object.freeze({ title: "Pixiv 授权已过期", message: "本次 Pixiv 授权没有在时限内完成。" }),
  pixiv_oauth_start_timeout: Object.freeze({ title: "Pixiv 授权启动超时", message: "服务未能及时建立 Pixiv 授权流程。" }),
  pixiv_oauth_start_failed: Object.freeze({ title: "Pixiv 授权启动失败", message: "服务未能启动 Pixiv OAuth 和浏览器授权。" }),
  pixiv_oauth_exchange_active: Object.freeze({ title: "Pixiv 正在确认授权", message: "服务正在处理 Pixiv 授权回调。" }),
  pixiv_oauth_process_ended: Object.freeze({ title: "Pixiv 授权进程已结束", message: "本次 Pixiv 授权进程无法继续。" }),
  pixiv_oauth_exchange_timeout: Object.freeze({ title: "Pixiv 授权确认超时", message: "服务未能在时限内完成 Token 交换。" }),
  pixiv_oauth_exchange_failed: Object.freeze({ title: "Pixiv 授权确认失败", message: "服务没有保存可用的 Pixiv 登录令牌。" }),
  pixiv_oauth_cache_failed: Object.freeze({ title: "Pixiv 授权保存失败", message: "服务无法保存 Pixiv 登录令牌。" }),
  auth_cache_clear_failed: Object.freeze({ title: "授权凭证清理失败", message: "服务未确认授权凭证已删除。" }),
  browser_profile_reset_active: Object.freeze({ title: "正在清除授权浏览器数据", message: "已有一个浏览器数据清理操作正在执行。" }),
  invalid_browser_profile_path: Object.freeze({ title: "授权浏览器数据路径校验失败", message: "服务拒绝清理超出私有目录范围的授权浏览器数据。" }),
  network_error: Object.freeze({ title: "服务连接中断", message: "授权管理无法连接到 LDOS 服务。" }),
  invalid_response: Object.freeze({ title: "授权状态数据无效", message: "页面无法读取服务返回的授权状态。" }),
});

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "request_failed";
}

function errorField(error: unknown, key: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function vaultErrorPresentation(error: unknown): VaultErrorPresentation {
  let code = safeCode(errorField(error, "code"));
  if (code === "request_failed" && error instanceof TypeError) code = "invalid_response";
  const statusValue = errorField(error, "status");
  const status = typeof statusValue === "number" && Number.isInteger(statusValue) ? statusValue : 0;
  const nextStep = ERROR_NEXT_STEPS[code] ?? (status === 401 || status === 403 ? "请从 LDOS 桌面重新打开，并检查服务访问策略。" : status === 409 ? "请刷新授权状态，完成当前授权后再重试。" : status === 422 ? "请检查当前输入格式后重试。" : status >= 500 ? "已加载状态会继续保留，请稍后刷新；必要时打开系统诊断。" : "请刷新授权状态后重试。");
  const requestId = errorField(error, "requestId");
  return Object.freeze({
    code,
    status,
    title: ERROR_GUIDANCE[code]?.title ?? (status === 422 ? "授权请求格式无效" : status === 409 ? "授权操作冲突" : status >= 500 ? "授权服务暂时不可用" : "授权操作失败"),
    message: ERROR_GUIDANCE[code]?.message ?? (status === 0 ? "无法连接到 LDOS 服务。" : "服务未接受本次授权操作。"),
    nextStep,
    requestId: typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId) ? requestId : "",
  });
}

export const vaultErrorGuidance = vaultErrorPresentation;
