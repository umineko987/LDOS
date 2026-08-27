import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  RuntimeContractError,
  sanitizeBackendStatus,
  sanitizeRuntimeMetadata,
  type BackendStatus,
  type RuntimeMetadata,
} from "../runtime/sanitize";

export type PlatformDirectoryPurpose = "gallery_import" | "gallery_relink" | "export_target";

export class PlatformCapabilityError extends Error {
  constructor(readonly code: "capability_unavailable") {
    super(code);
    this.name = "PlatformCapabilityError";
  }
}

interface TauriBridge {
  isTauri(): boolean;
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

interface LocationSource {
  readonly origin: string;
}

interface PlatformDependencies {
  readonly bridge?: TauriBridge;
  readonly location?: LocationSource;
}

export interface PlatformCapabilities {
  /** 本机目录选择（图库导入/重关联/导出目标），仅桌面模式可用。 */
  readonly selectDirectory: boolean;
  /** 在系统文件管理器中定位结果，仅桌面模式可用。 */
  readonly revealInFileManager: boolean;
}

export interface PlatformAdapter {
  readonly mode: "browser" | "tauri";
  readonly capabilities: PlatformCapabilities;
  getRuntimeMetadata(): Promise<RuntimeMetadata>;
  getBackendStatus(): Promise<BackendStatus>;
  /** 选择一个目录。用户取消返回 null；浏览器模式抛 PlatformCapabilityError。 */
  selectDirectory(purpose: PlatformDirectoryPurpose): Promise<string | null>;
  /** 在系统文件管理器中定位一个路径。浏览器模式抛 PlatformCapabilityError。 */
  revealInFileManager(path: string): Promise<void>;
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

  const capabilities: PlatformCapabilities = Object.freeze({
    selectDirectory: mode === "tauri",
    revealInFileManager: mode === "tauri",
  });

  // 计划 §8.1：目录选择只返回宿主给定的绝对路径字符串，
  // 经最小消毒（非空、无控制字符）后只供短生命周期表单草稿使用。
  const selectDirectory = async (
    _purpose: PlatformDirectoryPurpose,
  ): Promise<string | null> => {
    if (mode === "browser") throw new PlatformCapabilityError("capability_unavailable");
    let picked: unknown;
    try {
      picked = await bridge.invoke("select_directory");
    } catch {
      throw new PlatformCapabilityError("capability_unavailable");
    }
    if (picked === null || picked === undefined) return null;
    if (
      typeof picked !== "string" ||
      picked.trim().length === 0 ||
      /[\u0000-\u001f]/.test(picked)
    ) {
      throw new PlatformCapabilityError("capability_unavailable");
    }
    return picked;
  };

  const revealInFileManager = async (path: string): Promise<void> => {
    if (mode === "browser") throw new PlatformCapabilityError("capability_unavailable");
    if (
      typeof path !== "string" ||
      path.trim().length === 0 ||
      /[\u0000-\u001f]/.test(path)
    ) {
      throw new PlatformCapabilityError("capability_unavailable");
    }
    try {
      await bridge.invoke("reveal_in_file_manager", { path });
    } catch {
      throw new PlatformCapabilityError("capability_unavailable");
    }
  };

  return Object.freeze({
    mode,
    capabilities,
    getRuntimeMetadata,
    getBackendStatus,
    selectDirectory,
    revealInFileManager,
  });
}
