import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsStore } from "./state";
import { buildDiagnosticsSnapshot } from "./model";

function snapshot() {
  return buildDiagnosticsSnapshot({
    health: { connected: true, data: { ok: true }, error: null },
    readiness: { connected: true, data: { ready: true, components: {} }, error: null },
    config: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
    scheduler: { connected: true, data: { response_profile: "diagnostics", secrets_exposed: false }, error: null },
    checkedAt: 1_700_000_000_000,
  });
}

describe("Diagnostics domain store", () => {
  it("owns one sanitized snapshot commit and blocks overlapping refresh", () => {
    const store = createDiagnosticsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.beginRefresh()).toBe(true);
    expect(store.beginRefresh()).toBe(false);
    expect(store.commit(snapshot())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState().snapshot?.complete).toBe(true);
  });

  it("retains the snapshot on safe failure and stops notifying after destroy", () => {
    const store = createDiagnosticsStore();
    store.commit(snapshot());
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.fail({ title: "失败", message: "未完成", nextStep: "重试" }, "保留")).toBe(true);
    expect(store.getState().snapshot?.complete).toBe(true);
    store.destroy();
    expect(store.setMessage("after")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
