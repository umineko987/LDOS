import { describe, expect, it, vi } from "vitest";

import type { PollingRegistration, PollingService } from "../../core/polling/service";
import {
  AUTHORIZATION_POLL_INTERVAL_MS,
  sanitizeAuthorizationProxy,
  sanitizeVaultSiteStatus,
  sanitizeVaultSnapshot,
  type VaultSessionReference,
  type VaultSiteRead,
} from "./model";
import { createVaultController } from "./controller";
import type { VaultService } from "./service";
import { createVaultStore } from "./state";

const SESSION_ID = "0123456789abcdef0123456789abcdef";

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

function rawSnapshot(activeSite = "") {
  const items = ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"].map((site) => rawSite(site));
  if (activeSite) {
    const index = ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"].indexOf(activeSite);
    const method = activeSite === "pixiv" ? "oauth" : "login";
    items[index] = rawSite(activeSite, { state: "authorizing", [method]: { session_id: SESSION_ID, state: "awaiting_login" } });
  }
  return sanitizeVaultSnapshot({
    items,
    browser_profile: { shared: true, present: true, running: Boolean(activeSite), resetting: false },
    authorization_proxy: { proxy_url: "https://***@proxy.invalid:8443", source: "runtime", credentials_redacted: true, browser_running: false, restart_pending: false },
    secrets_exposed: false,
  });
}

function siteRead(site: string, overrides: Record<string, unknown> = {}): VaultSiteRead {
  const raw = rawSite(site, overrides);
  return Object.freeze({ status: sanitizeVaultSiteStatus(raw), session: null });
}

function activeReference(site: "twitter" | "pixiv" = "twitter"): VaultSessionReference {
  return Object.freeze({ site, kind: site === "pixiv" ? "oauth" : "managed_browser", sessionId: SESSION_ID });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function polling() {
  type Entry = { registration: PollingRegistration<unknown>; signal: AbortController | null; stop: ReturnType<typeof vi.fn> };
  const registrations = new Map<string, Entry>();
  const poll = {
    start: vi.fn((registration: PollingRegistration<unknown>) => {
      const entry: Entry = { registration, signal: null, stop: vi.fn(() => { entry.signal?.abort(); registrations.delete(registration.key); return true; }) };
      registrations.set(registration.key, entry);
      return { key: registration.key, scope: registration.scope ?? "", trigger: vi.fn(async () => false), stop: entry.stop };
    }),
    stop: vi.fn((key: string) => { const entry = registrations.get(key); if (!entry) return false; entry.signal?.abort(); registrations.delete(key); return true; }),
    stopScope: vi.fn((scope: string) => { for (const [key, entry] of registrations) if (entry.registration.scope === scope) { entry.signal?.abort(); registrations.delete(key); } return 0; }),
    getSummary: vi.fn(() => []),
    destroy: vi.fn(),
    registrations,
  };
  return poll;
}

function harness(overrides: Partial<VaultService> = {}, activeSite: "" | "twitter" | "pixiv" = "") {
  const snapshot = rawSnapshot(activeSite);
  const reference = activeSite ? activeReference(activeSite) : null;
  const service = {
    readStatus: vi.fn(async () => ({ snapshot, session: reference })),
    readSite: vi.fn(async (site: "danbooru" | "twitter" | "pixiv" | "exhentai" | "pawchive") => siteRead(site, { label: site === "twitter" ? "X / Twitter" : site === "danbooru" ? "Danbooru" : site === "pixiv" ? "Pixiv" : site === "exhentai" ? "EH" : "Pawchive" })),
    readSession: vi.fn(async (current: VaultSessionReference) => siteRead(current.site, { state: "authorizing", [current.kind === "oauth" ? "oauth" : "login"]: { session_id: SESSION_ID, state: "awaiting_login" } })),
    authorize: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    clearSite: vi.fn(async () => ({})),
    clearProfile: vi.fn(async () => ({})),
    readBrowser: vi.fn(async () => ({ available: false, name: "", source: "none" as const, message: "未检测到浏览器" })),
    selectBrowser: vi.fn(async () => ({ available: true, name: "Chrome", source: "configured" as const, message: "已选择 Chrome" })),
    detectBrowser: vi.fn(async () => ({ available: false, name: "", source: "none" as const, message: "未检测到浏览器" })),
    saveProxy: vi.fn(async () => sanitizeAuthorizationProxy({ proxy_url: null, source: "none" })),
    resetProxy: vi.fn(async () => ({})),
  };
  Object.assign(service, overrides);
  const store = createVaultStore({ selectedSite: activeSite || "twitter" });
  const poll = polling();
  const controller = createVaultController({ store, service: service as VaultService, polling: poll as unknown as PollingService });
  return { service, store, poll, controller, snapshot, reference };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runPoll(entry: ReturnType<typeof polling>["registrations"] extends Map<string, infer E> ? E : never): Promise<void> {
  const abort = new AbortController();
  entry.signal = abort;
  const result = await entry.registration.task(abort.signal);
  entry.registration.onResult(result);
}

describe("Vault controller", () => {
  it("performs one initial full read and starts only active-session polling at 800ms", async () => {
    const runtime = harness({}, "twitter");
    runtime.controller.activate();
    await flush();
    expect(runtime.service.readStatus).toHaveBeenCalledOnce();
    expect(runtime.service.readSite).not.toHaveBeenCalled();
    expect(runtime.poll.start).toHaveBeenCalledWith(expect.objectContaining({
      key: "vault.authorization",
      scope: "app:vault",
      intervalMs: AUTHORIZATION_POLL_INTERVAL_MS,
      alwaysFocusRate: true,
      immediate: false,
      critical: false,
    }));
    runtime.controller.destroy();
  });

  it("stops completed session polling and performs full plus selected-site authority reread", async () => {
    const runtime = harness({}, "twitter");
    runtime.controller.activate();
    await flush();
    const entry = runtime.poll.registrations.get("vault.authorization")!;
    (runtime.service.readSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(siteRead("twitter", { state: "authorized", login: null }));
    await runPoll(entry);
    await flush();
    expect(runtime.poll.registrations.has("vault.authorization")).toBe(false);
    expect(runtime.service.readStatus).toHaveBeenCalledTimes(2);
    expect(runtime.service.readSite).toHaveBeenCalledTimes(1);
    runtime.controller.destroy();
  });

  it("uses one write followed by one full plus site reread and rejects duplicate writes", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await flush();
    const first = runtime.controller.authorize("twitter");
    const second = runtime.controller.authorize("twitter");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(runtime.service.authorize).toHaveBeenCalledOnce();
    expect(runtime.service.readStatus).toHaveBeenCalledTimes(2);
    expect(runtime.service.readSite).toHaveBeenCalledOnce();
    expect(runtime.store.getState()).toMatchObject({ busy: "", phase: "idle" });
    runtime.controller.destroy();
  });

  it("does not commit a stale initial response after destroy and aborts its signal", async () => {
    const pending = deferred<Awaited<ReturnType<VaultService["readStatus"]>>>();
    let signal: AbortSignal | null = null;
    const runtime = harness({ readStatus: vi.fn((currentSignal: AbortSignal) => { signal = currentSignal; return pending.promise; }) });
    runtime.controller.activate();
    await flush();
    runtime.controller.destroy();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    pending.resolve({ snapshot: rawSnapshot(), session: null });
    await flush();
    expect(runtime.store.getState().snapshot).toBeNull();
  });

  it("requires confirmation, clears direct proxy input before writing, and rereads after confirmed actions", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await flush();
    expect(await runtime.controller.saveProxy("https://user:secret@proxy.invalid:8443")).toBe(true);
    const before = runtime.service.saveProxy.mock.calls.length;
    expect(await runtime.controller.saveProxy("")).toBe(false);
    expect(runtime.store.getState().confirmation?.action).toBe("proxy-direct");
    expect(runtime.service.saveProxy).toHaveBeenCalledTimes(before);
    expect(await runtime.controller.confirmAction(false)).toBe(false);
    expect(await runtime.controller.requestClearProfile()).toBe(true);
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.service.clearProfile).toHaveBeenCalledOnce();
    expect(runtime.service.readStatus).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(runtime.store.getState())).not.toContain("secret");
    runtime.controller.destroy();
  });

  it("stops the selected session immediately on site switch and does not revive another site's poll", async () => {
    const runtime = harness({}, "twitter");
    runtime.controller.activate();
    await flush();
    expect(runtime.poll.registrations.has("vault.authorization")).toBe(true);
    await expect(runtime.controller.selectSite("pixiv")).resolves.toBe(true);
    expect(runtime.poll.registrations.has("vault.authorization")).toBe(false);
    expect(runtime.service.readStatus).toHaveBeenCalledTimes(2);
    expect(runtime.service.readSite).toHaveBeenCalledWith("pixiv", expect.any(AbortSignal));
    expect(runtime.store.getState()).toMatchObject({ selectedSite: "pixiv", busy: "" });
    runtime.controller.destroy();
  });

  it("confirms cancel, site-clear, proxy-reset, and profile-clear before exact writes", async () => {
    const active = harness({}, "twitter");
    active.controller.activate();
    await flush();
    expect(active.controller.requestCancel("twitter")).toBe(true);
    expect(await active.controller.confirmAction(true)).toBe(true);
    expect(active.service.cancel).toHaveBeenCalledWith(active.reference, expect.any(AbortSignal));
    active.controller.destroy();

    const runtime = harness();
    runtime.controller.activate();
    await flush();
    expect(runtime.controller.requestClearSite("twitter")).toBe(true);
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.service.clearSite).toHaveBeenCalledWith("twitter", expect.any(AbortSignal));
    expect(runtime.controller.requestResetProxy()).toBe(true);
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.service.resetProxy).toHaveBeenCalledOnce();
    expect(runtime.controller.requestClearProfile()).toBe(true);
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.service.clearProfile).toHaveBeenCalledOnce();
    runtime.controller.destroy();
  });

  it("returns all polling registrations and abortable references to baseline across 20 cycles", async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const runtime = harness({}, "twitter");
      runtime.controller.activate();
      await flush();
      expect(runtime.poll.registrations.size).toBe(1);
      runtime.controller.deactivate();
      expect(runtime.poll.registrations.size).toBe(0);
      runtime.controller.destroy();
      expect(runtime.poll.registrations.size).toBe(0);
      expect(runtime.store.getState().confirmation).toBeNull();
    }
  });
});
