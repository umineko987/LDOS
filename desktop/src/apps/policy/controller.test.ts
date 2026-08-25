import { describe, expect, it, vi } from "vitest";
import { createPolicyController } from "./controller";
import { sanitizePolicyResponse, type PolicyDraft, type PolicySnapshot } from "./model";
import type { PolicyService } from "./service";
import { createPolicyStore } from "./state";

const draft: PolicyDraft = { max_concurrency: "9", retry_limit: "4", backoff_base_seconds: "1.25", proxy_mode: "required" };
function snapshot(overrides: Record<string, Record<string, unknown>> = {}): PolicySnapshot {
  const policy = { max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" };
  const sites = [["danbooru", "Danbooru", "anonymous"], ["twitter", "X / Twitter", "managed_browser"], ["pixiv", "Pixiv", "oauth"], ["exhentai", "EH", "managed_browser_for_private_content"], ["pawchive", "Pawchive", "anonymous"]] as const;
  return sanitizePolicyResponse({ response_profile: "policy", secrets_exposed: false, effect_scope: "new_requests_and_tasks", concurrency_protection: "none", default_source: "startup_snapshot", persistence: "sqlite_atomic", default: { editable: true, reason: "", policy }, items: sites.map(([site, label, authorization]) => ({ site, label, supported: true, authorization, selection_mode: "per_request", availability: "not_probed", inherited: !overrides[site], has_override: Boolean(overrides[site]), editable: true, reason: "", updated_at: overrides[site] ? 1_700_000_000 : null, policy: overrides[site] ?? policy })), unknown_override_count: 0 });
}
function harness(overrides: Partial<PolicyService> = {}) {
  let authority = snapshot();
  const service = { read: vi.fn(async () => authority), save: vi.fn(async () => { authority = snapshot({ danbooru: { max_concurrency: 9, retry_limit: 4, backoff_base_seconds: 1.25, proxy_mode: "required" } }); }), reset: vi.fn(async () => { authority = snapshot(); }), ...overrides } as PolicyService;
  const store = createPolicyStore();
  const controller = createPolicyController({ store, service });
  return { store, service, controller };
}

async function flush(): Promise<void> { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

describe("Policy controller", () => {
  it("activates once without polling and performs save/reset with one authority reread", async () => {
    const runtime = harness();
    runtime.controller.activate();
    runtime.controller.activate();
    await flush();
    expect(runtime.service.read).toHaveBeenCalledOnce();
    await expect(runtime.controller.save("danbooru", draft)).resolves.toBe(true);
    expect(runtime.service.save).toHaveBeenCalledWith("danbooru", draft, expect.any(AbortSignal));
    expect(runtime.service.read).toHaveBeenCalledTimes(2);
    expect(runtime.store.getState()).toMatchObject({ phase: "saved", busy: "" });
    expect(runtime.controller.requestReset("danbooru")).toBe(true);
    await expect(runtime.controller.confirmAction(true)).resolves.toBe(true);
    expect(runtime.service.reset).toHaveBeenCalledWith("danbooru", expect.any(AbortSignal));
    expect(runtime.service.read).toHaveBeenCalledTimes(3);
    runtime.controller.destroy();
  });

  it("sends no invalid draft and retains safe authority after failed write", async () => {
    const runtime = harness({ save: vi.fn(async () => { throw Object.assign(new Error("token=secret"), { status: 422, code: "invalid_policy", details: { token: "secret", path: "/private/secret" } }); }) });
    runtime.controller.activate();
    await flush();
    await expect(runtime.controller.save("danbooru", { ...draft, max_concurrency: "999" })).resolves.toBe(false);
    expect(runtime.service.save).not.toHaveBeenCalled();
    await expect(runtime.controller.save("danbooru", draft)).resolves.toBe(false);
    expect(runtime.service.read).toHaveBeenCalledTimes(2);
    expect(runtime.store.getState().snapshot).not.toBeNull();
    expect(JSON.stringify(runtime.store.getState())).not.toContain("secret");
    runtime.controller.destroy();
  });

  it("aborts stale writes on deactivate and confirms dirty site switching", async () => {
    let resolve!: () => void;
    let signal: AbortSignal | null = null;
    const runtime = harness({ save: vi.fn((_: string, __: PolicyDraft, currentSignal: AbortSignal) => { signal = currentSignal; return new Promise<void>((yes) => { resolve = yes; }); }) });
    runtime.controller.activate();
    await flush();
    const before = runtime.store.getState().snapshot;
    const pending = runtime.controller.save("danbooru", draft);
    await Promise.resolve();
    runtime.controller.deactivate();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    resolve();
    await expect(pending).resolves.toBe(false);
    expect(runtime.store.getState().snapshot).toBe(before);
    runtime.controller.activate();
    expect(runtime.controller.requestDiscardSite("pixiv")).toBe(true);
    await expect(runtime.controller.confirmAction(false)).resolves.toBe(false);
    expect(runtime.store.getState().selectedSite).toBe("danbooru");
    expect(runtime.controller.requestDiscardSite("pixiv")).toBe(true);
    await expect(runtime.controller.confirmAction(true)).resolves.toBe(true);
    expect(runtime.store.getState().selectedSite).toBe("pixiv");
    runtime.controller.destroy();
  });
});
