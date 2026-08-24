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

interface PlatformDependencies {
  readonly bridge?: TauriBridge;
  readonly location?: LocationSource;
}

export interface PlatformAdapter {
  readonly mode: "browser" | "tauri";
  getRuntimeMetadata(): Promise<RuntimeMetadata>;
  getBackendStatus(): Promise<BackendStatus>;
}

const defaultBridge: TauriBridge = {
  isTauri,
  invoke,
};

export function createPlatformAdapter({
  bridge = defaultBridge,
  location = globalThis.location,
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

  return Object.freeze({ mode, getRuntimeMetadata, getBackendStatus });
}
