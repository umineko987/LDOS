import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../core/api/client";
import { DIAGNOSTICS_ENDPOINTS, createDiagnosticsService } from "./service";

function api(responses: unknown[] = []) {
  return {
    get: vi.fn(async () => responses.shift()),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn> };
}

describe("Diagnostics API service", () => {
  it("reads all four exact endpoints concurrently through the shared client", async () => {
    const client = api([{ ok: true }, { ready: true }, { response_profile: "diagnostics", secrets_exposed: false }, { response_profile: "diagnostics", secrets_exposed: false }]);
    const signal = new AbortController().signal;
    const result = await createDiagnosticsService(client).readAll(signal);
    expect(client.get.mock.calls).toEqual([
      [DIAGNOSTICS_ENDPOINTS.health, { signal }],
      [DIAGNOSTICS_ENDPOINTS.readiness, { signal }],
      [DIAGNOSTICS_ENDPOINTS.config, { signal }],
      [DIAGNOSTICS_ENDPOINTS.scheduler, { signal }],
    ]);
    expect(result.health.data).toEqual({ ok: true });
    expect(result.readiness.data).toEqual({ ready: true });
  });

  it("keeps safe error metadata and rethrows aborts", async () => {
    const client = api();
    client.get.mockRejectedValueOnce(Object.assign(new Error("secret body"), { status: 503, code: "http_error", requestId: "safe-id", details: { secret: "never" } }));
    const result = await createDiagnosticsService(client).readAll(new AbortController().signal);
    expect(result.health).toMatchObject({ connected: true, data: null, error: { status: 503, code: "http_error", requestId: "safe-id" } });
    expect(JSON.stringify(result)).not.toContain("secret body");

    const abort = new DOMException("aborted", "AbortError");
    client.get.mockRejectedValueOnce(abort);
    await expect(createDiagnosticsService(client).readAll(new AbortController().signal)).rejects.toBe(abort);
  });
});
