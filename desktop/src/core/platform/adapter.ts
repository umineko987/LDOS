import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  RuntimeContractError,
  sanitizeBackendStatus,
  sanitizeRuntimeMetadata,
  type BackendStatus,
  type RuntimeMetadata,
} from "../runtime/sanitize";

interface TauriBridge {
  isTauri(): boolean;
  invoke(command: string): Promise<unknown>;
}

interface LocationSource {
  readonly origin: string;
}

type IntervalHandle = ReturnType<typeof globalThis.setInterval>;
type SetInterval = (callback: () => void, delay: number) => IntervalHandle;
type ClearInterval = (handle: IntervalHandle) => void;

interface PlatformDependencies {
  readonly bridge?: TauriBridge;
  readonly location?: LocationSource;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: SetInterval;
  readonly clearIntervalFn?: ClearInterval;
}

export interface PlatformAdapter {
  readonly mode: "browser" | "tauri";
  getRuntimeMetadata(): Promise<RuntimeMetadata>;
  getBackendStatus(): Promise<BackendStatus>;
  watchBackendStatus(listener: (status: BackendStatus) => void): () => void;
}

const defaultBridge: TauriBridge = {
  isTauri,
  invoke,
};

export function createPlatformAdapter({
  bridge = defaultBridge,
  location = globalThis.location,
  pollIntervalMs = 500,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
}: PlatformDependencies = {}): PlatformAdapter {
  const mode = bridge.isTauri() ? "tauri" : "browser";

  const getRuntimeMetadata = async (): Promise<RuntimeMetadata> => {
    if (mode === "browser") {
      if (!location?.origin) throw new RuntimeContractError("runtime_metadata_unavailable");
      return sanitizeRuntimeMetadata({ apiOrigin: location.origin, backendVersion: null });
    }
    try {
      return sanitizeRuntimeMetadata(await bridge.invoke("runtime_metadata"));
    } catch {
      throw new RuntimeContractError("runtime_metadata_unavailable");
    }
  };

  const getBackendStatus = async (): Promise<BackendStatus> => {
    if (mode === "browser") return sanitizeBackendStatus({ state: "ready" });
    try {
      return sanitizeBackendStatus(await bridge.invoke("backend_status"));
    } catch {
      return sanitizeBackendStatus({ state: "failed", code: "platform_unavailable" });
    }
  };

  const watchBackendStatus = (listener: (status: BackendStatus) => void): (() => void) => {
    let active = true;
    let running = false;
    const tick = async (): Promise<void> => {
      if (!active || running) return;
      running = true;
      const status = await getBackendStatus();
      running = false;
      if (active) listener(status);
    };
    void tick();
    const timer = mode === "tauri"
      ? setIntervalFn(() => { void tick(); }, Math.max(100, pollIntervalMs))
      : null;
    return () => {
      active = false;
      if (timer !== null) clearIntervalFn(timer);
    };
  };

  return Object.freeze({ mode, getRuntimeMetadata, getBackendStatus, watchBackendStatus });
}
