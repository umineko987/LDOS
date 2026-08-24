import {
  getVaultSiteDefinition,
  mergeVaultSite,
  validateVaultSnapshot,
  type VaultErrorPresentation,
  type VaultSiteId,
  type VaultSiteStatus,
  type VaultSnapshot,
  type VaultWorkspacePhase,
} from "./model";

export type VaultOperation = "refresh" | "profile-clear" | "proxy-save" | "proxy-reset"
  | `authorize:${VaultSiteId}` | `cancel:${VaultSiteId}` | `clear:${VaultSiteId}`;
export type VaultConfirmedAction = "cancel-site" | "clear-site" | "profile-clear" | "proxy-reset" | "proxy-direct";

export interface VaultConfirmation {
  readonly action: VaultConfirmedAction;
  readonly site: VaultSiteId | "";
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly warning: string;
}

export interface VaultState {
  readonly selectedSite: VaultSiteId;
  readonly snapshot: VaultSnapshot | null;
  readonly phase: VaultWorkspacePhase;
  readonly busy: VaultOperation | "";
  readonly error: VaultErrorPresentation | null;
  readonly message: string;
  readonly confirmation: VaultConfirmation | null;
}

export interface VaultCommitOptions {
  readonly phase?: VaultWorkspacePhase;
  readonly message?: string;
  readonly error?: VaultErrorPresentation | null;
  readonly clearBusy?: boolean;
}

export interface VaultStore {
  subscribe(listener: (state: VaultState) => void): () => void;
  getState(): VaultState;
  selectSite(site: VaultSiteId): boolean;
  beginLoad(): boolean;
  beginWrite(operation: VaultOperation): boolean;
  commitSnapshot(snapshot: VaultSnapshot, options?: VaultCommitOptions): boolean;
  commitSite(status: VaultSiteStatus, options?: VaultCommitOptions): boolean;
  fail(error: VaultErrorPresentation, message?: string): boolean;
  requestConfirmation(confirmation: VaultConfirmation): boolean;
  clearConfirmation(): boolean;
  setMessage(message: string): boolean;
  destroy(): void;
}

function freezeState(state: VaultState): VaultState {
  return Object.freeze(state);
}

function complete(snapshot: VaultSnapshot): boolean {
  return Boolean(
    snapshot.browserProfile
      && snapshot.authorizationProxy
      && snapshot.siteOrder.every((site) => snapshot.sites[site]),
  );
}

export function createVaultStore({ selectedSite = "danbooru" }: { readonly selectedSite?: VaultSiteId } = {}): VaultStore {
  if (!getVaultSiteDefinition(selectedSite)) throw new TypeError("invalid_vault_site");
  let state = freezeState({
    selectedSite,
    snapshot: null,
    phase: "loading",
    busy: "",
    error: null,
    message: "正在加载授权状态……",
    confirmation: null,
  });
  const listeners = new Set<(state: VaultState) => void>();
  let destroyed = false;

  const publish = (next: VaultState): boolean => {
    if (destroyed || next === state) return false;
    state = freezeState(next);
    for (const listener of listeners) listener(state);
    return true;
  };

  const store: VaultStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    selectSite(site) {
      if (!getVaultSiteDefinition(site) || state.selectedSite === site || state.busy) return false;
      return publish({
        ...state,
        selectedSite: site,
        phase: "loading",
        busy: "refresh",
        error: null,
        confirmation: null,
        message: `正在刷新 ${getVaultSiteDefinition(site)!.label} 与完整授权状态……`,
      });
    },
    beginLoad() {
      if (state.busy) return false;
      return publish({
        ...state,
        phase: "loading",
        busy: "refresh",
        error: null,
        confirmation: null,
        message: "正在刷新站点、授权浏览器和登录代理状态……",
      });
    },
    beginWrite(operation) {
      if (state.busy || state.confirmation) return false;
      return publish({
        ...state,
        phase: "writing",
        busy: operation,
        error: null,
        message: "正在执行授权操作，请勿重复提交……",
      });
    },
    commitSnapshot(snapshot, options = {}) {
      validateVaultSnapshot(snapshot);
      const phase = options.phase ?? (complete(snapshot) ? "idle" : "partial");
      return publish({
        ...state,
        snapshot,
        phase,
        busy: options.clearBusy === false ? state.busy : "",
        error: options.error ?? null,
        message: options.message ?? "授权状态已权威重读。",
        confirmation: null,
      });
    },
    commitSite(status, options = {}) {
      const snapshot = mergeVaultSite(state.snapshot, status);
      const phase = options.phase ?? (complete(snapshot) ? "idle" : "partial");
      return publish({
        ...state,
        snapshot,
        phase,
        busy: options.clearBusy === false ? state.busy : "",
        error: options.error ?? null,
        message: options.message ?? `${status.label} 授权状态已更新。`,
      });
    },
    fail(error, message = "操作失败，已加载的安全授权事实继续保留。请刷新后重试。") {
      return publish({
        ...state,
        phase: state.snapshot ? "partial" : "error",
        busy: "",
        error,
        confirmation: null,
        message,
      });
    },
    requestConfirmation(confirmation) {
      if (state.busy || state.confirmation) return false;
      return publish({ ...state, confirmation: Object.freeze({ ...confirmation }) });
    },
    clearConfirmation() {
      if (!state.confirmation) return false;
      return publish({ ...state, confirmation: null });
    },
    setMessage(message) {
      if (state.message === message) return false;
      return publish({ ...state, message });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(store);
}
