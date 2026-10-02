import { describe, expect, it, vi } from "vitest";

import { createPollingService, POLLING_SCOPE_STATES } from "../polling/service";
import { createShellPollingLifecycleSource } from "./projections";
import { createShellStore } from "./shell";

describe("shell polling lifecycle projection", () => {
  it("projects unvisited, background, and current application states", () => {
    const shell = createShellStore();
    const source = createShellPollingLifecycleSource(shell);
    expect(source.getFocusedScope()).toBeNull();
    expect(source.getScopeState("global")).toBe(POLLING_SCOPE_STATES.UNMANAGED);
    expect(source.getScopeState("app:unknown")).toBe(POLLING_SCOPE_STATES.UNMANAGED);
    expect(source.getScopeState("app:tasks")).toBe(POLLING_SCOPE_STATES.CLOSED);

    shell.openApplication("tasks");
    expect(source.getFocusedScope()).toBe("app:tasks");
    expect(source.getScopeState("app:tasks")).toBe(POLLING_SCOPE_STATES.OPEN);
    shell.openApplication("vault");
    expect(source.getFocusedScope()).toBe("app:vault");
    expect(source.getScopeState("app:tasks")).toBe(POLLING_SCOPE_STATES.MINIMIZED);
    expect(source.getScopeState("app:vault")).toBe(POLLING_SCOPE_STATES.OPEN);
    expect(source.getScopeState("app:crawl")).toBe(POLLING_SCOPE_STATES.CLOSED);
    shell.openApplication("tasks");
    expect(source.getScopeState("app:tasks")).toBe(POLLING_SCOPE_STATES.OPEN);
    expect(source.getScopeState("app:vault")).toBe(POLLING_SCOPE_STATES.MINIMIZED);
  });

  it("notifies only on navigation and stops after unsubscribe or shell destruction", () => {
    const shell = createShellStore();
    const source = createShellPollingLifecycleSource(shell);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
    shell.openApplication("tasks");
    shell.openApplication("tasks");
    shell.registerUnsavedChanges("tasks", () => true);
    shell.hasUnsavedChanges();
    expect(listener).toHaveBeenCalledOnce();
    shell.openApplication("vault");
    shell.openApplication("tasks");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    shell.openApplication("crawl");
    expect(listener).toHaveBeenCalledTimes(3);
    const remainingListener = vi.fn();
    source.subscribe(remainingListener);
    shell.destroy();
    shell.openApplication("review");
    expect(remainingListener).not.toHaveBeenCalled();
  });

  it("pauses background app polling without interrupting existing global critical polling", async () => {
    vi.useFakeTimers();
    const shell = createShellStore();
    const polling = createPollingService({ lifecycleSource: createShellPollingLifecycleSource(shell) });
    try {
      const appTask = vi.fn(async () => null);
      const criticalTask = vi.fn(async () => null);
      polling.start({
        key: "tasks.authority", scope: "app:tasks", intervalMs: 1_000,
        immediate: false, critical: false, task: appTask, onResult() {},
      });
      polling.start({
        key: "platform.backend-status", intervalMs: 500,
        immediate: false, critical: true, task: criticalTask, onResult() {},
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(appTask).not.toHaveBeenCalled();
      expect(criticalTask).toHaveBeenCalledOnce();
      shell.openApplication("tasks");
      await vi.advanceTimersByTimeAsync(0);
      expect(appTask).toHaveBeenCalledOnce();
      shell.openApplication("vault");
      expect(polling.getSummary().find(({ key }) => key === "tasks.authority")?.state).toBe("paused");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appTask).toHaveBeenCalledOnce();
      expect(criticalTask).toHaveBeenCalledTimes(3);
      shell.openApplication("tasks");
      await vi.advanceTimersByTimeAsync(0);
      expect(appTask).toHaveBeenCalledTimes(2);
    } finally {
      polling.destroy();
      shell.destroy();
      vi.useRealTimers();
    }
  });
});
