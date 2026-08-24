import { describe, expect, it, vi } from "vitest";

import { sanitizeVaultSiteStatus, sanitizeVaultSnapshot } from "../src/apps/vault/model";
import Vault from "../src/apps/vault/Vault.svelte";
import vaultSource from "../src/apps/vault/Vault.svelte?raw";
import { createVaultStore } from "../src/apps/vault/state";

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

function snapshot() {
  return sanitizeVaultSnapshot({
    items: ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"].map((site) => rawSite(site)),
    browser_profile: { shared: true, present: true, running: false, resetting: false },
    authorization_proxy: { proxy_url: null, source: "none", credentials_redacted: false, browser_running: false, restart_pending: false },
    secrets_exposed: false,
  });
}

describe("P4 Vault target ownership", () => {
  it("updates one keyed site while retaining unrelated snapshot facts and one notification", () => {
    const store = createVaultStore({ selectedSite: "twitter" });
    const initial = snapshot();
    store.commitSnapshot(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    const next = sanitizeVaultSiteStatus(rawSite("twitter", { state: "required", authorized: false, cookies: { present: false, valid: false, cookie_count: 0 } }));
    store.commitSite(next);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().snapshot?.sites.danbooru).toBe(initial.sites.danbooru);
    expect(store.getState().snapshot?.browserProfile).toBe(initial.browserProfile);
    expect(store.getState().snapshot?.sites.twitter).toBe(next);
  });

  it("pins keyed Svelte site projections and the no-bypass boundary", () => {
    expect(vaultSource).toContain("{#each siteItems as item (item.definition.id)}");
    expect(vaultSource).not.toContain("replaceChildren(");
    expect(vaultSource).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetInterval\s*\(|innerHTML|console\./);
    expect(vaultSource).toContain('data-domain-owner="vault"');
    expect(vaultSource).toContain("data-vault-action={`site:${item.definition.id}`}");
    expect(Vault).toBeDefined();
  });
});
