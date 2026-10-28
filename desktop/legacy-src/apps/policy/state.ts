import {
  getPolicySiteDefinition,
  validatePolicySnapshot,
  type PolicyErrorPresentation,
  type PolicyItem,
  type PolicyPhase,
  type PolicySiteId,
  type PolicySnapshot,
} from "./model";

export type PolicyOperation = "refresh" | "save" | "reset";
export type PolicyConfirmedAction = "reset" | "discard-site";

export interface PolicyConfirmation {
  readonly action: PolicyConfirmedAction;
  readonly site: PolicySiteId;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly warning: string;
}

export interface PolicyState {
  readonly selectedSite: PolicySiteId;
  readonly snapshot: PolicySnapshot | null;
  readonly phase: PolicyPhase;
  readonly busy: PolicyOperation | "";
  readonly error: PolicyErrorPresentation | null;
  readonly message: string;
  readonly confirmation: PolicyConfirmation | null;
}

export interface PolicyCommitOptions {
  readonly phase?: PolicyPhase;
  readonly message?: string;
  readonly error?: PolicyErrorPresentation | null;
  readonly clearBusy?: boolean;
}

export interface PolicyStore {
  subscribe(listener: (state: PolicyState) => void): () => void;
  getState(): PolicyState;
  selectSite(site: PolicySiteId): boolean;
  beginLoad(): boolean;
  beginWrite(operation: PolicyOperation): boolean;
  commitSnapshot(snapshot: PolicySnapshot, options?: PolicyCommitOptions): boolean;
  fail(error: PolicyErrorPresentation, message?: string): boolean;
  requestConfirmation(confirmation: PolicyConfirmation): boolean;
  clearConfirmation(): boolean;
  setMessage(message: string): boolean;
  setPhase(phase: PolicyPhase, message?: string): boolean;
  destroy(): void;
}

function freeze(state: PolicyState): PolicyState {
  return Object.freeze(state);
}

export function createPolicyStore({ selectedSite = "danbooru" }: { readonly selectedSite?: PolicySiteId } = {}): PolicyStore {
  if (!getPolicySiteDefinition(selectedSite)) throw new TypeError("invalid_policy_site");
  let state = freeze({
    selectedSite,
    snapshot: null,
    phase: "loading" as PolicyPhase,
    busy: "" as const,
    error: null,
    message: "正在加载站点设置……",
    confirmation: null,
  });
  const listeners = new Set<(state: PolicyState) => void>();
  let destroyed = false;

  const publish = (next: PolicyState): boolean => {
    if (destroyed || next === state) return false;
    state = freeze(next);
    for (const listener of listeners) listener(state);
    return true;
  };

  const store: PolicyStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    selectSite(site) {
      if (!getPolicySiteDefinition(site) || state.busy || state.selectedSite === site) return false;
      return publish({
        ...state,
        selectedSite: site,
        phase: state.snapshot ? "idle" : "loading",
        error: null,
        confirmation: null,
        message: `已切换到 ${getPolicySiteDefinition(site)!.label}。`,
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
        message: "正在刷新五个站点的设置……",
      });
    },
    beginWrite(operation) {
      if (state.busy || state.confirmation) return false;
      return publish({
        ...state,
        phase: "saving",
        busy: operation,
        error: null,
        confirmation: null,
        message: "正在执行站点设置操作，请勿重复提交……",
      });
    },
    commitSnapshot(snapshot, options = {}) {
      validatePolicySnapshot(snapshot);
      return publish({
        ...state,
        snapshot,
        phase: options.phase ?? "idle",
        busy: options.clearBusy === false ? state.busy : "",
        error: options.error ?? null,
        message: options.message ?? "站点设置已权威重读。",
        confirmation: null,
      });
    },
    fail(error, message = "操作失败，当前安全设置事实已保留；草稿仍可检查后重试。") {
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
      if (state.busy || state.confirmation || !getPolicySiteDefinition(confirmation.site)) return false;
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
    setPhase(phase, message = state.message) {
      if (state.phase === phase && state.message === message && state.busy === "") return false;
      return publish({ ...state, phase, busy: "", message });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(store);
}

export function policyItems(snapshot: PolicySnapshot | null): readonly PolicyItem[] {
  if (!snapshot) return Object.freeze([]);
  return Object.freeze(snapshot.siteOrder.map((site) => snapshot.sites[site]).filter(Boolean));
}
