// 桌面宿主适配层，只调用 mygo Host 生成绑定的五个方法。
// 浏览器模式（vite dev、e2e）退回同源后端。

import { isMyGo } from "mygo-runtime";

import { Host } from "./mygo.generated.ts";

import {
  RuntimeContractError,
  hostPath,
  sanitizeBackendStatus,
  sanitizeRuntimeMetadata,
  type BackendStatus,
  type RuntimeMetadata,
} from "./sanitize.ts";

export type PlatformDirectoryPurpose = "gallery_import" | "gallery_relink" | "export_target";

export class PlatformCapabilityError extends Error {
  constructor(readonly code: "capability_unavailable") {
    super(code);
    this.name = "PlatformCapabilityError";
  }
}

export interface MyGoBridge {
  isMyGo(): boolean;
  readonly host: {
    runtimeMetadata(): Promise<unknown>;
    backendStatus(): Promise<unknown>;
    selectDirectory(): Promise<unknown>;
    selectBrowserExecutable(): Promise<unknown>;
    revealInFileManager(path: string): Promise<unknown>;
  };
}

export interface PlatformDependencies {
  readonly bridge?: MyGoBridge;
  readonly location?: { readonly origin: string } | undefined;
}

export interface PlatformCapabilities {
  /** 本机目录选择（图库导入/重关联/导出目标）。 */
  readonly selectDirectory: boolean;
  /** 选择 Chrome、Chromium 或 Edge 可执行文件。 */
  readonly selectBrowserExecutable: boolean;
  /** 在系统文件管理器中定位结果。 */
  readonly revealInFileManager: boolean;
}

export interface PlatformAdapter {
  readonly mode: "browser" | "mygo";
  /** 三项都只在桌面模式可用；界面据此隐藏按钮，而不是等调用失败。 */
  readonly capabilities: PlatformCapabilities;
  getRuntimeMetadata(): Promise<RuntimeMetadata>;
  /** 宿主调用失败时返回 `failed / platform_unavailable`，不抛错。 */
  getBackendStatus(): Promise<BackendStatus>;
  /** 用户取消返回 null；浏览器模式或宿主失败抛 PlatformCapabilityError。 */
  selectDirectory(purpose: PlatformDirectoryPurpose): Promise<string | null>;
  selectBrowserExecutable(): Promise<string | null>;
  revealInFileManager(path: string): Promise<void>;
}

const defaultBridge: MyGoBridge = { isMyGo, host: Host };

function unavailable(): never {
  throw new PlatformCapabilityError("capability_unavailable");
}

export function createPlatformAdapter({
  bridge = defaultBridge,
  location = globalThis.location,
}: PlatformDependencies = {}): PlatformAdapter {
  const mode = bridge.isMyGo() ? "mygo" : "browser";
  const desktop = mode === "mygo";

  async function pick(select: () => Promise<unknown>): Promise<string | null> {
    if (!desktop) unavailable();
    let picked: unknown;
    try {
      picked = await select();
    } catch {
      unavailable();
    }
    if (picked === null || picked === undefined) return null;
    return hostPath(picked) ?? unavailable();
  }

  return Object.freeze({
    mode,
    capabilities: Object.freeze({
      selectDirectory: desktop,
      selectBrowserExecutable: desktop,
      revealInFileManager: desktop,
    }),

    async getRuntimeMetadata() {
      if (!desktop) {
        if (!location?.origin) throw new RuntimeContractError("runtime_metadata_unavailable");
        return sanitizeRuntimeMetadata({ apiOrigin: location.origin, backendVersion: null });
      }
      try {
        return sanitizeRuntimeMetadata(await bridge.host.runtimeMetadata());
      } catch {
        throw new RuntimeContractError("runtime_metadata_unavailable");
      }
    },

    async getBackendStatus() {
      if (!desktop) return sanitizeBackendStatus({ state: "ready" });
      try {
        return sanitizeBackendStatus(await bridge.host.backendStatus());
      } catch {
        return sanitizeBackendStatus({ state: "failed", code: "platform_unavailable" });
      }
    },

    // 目录只返回宿主给定的绝对路径字符串，只供短生命周期的表单草稿使用。
    selectDirectory: (_purpose: PlatformDirectoryPurpose) => pick(() => bridge.host.selectDirectory()),
    selectBrowserExecutable: () => pick(() => bridge.host.selectBrowserExecutable()),

    async revealInFileManager(path: string) {
      if (!desktop || hostPath(path) === null) unavailable();
      try {
        await bridge.host.revealInFileManager(path);
      } catch {
        unavailable();
      }
    },
  });
}
