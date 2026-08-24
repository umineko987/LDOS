import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_POLL_INTERVAL_MS,
  VAULT_SITE_IDS,
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  deriveVaultWorkspacePresentation,
  extractVaultSessionReference,
  sanitizeVaultStatus,
  sanitizeVaultSnapshot,
  validateAuthorizationProxyInput,
  validateVaultSnapshot,
  vaultErrorPresentation,
} from "./model";

const SECRET = "vault-cookie-token-path-secret-314159";
const SESSION_ID = "0123456789abcdef0123456789abcdef";

function rawSite(site: string, overrides: Record<string, unknown> = {}) {
  const definitions: Record<string, Record<string, unknown>> = {
    danbooru: { label: "Danbooru", method: "anonymous", state: "ready", authorized: true, actions: [] },
    twitter: { label: "X / Twitter", method: "managed_browser", state: "authorized", authorized: true, actions: ["managed_browser_login", "clear", `token=${SECRET}`], cookies: { present: true, valid: true, cookie_count: 2, raw_cookie: SECRET }, login: null },
    pixiv: { label: "Pixiv", method: "oauth", state: "required", authorized: false, actions: ["oauth", "clear"], oauth: null },
    exhentai: { label: "EH", method: "managed_browser", state: "required", authorized: false, actions: ["managed_browser_login", "clear"], cookies: { present: false, valid: false, cookie_count: 0 }, login: null },
    pawchive: { label: "Pawchive", method: "anonymous", state: "ready", authorized: true, actions: [] },
  };
  return { site, summary: `Bearer ${SECRET} https://private.invalid/${SECRET}`, ...definitions[site], ...overrides };
}

function rawSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    items: VAULT_SITE_IDS.map((site) => rawSite(site)),
    browser_profile: { shared: true, present: true, running: false, resetting: false, path: `/private/${SECRET}` },
    authorization_proxy: { proxy_url: "https://***@login-proxy.fixture.invalid:8443", source: "runtime", credentials_redacted: true, browser_running: false, restart_pending: false, updated_at: 1_700_000_100, raw_proxy_url: SECRET },
    managed: true,
    secrets_exposed: false,
    response_profile: "vault",
    raw: SECRET,
    ...overrides,
  };
}

function activeSnapshot(site = "twitter", sessionId = SESSION_ID) {
  const snapshot = rawSnapshot();
  const index = VAULT_SITE_IDS.indexOf(site as (typeof VAULT_SITE_IDS)[number]);
  const method = site === "pixiv" ? "oauth" : "login";
  snapshot.items[index] = rawSite(site, {
    state: "authorizing",
    [method]: { session_id: sessionId, state: "awaiting_login", created_at: 1_700_000_000, expires_at: 1_700_000_600, authorization_url: `https://private.invalid/?token=${SECRET}`, raw: SECRET },
  });
  snapshot.browser_profile.running = true;
  return snapshot;
}

describe("Vault security model", () => {
  it("keeps the five sites ordered and projects no secret, URL, or session id", () => {
    const projected = sanitizeVaultStatus(rawSnapshot());
    expect(projected.siteOrder).toEqual(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
    expect(projected.sites.twitter.cookieCount).toBe(2);
    expect(projected.authorizationProxy?.displayEndpoint).toBe("HTTPS · login-proxy.fixture.invalid:8443");
    const serialized = JSON.stringify(projected);
    for (const forbidden of [SECRET, "private.invalid", "authorization_url", "raw_cookie", "raw_proxy_url", "proxy_url", "session_id"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => sanitizeVaultSnapshot(rawSnapshot({ secrets_exposed: true }))).toThrow(TypeError);
  });

  it("validates proxy input and retains the payload only at the service boundary", () => {
    const secretProxy = `https://user:${SECRET}@proxy.fixture.invalid:8443`;
    expect(validateAuthorizationProxyInput(secretProxy)).toMatchObject({ valid: true, mode: "proxy" });
    expect(buildAuthorizationProxyPayload(secretProxy)).toEqual({ proxy_url: secretProxy });
    expect(buildAuthorizationProxyPayload("")).toEqual({ proxy_url: "" });
    for (const invalid of ["http://proxy.invalid", "file:///private/proxy", "https://proxy.invalid:443/path", "https://proxy.invalid:443?token=x", "socks5://user:pass@proxy.invalid:1080", `http://proxy.invalid:8080\n${SECRET}`]) {
      expect(validateAuthorizationProxyInput(invalid).valid).toBe(false);
      expect(() => buildAuthorizationProxyPayload(invalid)).toThrow(TypeError);
    }
  });

  it("derives all workspace states, filters unsafe sessions, and gates stale requests", () => {
    const snapshot = sanitizeVaultSnapshot(rawSnapshot());
    const active = sanitizeVaultSnapshot(activeSnapshot("pixiv"));
    expect(deriveVaultWorkspacePresentation(null, "danbooru", "loading").state).toBe("loading");
    expect(deriveVaultWorkspacePresentation(snapshot, "twitter", "idle").state).toBe("authorized");
    expect(deriveVaultWorkspacePresentation(snapshot, "pixiv", "idle").state).toBe("required");
    expect(deriveVaultWorkspacePresentation(active, "pixiv", "idle").state).toBe("authorizing");
    expect(deriveVaultWorkspacePresentation(snapshot, "twitter", "writing").state).toBe("writing");
    expect(deriveVaultWorkspacePresentation({ ...snapshot, sites: { danbooru: snapshot.sites.danbooru }, browserProfile: null, authorizationProxy: null }, "danbooru", "partial").state).toBe("partial");
    expect(deriveVaultWorkspacePresentation(null, "danbooru", "error").state).toBe("error");
    expect(AUTHORIZATION_POLL_INTERVAL_MS).toBe(800);

    expect(extractVaultSessionReference(activeSnapshot("pixiv").items[2])).toEqual({ site: "pixiv", kind: "oauth", sessionId: SESSION_ID });
    expect(extractVaultSessionReference(rawSite("twitter", { login: { session_id: SECRET, state: "awaiting_login" } }))).toBeNull();
    expect(extractVaultSessionReference(rawSite("twitter", { login: { session_id: SESSION_ID, state: "authorized" } }))).toBeNull();

    const gate = createVaultRequestGate();
    const oldStatus = gate.beginRead("status");
    const currentStatus = gate.beginRead("status");
    const session = gate.beginRead("session");
    expect(gate.isReadCurrent(oldStatus)).toBe(false);
    expect(gate.isReadCurrent(currentStatus)).toBe(true);
    expect(gate.isReadCurrent(session)).toBe(true);
    const beforeWrite = gate.beginRead("status");
    const write = gate.beginWrite();
    expect(gate.isReadCurrent(beforeWrite)).toBe(false);
    expect(gate.isWriteCurrent(write)).toBe(true);
    gate.advanceLifecycle();
    expect(gate.isWriteCurrent(write)).toBe(false);
  });

  it("rejects unknown view fields and never echoes backend error details", () => {
    const snapshot = sanitizeVaultSnapshot(rawSnapshot());
    expect(() => validateVaultSnapshot({ ...snapshot, leaked: SECRET })).toThrow("invalid_vault_view_model");
    const error = vaultErrorPresentation(Object.assign(new Error(SECRET), { code: "invalid_authorization_proxy", status: 422, requestId: "request-safe", details: { token: SECRET } }));
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(error.code).toBe("invalid_authorization_proxy");
  });
});
