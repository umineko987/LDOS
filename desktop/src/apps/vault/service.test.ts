import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { VAULT_SITE_IDS, type VaultSessionReference } from "./model";
import { createVaultService } from "./service";

const SESSION_ID = "0123456789abcdef0123456789abcdef";

function rawSite(site: string, overrides: Record<string, unknown> = {}) {
  const definitions: Record<string, Record<string, unknown>> = {
    danbooru: { label: "Danbooru", method: "anonymous", state: "ready", authorized: true, actions: [] },
    twitter: { label: "X / Twitter", method: "managed_browser", state: "authorized", authorized: true, actions: ["managed_browser_login", "clear"], cookies: { present: true, valid: true, cookie_count: 2 }, login: null },
    pixiv: { label: "Pixiv", method: "oauth", state: "required", authorized: false, actions: ["oauth", "clear"], oauth: null },
    exhentai: { label: "EH", method: "managed_browser", state: "required", authorized: false, actions: ["managed_browser_login", "clear"], cookies: { present: false, valid: false, cookie_count: 0 }, login: null },
    pawchive: { label: "Pawchive", method: "anonymous", state: "ready", authorized: true, actions: [] },
  };
  return { site, ...definitions[site], ...overrides };
}

function rawSnapshot() {
  return {
    items: VAULT_SITE_IDS.map((site) => rawSite(site)),
    browser_profile: { shared: true, present: true, running: false, resetting: false },
    authorization_proxy: { proxy_url: "https://***@login-proxy.invalid:8443", source: "runtime", credentials_redacted: true, browser_running: false, restart_pending: false, updated_at: 1_700_000_100 },
    secrets_exposed: false,
  };
}

function api() {
  return {
    get: vi.fn(async () => rawSnapshot()),
    post: vi.fn(async () => ({ status: rawSite("twitter") })),
    put: vi.fn(async () => ({ proxy_url: "https://***@login-proxy.invalid:8443", source: "runtime", credentials_redacted: true, browser_running: false, restart_pending: false })),
    delete: vi.fn(async () => ({ status: rawSite("twitter") })),
  } as unknown as ApiClient & Record<"get" | "post" | "put" | "delete", ReturnType<typeof vi.fn>>;
}

describe("Vault API service", () => {
  it("uses the exact five endpoints and sanitizes full/site reads", async () => {
    const client = api();
    const service = createVaultService(client);
    const signal = new AbortController().signal;
    const full = await service.readStatus(signal);
    client.get.mockResolvedValueOnce(rawSite("twitter"));
    const site = await service.readSite("twitter", signal);
    expect(full.snapshot.siteOrder).toEqual([...VAULT_SITE_IDS]);
    expect(site.status.site).toBe("twitter");
    expect(client.get.mock.calls).toEqual([
      ["/api/v1/auth?view=vault", { signal }],
      ["/api/v1/auth/twitter?view=vault", { signal }],
    ]);
  });

  it("keeps authorization paths fixed and rejects untrusted session references before I/O", async () => {
    const client = api();
    const service = createVaultService(client);
    const signal = new AbortController().signal;
    await service.authorize("twitter", signal);
    await service.authorize("pixiv", signal);
    const managed: VaultSessionReference = { site: "twitter", kind: "managed_browser", sessionId: SESSION_ID };
    const oauth: VaultSessionReference = { site: "pixiv", kind: "oauth", sessionId: SESSION_ID };
    client.get.mockResolvedValueOnce({ status: rawSite("twitter", { state: "authorizing", login: { session_id: SESSION_ID, state: "awaiting_login" } }), session: { session_id: SESSION_ID, state: "awaiting_login" } });
    client.get.mockResolvedValueOnce(rawSite("pixiv", { state: "authorizing", oauth: { session_id: SESSION_ID, state: "awaiting_login" } }));
    await service.readSession(managed, signal);
    await service.readSession(oauth, signal);
    await service.cancel(managed, signal);
    await service.cancel(oauth, signal);
    expect(client.post.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/twitter/login/start?view=vault",
      "/api/v1/auth/pixiv/oauth/start?view=vault",
    ]);
    expect(client.get.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/twitter/login/0123456789abcdef0123456789abcdef?view=vault",
      "/api/v1/auth/pixiv?view=vault",
    ]);
    await expect(service.readSession({ ...managed, sessionId: "../secret" }, signal)).rejects.toThrow("invalid_vault_session_reference");
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.delete.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/twitter/login/0123456789abcdef0123456789abcdef?view=vault",
      "/api/v1/auth/pixiv/oauth/session?view=vault",
    ]);
    await expect(service.cancel({ ...managed, sessionId: "../secret" }, signal)).rejects.toThrow("invalid_vault_session_reference");
    expect(client.delete).toHaveBeenCalledTimes(2);
  });

  it("uses exact proxy/profile/site write methods and transient bodies", async () => {
    const client = api();
    const service = createVaultService(client);
    const signal = new AbortController().signal;
    const proxy = "https://user:secret@proxy.invalid:8443";
    await service.saveProxy(proxy, signal);
    await service.resetProxy(signal);
    await service.clearProfile(signal);
    await service.clearSite("twitter", signal);
    expect(client.put.mock.calls).toEqual([["/api/v1/auth/proxy?view=vault", { proxy_url: proxy }, { signal }]]);
    expect(client.delete.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/proxy?view=vault",
      "/api/v1/auth/browser-profile?view=vault",
      "/api/v1/auth/twitter?view=vault",
    ]);
    await expect(service.clearSite("danbooru", signal)).rejects.toThrow("unsupported_vault_clear");
  });
});
