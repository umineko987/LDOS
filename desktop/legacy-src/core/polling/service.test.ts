import { describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_POLL_MULTIPLIER,
  POLLING_SCOPE_STATES,
  createPollingService,
  type PollingLifecycleSource,
  type PollingVisibilitySource,
  type VisibilityState,
} from "./service";

class ManualTimers {
  private nextId = 1;
  readonly entries = new Map<number, { callback: () => void; delay: number }>();
  readonly cleared: number[] = [];

  readonly setTimeout = (callback: () => void, delay: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.entries.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };

  readonly clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>): void => {
    const id = handle as unknown as number;
    this.cleared.push(id);
    this.entries.delete(id);
  };

  delays(): number[] {
    return [...this.entries.values()].map(({ delay }) => delay);
  }

  runNext(): void {
    const next = this.entries.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
    if (!next) throw new Error("no_timer");
    this.entries.delete(next[0]);
    next[1].callback();
  }
}

class MutableVisibility implements PollingVisibilitySource {
  state: VisibilityState = "visible";
  readonly listeners = new Set<() => void>();

  getState(): VisibilityState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(state: VisibilityState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class MutableLifecycle implements PollingLifecycleSource {
  focused: string | null = "app:tasks";
  readonly states = new Map<string, (typeof POLLING_SCOPE_STATES)[keyof typeof POLLING_SCOPE_STATES]>([
    ["app:tasks", POLLING_SCOPE_STATES.OPEN],
    ["app:crawl", POLLING_SCOPE_STATES.OPEN],
    ["app:vault", POLLING_SCOPE_STATES.OPEN],
  ]);
  readonly listeners = new Set<() => void>();

  getFocusedScope(): string | null {
    return this.focused;
  }

  getScopeState(scope: string) {
    return this.states.get(scope) ?? POLLING_SCOPE_STATES.CLOSED;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function runtime() {
  const timers = new ManualTimers();
  const visibility = new MutableVisibility();
  const lifecycle = new MutableLifecycle();
  const service = createPollingService({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    visibilitySource: visibility,
    lifecycleSource: lifecycle,
  });
  return { timers, visibility, lifecycle, service };
}

describe("the one frontend polling service", () => {
  it("keeps each key single-flight and schedules the next run only after completion", async () => {
    const { timers, service } = runtime();
    const request = deferred<string>();
    const task = vi.fn(() => request.promise);
    const onResult = vi.fn();
    const handle = service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task,
      onResult,
    });

    expect(timers.delays()).toEqual([1_500]);
    const first = handle.trigger();
    const duplicate = service.trigger("tasks.active");
    expect(duplicate).toBe(first);
    await flush();
    expect(task).toHaveBeenCalledOnce();
    expect(service.getSummary()).toEqual([{
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      effectiveIntervalMs: 1_500,
      state: "running",
      runCount: 1,
    }]);

    request.resolve("snapshot");
    await expect(first).resolves.toBe(true);
    expect(onResult).toHaveBeenCalledWith("snapshot");
    expect(timers.delays()).toEqual([1_500]);
    timers.runNext();
    await flush();
    expect(task).toHaveBeenCalledTimes(2);
    service.destroy();
  });

  it("aborts and isolates stale results when a registration stops or is replaced", async () => {
    const { service } = runtime();
    const oldRequest = deferred<string>();
    let oldSignal: AbortSignal | null = null;
    const oldResult = vi.fn();
    const oldHandle = service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task: (signal) => {
        oldSignal = signal;
        return oldRequest.promise;
      },
      onResult: oldResult,
    });
    const oldRun = oldHandle.trigger();
    await flush();
    expect((oldSignal as AbortSignal | null)?.aborted).toBe(false);
    expect(oldHandle.stop()).toBe(true);
    expect((oldSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(oldHandle.stop()).toBe(false);
    expect(service.stop("missing.key")).toBe(false);
    await expect(service.trigger("missing.key")).resolves.toBe(false);

    const newResult = vi.fn();
    const replacement = service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task: async () => "new",
      onResult: newResult,
    });
    oldRequest.resolve("stale");
    await expect(oldRun).resolves.toBe(false);
    expect(oldResult).not.toHaveBeenCalled();
    await expect(replacement.trigger()).resolves.toBe(true);
    expect(newResult).toHaveBeenCalledWith("new");
    service.destroy();
    service.destroy();
    expect(replacement.stop()).toBe(false);
    await expect(replacement.trigger()).resolves.toBe(false);
    expect(() => service.start({
      key: "after.destroy",
      intervalMs: 1_000,
      critical: true,
      task: async () => null,
      onResult() {},
    })).toThrow("polling_service_destroyed");
  });

  it("pauses hidden non-critical and closed/minimized app scopes, slows background scopes by four, and resumes immediately", async () => {
    const { timers, visibility, lifecycle, service } = runtime();
    const task = vi.fn(async () => "ok");
    const tasks = service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task,
      onResult() {},
    });
    expect(BACKGROUND_POLL_MULTIPLIER).toBe(4);
    expect(timers.delays()).toEqual([1_500]);

    lifecycle.focused = "app:crawl";
    lifecycle.emit();
    expect(timers.delays()).toEqual([6_000]);
    expect(service.getSummary()[0].effectiveIntervalMs).toBe(6_000);
    lifecycle.focused = "app:tasks";
    lifecycle.emit();
    expect(timers.delays()).toEqual([0]);

    timers.runNext();
    await flush();
    expect(task).toHaveBeenCalledOnce();
    visibility.set("hidden");
    expect(service.getSummary()[0].state).toBe("paused");
    expect(timers.entries.size).toBe(0);
    await expect(tasks.trigger()).resolves.toBe(false);
    visibility.set("visible");
    expect(timers.delays()).toEqual([0]);

    lifecycle.states.set("app:tasks", POLLING_SCOPE_STATES.MINIMIZED);
    lifecycle.emit();
    expect(service.getSummary()[0].state).toBe("paused");
    lifecycle.states.set("app:tasks", POLLING_SCOPE_STATES.CLOSED);
    lifecycle.emit();
    expect(service.getSummary()[0].state).toBe("paused");
    lifecycle.states.set("app:tasks", POLLING_SCOPE_STATES.OPEN);
    lifecycle.emit();
    expect(timers.delays()).toEqual([0]);

    const critical = service.start({
      key: "platform.status",
      intervalMs: 500,
      immediate: false,
      critical: true,
      task: async () => "ready",
      onResult() {},
    });
    visibility.set("hidden");
    const hidden = service.start({
      key: "hidden.start",
      intervalMs: 1_000,
      critical: false,
      task: async () => null,
      onResult() {},
    });
    expect(service.getSummary().find(({ key }) => key === "hidden.start")?.state).toBe("paused");
    expect(hidden.stop()).toBe(true);
    expect(service.getSummary().find(({ key }) => key === "platform.status")?.effectiveIntervalMs).toBe(500);
    await expect(critical.trigger()).resolves.toBe(true);
    expect(service.stopScope("app:tasks")).toBe(1);
    expect(service.stopScope("app:tasks")).toBe(0);
    expect(service.stopScope("global")).toBe(1);
    expect(() => service.stopScope("bad scope")).toThrow("invalid_polling_scope");
    service.destroy();
  });

  it("keeps an always-focus-rate app at its declared interval when unfocused", () => {
    const { timers, lifecycle, service } = runtime();
    const handle = service.start({
      key: "vault.authorization",
      scope: "app:vault",
      intervalMs: 800,
      immediate: false,
      critical: false,
      alwaysFocusRate: true,
      task: async () => "ok",
      onResult() {},
    });
    lifecycle.focused = "app:tasks";
    lifecycle.emit();
    expect(service.getSummary()).toEqual([expect.objectContaining({
      key: "vault.authorization",
      effectiveIntervalMs: 800,
    })]);
    expect(timers.delays()).toEqual([800]);
    expect(handle.stop()).toBe(true);
    service.destroy();
  });

  it("aborts an in-flight request on suspension and performs exactly one immediate recovery run", async () => {
    const { timers, visibility, lifecycle, service } = runtime();
    const request = deferred<string>();
    let signal: AbortSignal | null = null;
    const result = vi.fn();
    const handle = service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task: (currentSignal) => {
        signal = currentSignal;
        return request.promise;
      },
      onResult: result,
    });
    const running = handle.trigger();
    await flush();
    visibility.set("hidden");
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    visibility.set("visible");
    expect(timers.entries.size).toBe(0);
    request.resolve("stale");
    await expect(running).resolves.toBe(false);
    expect(result).not.toHaveBeenCalled();
    expect(timers.delays()).toEqual([0]);
    expect(handle.stop()).toBe(true);
    const faster = deferred<string>();
    lifecycle.focused = "app:tasks";
    const background = service.start({
      key: "crawl.active",
      scope: "app:crawl",
      intervalMs: 1_000,
      immediate: false,
      critical: false,
      task: async () => faster.promise,
      onResult() {},
    });
    expect(service.getSummary()[0].effectiveIntervalMs).toBe(4_000);
    const backgroundRun = background.trigger();
    await flush();
    lifecycle.focused = "app:crawl";
    lifecycle.emit();
    faster.resolve("fresh");
    await expect(backgroundRun).resolves.toBe(true);
    expect(timers.delays()).toEqual([0]);
    service.destroy();
  });

  it("reports only current non-abort failures and contains callback failures", async () => {
    const { visibility, service } = runtime();
    const errors: unknown[] = [];
    const failure = new Error("failed");
    const failed = service.start({
      key: "failure.one",
      intervalMs: 1_000,
      immediate: false,
      critical: true,
      task: async () => { throw failure; },
      onResult() {},
      onError: (error) => errors.push(error),
    });
    await expect(failed.trigger()).resolves.toBe(false);
    expect(errors).toEqual([failure]);

    const abortFailure = service.start({
      key: "failure.abort",
      intervalMs: 1_000,
      immediate: false,
      critical: true,
      task: async () => { throw new DOMException("stopped", "AbortError"); },
      onResult() {},
      onError: (error) => errors.push(error),
    });
    await expect(abortFailure.trigger()).resolves.toBe(false);
    expect(errors).toEqual([failure]);

    const callbackFailure = service.start({
      key: "failure.commit",
      intervalMs: 1_000,
      immediate: false,
      critical: true,
      task: async () => "result",
      onResult: () => { throw new Error("commit failed"); },
      onError: () => { throw new Error("diagnostic failed"); },
    });
    await expect(callbackFailure.trigger()).resolves.toBe(false);

    const defaultFailure = service.start({
      key: "failure.default-handler",
      intervalMs: 1_000,
      immediate: false,
      critical: true,
      task: async () => { throw new Error("ignored"); },
      onResult() {},
    });
    await expect(defaultFailure.trigger()).resolves.toBe(false);

    const late = deferred<string>();
    const lateResult = vi.fn();
    const lateHandle = service.start({
      key: "finish.hidden",
      intervalMs: 1_000,
      immediate: false,
      critical: false,
      task: async () => late.promise,
      onResult: lateResult,
    });
    const lateRun = lateHandle.trigger();
    await flush();
    visibility.state = "hidden";
    late.resolve("late");
    await expect(lateRun).resolves.toBe(true);
    expect(lateResult).toHaveBeenCalledWith("late");
    expect(service.getSummary().find(({ key }) => key === "finish.hidden")?.state).toBe("paused");
    service.destroy();
  });

  it("returns one handle for duplicate keys and validates every public registration boundary", () => {
    const { service } = runtime();
    const options = {
      key: "same.key",
      intervalMs: 1_000,
      immediate: false,
      critical: true,
      task: async () => true,
      onResult() {},
    };
    const first = service.start(options);
    expect(service.start({ ...options, intervalMs: 9_000 })).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => service.start({ ...options, key: "Bad" })).toThrow("invalid_polling_key");
    expect(() => service.start({ ...options, key: "other.key", scope: "bad scope" })).toThrow("invalid_polling_scope");
    expect(() => service.start({ ...options, key: "other.key", intervalMs: 99 })).toThrow("invalid_polling_interval");
    expect(() => service.start({ ...options, key: "other.key", intervalMs: Number.NaN })).toThrow("invalid_polling_interval");
    expect(() => service.start({ ...options, key: "other.key", critical: null as never })).toThrow("invalid_polling_registration");
    expect(() => service.start({ ...options, key: "other.key", task: null as never })).toThrow("invalid_polling_registration");
    expect(() => service.start({ ...options, key: "other.key", onResult: null as never })).toThrow("invalid_polling_registration");
    expect(() => service.start({ ...options, key: "other.key", onError: null as never })).toThrow("invalid_polling_registration");
    service.destroy();

    expect(() => createPollingService({ setTimeoutFn: null as never })).toThrow("invalid_polling_timers");
    expect(() => createPollingService({ clearTimeoutFn: null as never })).toThrow("invalid_polling_timers");
    expect(() => createPollingService({ visibilitySource: null as never })).toThrow("invalid_visibility_source");
    expect(() => createPollingService({
      visibilitySource: { getState: () => "visible" } as never,
    })).toThrow("invalid_visibility_source");
    expect(() => createPollingService({ lifecycleSource: {} as never })).toThrow("invalid_lifecycle_source");
  });

  it("treats invalid or throwing lifecycle projections as unmanaged", () => {
    const timers = new ManualTimers();
    const visibility = new MutableVisibility();
    const listeners = new Set<() => void>();
    let mode: "invalid" | "invalid-focus" | "null-focus" | "throw-state" | "throw-focus" = "invalid";
    const lifecycle: PollingLifecycleSource = {
      getFocusedScope() {
        if (mode === "throw-focus") throw new Error("focus unavailable");
        return mode === "null-focus" ? null : "invalid scope";
      },
      getScopeState() {
        if (mode === "throw-state") throw new Error("state unavailable");
        return ["invalid-focus", "null-focus", "throw-focus"].includes(mode)
          ? POLLING_SCOPE_STATES.OPEN
          : "invalid" as never;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const service = createPollingService({
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      visibilitySource: visibility,
      lifecycleSource: lifecycle,
    });
    service.start({
      key: "tasks.active",
      scope: "app:tasks",
      intervalMs: 1_500,
      immediate: false,
      critical: false,
      task: async () => null,
      onResult() {},
    });
    expect(timers.delays()).toEqual([1_500]);
    mode = "throw-state";
    for (const listener of listeners) listener();
    mode = "null-focus";
    for (const listener of listeners) listener();
    expect(timers.delays()).toEqual([6_000]);
    mode = "invalid-focus";
    for (const listener of listeners) listener();
    expect(timers.delays()).toEqual([6_000]);
    mode = "throw-focus";
    for (const listener of listeners) listener();
    expect(timers.delays()).toEqual([6_000]);
    const staleListener = [...listeners][0];
    service.destroy();
    staleListener();
    expect(listeners.size).toBe(0);
  });

  it("uses document visibility by default and removes its listener on destroy", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const source = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" };
    source.visibilityState = "visible";
    const add = vi.spyOn(source, "addEventListener");
    const remove = vi.spyOn(source, "removeEventListener");
    Object.defineProperty(globalThis, "document", { configurable: true, value: source });
    try {
      const service = createPollingService();
      service.start({
        key: "default.visibility",
        intervalMs: 1_000,
        critical: false,
        task: async () => null,
        onResult() {},
      });
      expect(add).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      source.visibilityState = "hidden";
      source.dispatchEvent(new Event("visibilitychange"));
      expect(service.getSummary()[0].state).toBe("paused");
      service.destroy();
      expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else delete (globalThis as Record<string, unknown>).document;
    }

    const withoutDocument = createPollingService();
    withoutDocument.destroy();
  });
});
