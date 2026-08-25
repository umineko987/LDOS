import { describe, expect, it } from "vitest";
import { buildDiagnosticsSnapshot } from "../src/apps/diagnostics/model";
import diagnosticsSource from "../src/apps/diagnostics/Diagnostics.svelte?raw";
import diagnosticsControllerSource from "../src/apps/diagnostics/controller.ts?raw";
import diagnosticsServiceSource from "../src/apps/diagnostics/service.ts?raw";
import policySource from "../src/apps/policy/Policy.svelte?raw";
import policyControllerSource from "../src/apps/policy/controller.ts?raw";
import policyServiceSource from "../src/apps/policy/service.ts?raw";
import { createPolicyStore } from "../src/apps/policy/state";
import { sanitizePolicyResponse } from "../src/apps/policy/model";

const secret = "p4-policy-diagnostics-cookie-token-secret";
function policyResponse() {
  const policy = { max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" };
  const sites = [["danbooru", "Danbooru", "anonymous"], ["twitter", "X / Twitter", "managed_browser"], ["pixiv", "Pixiv", "oauth"], ["exhentai", "EH", "managed_browser_for_private_content"], ["pawchive", "Pawchive", "anonymous"]] as const;
  return sanitizePolicyResponse({ response_profile: "policy", secrets_exposed: false, effect_scope: "new_requests_and_tasks", concurrency_protection: "none", default_source: "startup_snapshot", persistence: "sqlite_atomic", default: { editable: true, reason: "", policy }, items: sites.map(([site, label, authorization]) => ({ site, label, supported: true, authorization, selection_mode: "per_request", availability: "not_probed", inherited: true, has_override: false, editable: true, reason: "", updated_at: null, policy })), unknown_override_count: 0 });
}

describe("P4 Policy + Diagnostics target contracts", () => {
  it("keeps Policy keyed site ownership and the one write/read authority path", () => {
    const store = createPolicyStore();
    const snapshot = policyResponse();
    store.commitSnapshot(snapshot);
    const before = store.getState();
    store.selectSite("pixiv");
    expect(store.getState().snapshot).toBe(before.snapshot);
    expect(policySource).toContain("{#each items as entry (entry.definition.id)}");
    expect(policySource).toContain("registerUnsavedChanges");
    expect(policyControllerSource).toContain("const snapshot = await service.read(controller.signal)");
    expect(policyControllerSource).not.toContain("polling.start");
    expect(policyServiceSource).toContain('policies: "/api/v1/sites/policies"');
    expect(policyServiceSource).toContain("view=policy");
  });

  it("keeps Diagnostics four-section merge, keyed component projection, and poll lifecycle", () => {
    const previous = buildDiagnosticsSnapshot({
      health: { connected: true, data: { ok: true }, error: null },
      readiness: { connected: true, data: { ready: true, components: {} }, error: null },
      config: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
      scheduler: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
    });
    const current = buildDiagnosticsSnapshot({
      health: { connected: true, data: { ok: false }, error: null },
      readiness: { connected: false, data: null, error: { status: 503, code: "request_failed", requestId: "safe" } },
      config: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
      scheduler: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
      previous,
    });
    expect(current.readiness).toBe(previous.readiness);
    expect(current.staleSections).toEqual(["readiness"]);
    expect(diagnosticsSource).toContain("{#each snapshot.snapshot.readiness.components as component (component.id)}");
    expect(diagnosticsControllerSource).toContain('DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"');
    expect(diagnosticsControllerSource).toContain("intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS");
    expect(diagnosticsControllerSource).toContain("polling.stopScope(DIAGNOSTICS_SCOPE)");
    expect(diagnosticsServiceSource).toContain("Promise.all([");
    expect(JSON.stringify({ current, secret })).toContain(secret);
    expect(JSON.stringify(current)).not.toContain(secret);
  });

  it("keeps all domain sources behind shared boundaries", () => {
    const combined = [policySource, policyControllerSource, policyServiceSource, diagnosticsSource, diagnosticsControllerSource, diagnosticsServiceSource].join("\n");
    for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /\b(?:localStorage|sessionStorage|indexedDB)\b/, /\bsetInterval\s*\(/, /innerHTML/, /console\./]) expect(combined).not.toMatch(forbidden);
  });
});
