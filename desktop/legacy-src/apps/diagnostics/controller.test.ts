import { describe, expect, it, vi } from "vitest";
import type { PollingService } from "../../core/polling/service";
import type { DiagnosticsOutcome } from "./model";
import { createDiagnosticsController } from "./controller";
import type { DiagnosticsReadout } from "./service";
import { createDiagnosticsStore } from "./state";

function outcome(data: unknown): DiagnosticsOutcome { return { connected: true, data, error: null }; }
function readout(): DiagnosticsReadout {
  return {
    health: outcome({ ok: true }),
    readiness: outcome({ ready: true, components: {} }),
    config: outcome({ response_profile: "diagnostics", secrets_exposed: false }),
    scheduler: outcome({ response_profile: "diagnostics", secrets_exposed: false }),
  };
}
function pollingHarness() {
  let registration: { task: (signal: AbortSignal) => Promise<boolean>; onResult: (result: boolean) => void; stop: () => boolean } | null = null;
  const run = async (): Promise<boolean> => {
    const current = registration;
    if (!current) return false;
    const result = await current.task(new AbortController().signal);
    current.onResult(result);
    return true;
  };
  const polling = {
    start: vi.fn((value: { task: (signal: AbortSignal) => Promise<boolean>; onResult: (result: boolean) => void }) => {
      registration = { ...value, stop: vi.fn(() => { registration = null; return true; }) };
      return registration;
    }),
    stop: vi.fn(() => { registration = null; return true; }),
    stopScope: vi.fn(() => 0),
    trigger: vi.fn(() => run()),
    getRegistration: () => registration,
  } as unknown as PollingService & { getRegistration: () => typeof registration };
  return polling;
}

describe("Diagnostics controller", () => {
  it("starts the single 20-second app poll and commits one sanitized cycle", async () => {
    const store = createDiagnosticsStore();
    const polling = pollingHarness();
    const service = { readAll: vi.fn(async () => readout()) };
    const controller = createDiagnosticsController({ store, service, polling });
    controller.activate();
    expect(polling.start).toHaveBeenCalledWith(expect.objectContaining({ key: "diagnostics.snapshot", scope: "app:diagnostics", intervalMs: 20_000, immediate: true, critical: false }));
    await controller.refresh();
    expect(store.getState().snapshot?.complete).toBe(true);
    expect(JSON.stringify(store.getState())).not.toContain("response_profile");
    controller.destroy();
    expect(polling.stopScope).toHaveBeenCalledWith("app:diagnostics");
  });

  it("rejects tampered recovery targets and aborts stale work on destroy", async () => {
    const store = createDiagnosticsStore();
    const polling = pollingHarness();
    let resolve!: (value: DiagnosticsReadout) => void;
    const service = { readAll: vi.fn(() => new Promise<DiagnosticsReadout>((yes) => { resolve = yes; })) };
    const navigate = vi.fn();
    const controller = createDiagnosticsController({ store, service, polling, onNavigate: navigate });
    controller.activate();
    const pending = controller.refresh();
    expect(controller.navigate("proxy")).toBe(true);
    expect(controller.navigate("tasks")).toBe(true);
    for (const target of ["vault", "../proxy", "", "SECRET"]) expect(controller.navigate(target)).toBe(false);
    await Promise.resolve();
    controller.destroy();
    resolve(readout());
    await expect(pending).resolves.toBe(true);
    expect(store.getState().snapshot).toBeNull();
    expect(navigate.mock.calls.map(([target]) => target)).toEqual(["proxy", "tasks"]);
  });
});
