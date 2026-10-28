export const POLLING_SCOPE_STATES = Object.freeze({
  OPEN: "open",
  MINIMIZED: "minimized",
  CLOSED: "closed",
  UNMANAGED: "unmanaged",
} as const);

export const BACKGROUND_POLL_MULTIPLIER = 4;

export type PollingScopeState = typeof POLLING_SCOPE_STATES[keyof typeof POLLING_SCOPE_STATES];
export type VisibilityState = "visible" | "hidden";

export interface PollingVisibilitySource {
  getState(): VisibilityState;
  subscribe(listener: () => void): () => void;
}

export interface PollingLifecycleSource {
  getFocusedScope(): string | null;
  getScopeState(scope: string): PollingScopeState;
  subscribe(listener: () => void): () => void;
}

export interface PollingHandle {
  readonly key: string;
  readonly scope: string;
  trigger(): Promise<boolean>;
  stop(): boolean;
}

export interface PollingRegistration<T> {
  readonly key: string;
  readonly scope?: string;
  readonly intervalMs: number;
  readonly immediate?: boolean;
  readonly critical: boolean;
  readonly alwaysFocusRate?: boolean;
  readonly task: (signal: AbortSignal) => Promise<T>;
  readonly onResult: (result: T) => void;
  readonly onError?: (error: unknown) => void;
}

export interface PollingSummary {
  readonly key: string;
  readonly scope: string;
  readonly intervalMs: number;
  readonly effectiveIntervalMs: number | null;
  readonly state: "paused" | "running" | "scheduled";
  readonly runCount: number;
}

export interface PollingService {
  start<T>(registration: PollingRegistration<T>): PollingHandle;
  trigger(key: string): Promise<boolean>;
  stop(key: string): boolean;
  stopScope(scope: string): number;
  getSummary(): readonly PollingSummary[];
  destroy(): void;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type SetTimeout = (callback: () => void, delay: number) => TimerHandle;
type ClearTimeout = (handle: TimerHandle) => void;

interface Entry {
  readonly key: string;
  readonly scope: string;
  readonly intervalMs: number;
  readonly critical: boolean;
  readonly alwaysFocusRate: boolean;
  readonly task: (signal: AbortSignal) => Promise<unknown>;
  readonly onResult: (result: unknown) => void;
  readonly onError: (error: unknown) => void;
  readonly handle: PollingHandle;
  effectiveIntervalMs: number | null;
  timer: TimerHandle | null;
  controller: AbortController | null;
  activePromise: Promise<boolean> | null;
  resumePending: boolean;
  stopped: boolean;
  runCount: number;
}

const RESOURCE_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const APP_SCOPE_PREFIX = "app:";

function requireResource(value: unknown, label: string): string {
  if (typeof value !== "string" || !RESOURCE_PATTERN.test(value)) throw new TypeError(`invalid_${label}`);
  return value;
}

function defaultVisibilitySource(): PollingVisibilitySource {
  return Object.freeze({
    getState: () => globalThis.document?.visibilityState === "hidden" ? "hidden" : "visible",
    subscribe(listener: () => void) {
      const source = globalThis.document;
      if (!source) return () => {};
      source.addEventListener("visibilitychange", listener);
      return () => source.removeEventListener("visibilitychange", listener);
    },
  });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createPollingService({
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  visibilitySource = defaultVisibilitySource(),
  lifecycleSource = null,
}: {
  readonly setTimeoutFn?: SetTimeout;
  readonly clearTimeoutFn?: ClearTimeout;
  readonly visibilitySource?: PollingVisibilitySource;
  readonly lifecycleSource?: PollingLifecycleSource | null;
} = {}): PollingService {
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("invalid_polling_timers");
  }
  if (typeof visibilitySource?.getState !== "function" || typeof visibilitySource?.subscribe !== "function") {
    throw new TypeError("invalid_visibility_source");
  }
  if (lifecycleSource !== null && (
    typeof lifecycleSource.getFocusedScope !== "function"
    || typeof lifecycleSource.getScopeState !== "function"
    || typeof lifecycleSource.subscribe !== "function"
  )) {
    throw new TypeError("invalid_lifecycle_source");
  }

  const entries = new Map<string, Entry>();
  let destroyed = false;

  const focusedScope = (): string | null => {
    try {
      const scope = lifecycleSource!.getFocusedScope();
      return scope === null ? null : RESOURCE_PATTERN.test(scope) ? scope : null;
    } catch {
      return null;
    }
  };

  const scopeState = (scope: string): PollingScopeState => {
    if (!lifecycleSource || !scope.startsWith(APP_SCOPE_PREFIX)) return POLLING_SCOPE_STATES.UNMANAGED;
    try {
      const state = lifecycleSource.getScopeState(scope);
      return Object.values(POLLING_SCOPE_STATES).includes(state)
        ? state
        : POLLING_SCOPE_STATES.UNMANAGED;
    } catch {
      return POLLING_SCOPE_STATES.UNMANAGED;
    }
  };

  const effectiveInterval = (entry: Entry): number | null => {
    const state = scopeState(entry.scope);
    if (state === POLLING_SCOPE_STATES.MINIMIZED || state === POLLING_SCOPE_STATES.CLOSED) return null;
    if (!entry.critical && visibilitySource.getState() === "hidden") return null;
    if (state === POLLING_SCOPE_STATES.OPEN && !entry.alwaysFocusRate && focusedScope() !== entry.scope) {
      return entry.intervalMs * BACKGROUND_POLL_MULTIPLIER;
    }
    return entry.intervalMs;
  };

  const clearTimer = (entry: Entry): void => {
    if (entry.timer === null) return;
    clearTimeoutFn(entry.timer);
    entry.timer = null;
  };

  const schedule = (entry: Entry, delay: number): void => {
    clearTimer(entry);
    entry.timer = setTimeoutFn(() => {
      entry.timer = null;
      void run(entry);
    }, Math.max(0, delay));
  };

  const reportError = (entry: Entry, error: unknown): void => {
    try {
      entry.onError(error);
    } catch {
      // A diagnostic callback must not alter scheduling or cleanup.
    }
  };

  const finishRun = (entry: Entry): void => {
    entry.activePromise = null;
    entry.controller = null;
    if (destroyed || entry.stopped || entries.get(entry.key) !== entry) return;
    entry.effectiveIntervalMs = effectiveInterval(entry);
    if (entry.effectiveIntervalMs === null) {
      entry.resumePending = false;
      return;
    }
    const delay = entry.resumePending ? 0 : entry.effectiveIntervalMs;
    entry.resumePending = false;
    schedule(entry, delay);
  };

  const run = (entry: Entry): Promise<boolean> => {
    if (destroyed || entry.stopped || entries.get(entry.key) !== entry) return Promise.resolve(false);
    entry.effectiveIntervalMs = effectiveInterval(entry);
    if (entry.effectiveIntervalMs === null) {
      clearTimer(entry);
      entry.controller?.abort();
      return Promise.resolve(false);
    }
    if (entry.activePromise) return entry.activePromise;

    clearTimer(entry);
    const controller = new AbortController();
    entry.controller = controller;
    entry.runCount += 1;
    const promise = Promise.resolve()
      .then(() => entry.task(controller.signal))
      .then((result) => {
        if (controller.signal.aborted || destroyed || entry.stopped || entries.get(entry.key) !== entry) return false;
        entry.onResult(result);
        return true;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error) && !destroyed && !entry.stopped && entries.get(entry.key) === entry) {
          reportError(entry, error);
        }
        return false;
      })
      .finally(() => finishRun(entry));
    entry.activePromise = promise;
    return promise;
  };

  const stopEntry = (entry: Entry | undefined): boolean => {
    if (!entry || entry.stopped) return false;
    entry.stopped = true;
    entry.resumePending = false;
    clearTimer(entry);
    entry.controller?.abort();
    entries.delete(entry.key);
    return true;
  };

  const reconcile = (): void => {
    if (destroyed) return;
    for (const entry of entries.values()) {
      const previous = entry.effectiveIntervalMs;
      const next = effectiveInterval(entry);
      if (previous === next) continue;
      entry.effectiveIntervalMs = next;
      if (next === null) {
        entry.resumePending = false;
        clearTimer(entry);
        entry.controller?.abort();
      } else if (entry.activePromise) {
        entry.resumePending = previous === null || next < previous;
      } else {
        schedule(entry, previous === null || next < previous ? 0 : next);
      }
    }
  };

  const unsubscribeVisibility = visibilitySource.subscribe(reconcile);
  const unsubscribeLifecycle = lifecycleSource?.subscribe(reconcile) ?? (() => {});

  const service: PollingService = {
    start<T>({
      key,
      scope = "global",
      intervalMs,
      immediate = true,
      critical,
      alwaysFocusRate = false,
      task,
      onResult,
      onError = () => {},
    }: PollingRegistration<T>): PollingHandle {
      if (destroyed) throw new Error("polling_service_destroyed");
      const normalizedKey = requireResource(key, "polling_key");
      const normalizedScope = requireResource(scope, "polling_scope");
      const existing = entries.get(normalizedKey);
      if (existing) return existing.handle;
      if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new TypeError("invalid_polling_interval");
      if (typeof critical !== "boolean" || typeof task !== "function" || typeof onResult !== "function" || typeof onError !== "function") {
        throw new TypeError("invalid_polling_registration");
      }

      let entry!: Entry;
      const handle: PollingHandle = Object.freeze({
        key: normalizedKey,
        scope: normalizedScope,
        trigger: () => run(entry),
        stop: () => stopEntry(entry),
      });
      entry = {
        key: normalizedKey,
        scope: normalizedScope,
        intervalMs,
        critical,
        alwaysFocusRate,
        task: task as (signal: AbortSignal) => Promise<unknown>,
        onResult: onResult as (result: unknown) => void,
        onError,
        handle,
        effectiveIntervalMs: intervalMs,
        timer: null,
        controller: null,
        activePromise: null,
        resumePending: false,
        stopped: false,
        runCount: 0,
      };
      entry.effectiveIntervalMs = effectiveInterval(entry);
      entries.set(entry.key, entry);
      if (entry.effectiveIntervalMs !== null) schedule(entry, immediate ? 0 : entry.effectiveIntervalMs);
      return handle;
    },
    trigger(key) {
      const entry = entries.get(key);
      return entry ? run(entry) : Promise.resolve(false);
    },
    stop(key) {
      return stopEntry(entries.get(key));
    },
    stopScope(scope) {
      const normalizedScope = requireResource(scope, "polling_scope");
      let count = 0;
      for (const entry of [...entries.values()]) {
        if (entry.scope === normalizedScope && stopEntry(entry)) count += 1;
      }
      return count;
    },
    getSummary() {
      return Object.freeze([...entries.values()].map((entry) => Object.freeze({
        key: entry.key,
        scope: entry.scope,
        intervalMs: entry.intervalMs,
        effectiveIntervalMs: entry.effectiveIntervalMs,
        state: entry.effectiveIntervalMs === null
          ? "paused"
          : entry.activePromise
            ? "running"
            : "scheduled",
        runCount: entry.runCount,
      })));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const entry of [...entries.values()]) stopEntry(entry);
      unsubscribeVisibility();
      unsubscribeLifecycle();
    },
  };
  return Object.freeze(service);
}
