import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../core/api/client";
import { POLICY_ENDPOINTS, createPolicyService } from "./service";

function raw(overrides: Record<string, unknown> = {}) {
  const sites = [
    ["danbooru", "Danbooru", "anonymous"], ["twitter", "X / Twitter", "managed_browser"], ["pixiv", "Pixiv", "oauth"], ["exhentai", "EH", "managed_browser_for_private_content"], ["pawchive", "Pawchive", "anonymous"],
  ] as const;
  const policy = { max_concurrency: 20, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" };
  return { response_profile: "policy", secrets_exposed: false, effect_scope: "new_requests_and_tasks", concurrency_protection: "none", default_source: "startup_snapshot", persistence: "sqlite_atomic", default: { editable: true, reason: "", policy }, items: sites.map(([site, label, authorization]) => ({ site, label, supported: true, authorization, selection_mode: "per_request", availability: "not_probed", inherited: true, has_override: false, editable: true, reason: "", updated_at: null, policy })), unknown_override_count: 0, ...overrides };
}
function api(responses: unknown[] = []) {
  return { get: vi.fn(async () => responses.shift()), put: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } as unknown as ApiClient & Record<"get" | "put" | "delete", ReturnType<typeof vi.fn>>;
}

describe("Policy API service", () => {
  it("uses the exact view query and sanitizes the read response", async () => {
    const client = api([raw()]);
    const signal = new AbortController().signal;
    const result = await createPolicyService(client).read(signal);
    expect(client.get).toHaveBeenCalledWith(`${POLICY_ENDPOINTS.policies}?view=policy`, { signal });
    expect(result.siteOrder).toEqual(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
  });

  it("uses exact PUT/DELETE paths and complete numeric payloads", async () => {
    const client = api();
    const service = createPolicyService(client);
    const signal = new AbortController().signal;
    await service.save("danbooru", { max_concurrency: "9", retry_limit: "4", backoff_base_seconds: "1.25", proxy_mode: "required" }, signal);
    await service.reset("danbooru", signal);
    expect(client.put).toHaveBeenCalledWith(`${POLICY_ENDPOINTS.policies}/danbooru?view=policy`, { max_concurrency: 9, retry_limit: 4, backoff_base_seconds: 1.25, proxy_mode: "required" }, { signal });
    expect(client.delete).toHaveBeenCalledWith(`${POLICY_ENDPOINTS.policies}/danbooru?view=policy`, { signal });
    await expect(service.save("invalid" as never, { max_concurrency: "1", retry_limit: "0", backoff_base_seconds: "0", proxy_mode: "direct" }, signal)).rejects.toThrow("invalid_policy_site");
  });
});
