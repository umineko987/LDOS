import { describe, expect, it } from "vitest";
import {
  POLICY_REQUEST_MAX_BYTES,
  POLICY_SITE_IDS,
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  derivePolicyEditorPresentation,
  derivePolicyWorkspacePresentation,
  isPolicyDirty,
  policyConfigToDraft,
  policyErrorGuidance,
  sanitizePolicyResponse,
  validatePolicyDraft,
  validatePolicySnapshot,
} from "./model";

const secret = "policy-cookie-token-path-secret";
const config = (overrides: Record<string, unknown> = {}) => ({ max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer", ...overrides });
const definitions = [
  ["danbooru", "Danbooru", "anonymous"],
  ["twitter", "X / Twitter", "managed_browser"],
  ["pixiv", "Pixiv", "oauth"],
  ["exhentai", "EH", "managed_browser_for_private_content"],
  ["pawchive", "Pawchive", "anonymous"],
] as const;
function raw(overrides: Record<string, Record<string, unknown>> = {}, corruptSite = "") {
  return {
    response_profile: "policy", secrets_exposed: false, effect_scope: "new_requests_and_tasks", concurrency_protection: "none", default_source: "startup_snapshot", persistence: "sqlite_atomic",
    default: { editable: true, reason: "", policy: config() },
    items: definitions.map(([site, label, authorization]) => ({ site, label, supported: true, authorization, selection_mode: "per_request", availability: "not_probed", inherited: !overrides[site], has_override: Boolean(overrides[site]), editable: true, reason: "", updated_at: overrides[site] ? 1_700_000_000 : null, policy: site === corruptSite ? { ...config(), token: secret } : { ...(overrides[site] ?? config()) } })),
    unknown_override_count: 0,
  };
}

describe("Policy model", () => {
  it("keeps the five sites, strict four-field payload, and safe response projection", () => {
    const snapshot = sanitizePolicyResponse(raw({ pixiv: config({ max_concurrency: 8 }) }, "twitter"));
    expect(POLICY_SITE_IDS).toEqual(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
    expect(snapshot.siteOrder).toEqual(POLICY_SITE_IDS);
    expect(snapshot.sites.twitter).toMatchObject({ editable: false, policy: null });
    expect(validatePolicySnapshot(snapshot)).toBe(snapshot);
    const payload = buildPolicyPayload({ max_concurrency: "12", retry_limit: "3", backoff_base_seconds: "1.25", proxy_mode: "required" });
    expect(payload).toEqual({ max_concurrency: 12, retry_limit: 3, backoff_base_seconds: 1.25, proxy_mode: "required" });
    expect(validatePolicyDraft({ ...payload, token: secret } as never).valid).toBe(false);
    expect(POLICY_REQUEST_MAX_BYTES).toBe(16 * 1024);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("derives dirty/editor/workspace/control states without copying backend rules", () => {
    const snapshot = sanitizePolicyResponse(raw({ pixiv: config({ max_concurrency: 8 }) }));
    const inherited = snapshot.sites.danbooru;
    const custom = snapshot.sites.pixiv;
    const draft = policyConfigToDraft(inherited.policy!);
    expect(isPolicyDirty(inherited.policy, draft)).toBe(false);
    draft.retry_limit = "4";
    expect(isPolicyDirty(inherited.policy, draft)).toBe(true);
    expect(derivePolicyEditorPresentation(inherited).source).toMatch(/默认|继承/);
    expect(derivePolicyEditorPresentation(custom).source).toMatch(/自定义|覆盖/);
    expect(derivePolicyControls(inherited, { dirty: true, valid: true }).save.disabled).toBe(false);
    expect(derivePolicyWorkspacePresentation({ snapshot, item: inherited, dirty: true }).state).toBe("dirty");
    expect(derivePolicyWorkspacePresentation({ snapshot, item: inherited, dirty: true, valid: false }).state).toBe("invalid");
  });

  it("uses stale request gates and safe errors only", () => {
    const gate = createPolicyRequestGate();
    const first = gate.beginRead();
    const second = gate.beginRead();
    expect(gate.isReadCurrent(first)).toBe(false);
    expect(gate.isReadCurrent(second)).toBe(true);
    const write = gate.beginWrite();
    expect(gate.isReadCurrent(second)).toBe(false);
    expect(gate.isWriteCurrent(write)).toBe(true);
    gate.advanceLifecycle();
    expect(gate.isWriteCurrent(write)).toBe(false);
    const error = policyErrorGuidance(Object.assign(new Error(secret), { code: "invalid_policy", status: 422, requestId: "safe", details: { field: "retry_limit", reason: "less_than_equal", body: `https://private.invalid/${secret}`, path: `/private/${secret}` } }));
    expect(error).toMatchObject({ code: "invalid_policy", status: 422, requestId: "safe" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("private.invalid");
  });
});
