import { describe, expect, it, vi } from "vitest";
import { sanitizePolicyResponse, type PolicyErrorPresentation } from "./model";
import { createPolicyStore } from "./state";

function snapshot() {
  const policy = { max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" };
  const sites = [["danbooru", "Danbooru", "anonymous"], ["twitter", "X / Twitter", "managed_browser"], ["pixiv", "Pixiv", "oauth"], ["exhentai", "EH", "managed_browser_for_private_content"], ["pawchive", "Pawchive", "anonymous"]] as const;
  return sanitizePolicyResponse({ response_profile: "policy", secrets_exposed: false, effect_scope: "new_requests_and_tasks", concurrency_protection: "none", default_source: "startup_snapshot", persistence: "sqlite_atomic", default: { editable: true, reason: "", policy }, items: sites.map(([site, label, authorization]) => ({ site, label, supported: true, authorization, selection_mode: "per_request", availability: "not_probed", inherited: true, has_override: false, editable: true, reason: "", updated_at: null, policy })), unknown_override_count: 0 });
}
const error: PolicyErrorPresentation = { code: "request_failed", status: 503, title: "失败", message: "未完成", nextStep: "重试", detail: "", requestId: "safe", conflict: false };

describe("Policy domain store", () => {
  it("owns one validated snapshot and one operation/confirmation", () => {
    const store = createPolicyStore();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.commitSnapshot(snapshot())).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.beginWrite("save")).toBe(true);
    expect(store.beginWrite("reset")).toBe(false);
    expect(store.getState()).toMatchObject({ busy: "save", phase: "saving" });
  });

  it("keeps the authority snapshot on failure and rejects invalid switches", () => {
    const store = createPolicyStore();
    const authority = snapshot();
    store.commitSnapshot(authority);
    expect(store.selectSite("pixiv")).toBe(true);
    expect(store.selectSite("invalid" as never)).toBe(false);
    expect(store.fail(error)).toBe(true);
    expect(store.getState().snapshot).toBe(authority);
    expect(store.getState().phase).toBe("partial");
    store.destroy();
    expect(store.setMessage("after")).toBe(false);
  });
});
