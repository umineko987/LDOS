import { describe, expect, it, vi } from "vitest";

import { sanitizeVaultSiteStatus, sanitizeVaultSnapshot } from "./model";
import { createVaultStore } from "./state";

function rawSite(site: string, overrides: Record<string, unknown> = {}) {
  const definitions: Record<string, Record<string, unknown>> = {
    danbooru: { method: "anonymous", state: "ready", authorized: true, actions: [] },
    twitter: { method: "managed_browser", state: "authorized", authorized: true, actions: ["managed_browser_login", "clear"], cookies: { present: true, valid: true, cookie_count: 2 }, login: null },
    pixiv: { method: "oauth", state: "required", authorized: false, actions: ["oauth", "clear"], oauth: null },
    exhentai: { method: "managed_browser", state: "required", authorized: false, actions: ["managed_browser_login", "clear"], cookies: { present: false, valid: false, cookie_count: 0 }, login: null },
    pawchive: { method: "anonymous", state: "ready", authorized: true, actions: [] },
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

describe("the one Vault domain state owner", () => {
  it("commits one sanitized snapshot once with fixed keyed site order", () => {
    const store = createVaultStore({ selectedSite: "twitter" });
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    const value = snapshot();
    expect(store.commitSnapshot(value)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().snapshot?.siteOrder).toEqual(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
    expect(store.getState()).toMatchObject({ selectedSite: "twitter", phase: "idle", busy: "" });
  });

  it("updates one site while retaining unrelated authority identities", () => {
    const store = createVaultStore({ selectedSite: "twitter" });
    store.commitSnapshot(snapshot());
    const before = store.getState().snapshot!;
    const twitter = sanitizeVaultSiteStatus(rawSite("twitter", { authorized: false, state: "required", cookies: { present: false, valid: false, cookie_count: 0 } }));
    store.commitSite(twitter);
    expect(store.getState().snapshot?.sites.twitter).toBe(twitter);
    expect(store.getState().snapshot?.sites.pixiv).toBe(before.sites.pixiv);
    expect(store.getState().snapshot?.browserProfile).toBe(before.browserProfile);
    expect(store.getState().snapshot?.authorizationProxy).toBe(before.authorizationProxy);
  });

  it("owns one confirmation, gates writes, and keeps authority on failure", () => {
    const store = createVaultStore();
    store.commitSnapshot(snapshot());
    expect(store.requestConfirmation({ action: "profile-clear", site: "", title: "清除？", message: "清除", confirmLabel: "确认", warning: "危险" })).toBe(true);
    expect(store.requestConfirmation(store.getState().confirmation!)).toBe(false);
    expect(store.beginWrite("profile-clear")).toBe(false);
    expect(store.clearConfirmation()).toBe(true);
    expect(store.beginWrite("profile-clear")).toBe(true);
    store.fail({ code: "network_error", status: 0, title: "失败", message: "失败", nextStep: "刷新", requestId: "" });
    expect(store.getState()).toMatchObject({ phase: "partial", busy: "" });
    expect(store.getState().snapshot).not.toBeNull();
  });

  it("rejects invalid site changes and clears subscribers on destroy", () => {
    const store = createVaultStore();
    expect(store.selectSite("twitter")).toBe(true);
    expect(store.selectSite("twitter")).toBe(false);
    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    store.destroy();
    expect(store.setMessage("after destroy")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
