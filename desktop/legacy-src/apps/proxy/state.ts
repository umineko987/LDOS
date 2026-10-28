import type {
  ProxyErrorPresentation,
  ProxyOperation,
  ProxySources,
  ProxyStatus,
  ProxyWorkspacePhase,
} from "./model";

export type ProxyConfirmedAction = "subscription-delete" | "inline-delete" | "node-file-clear" | "override-reset";

export interface ProxyConfirmation {
  readonly action: ProxyConfirmedAction;
  readonly sourceId: string;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly warning: string;
}

export interface ProxyState {
  readonly status: ProxyStatus | null;
  readonly sources: ProxySources | null;
  readonly phase: ProxyWorkspacePhase;
  readonly busy: ProxyOperation | "";
  readonly error: ProxyErrorPresentation | null;
  readonly message: string;
  readonly confirmation: ProxyConfirmation | null;
}

export interface ProxyStore {
  subscribe(listener: (state: ProxyState) => void): () => void;
  getState(): ProxyState;
  beginLoad(operation?: ProxyOperation): boolean;
  commitStatus(status: ProxyStatus): boolean;
  commitSources(sources: ProxySources, message?: string): boolean;
  commitAuthority(status: ProxyStatus, sources: ProxySources, message?: string, error?: ProxyErrorPresentation | null): boolean;
  fail(error: ProxyErrorPresentation): boolean;
  beginWrite(operation: ProxyOperation): boolean;
  requestConfirmation(confirmation: ProxyConfirmation): boolean;
  clearConfirmation(): boolean;
  setMessage(message: string): boolean;
  destroy(): void;
}

function freeze(state: ProxyState): ProxyState {
  return Object.freeze(state);
}

export function proxyNodes(state: ProxyState) {
  return state.status
    ? state.status.nodeOrder.map((id) => state.status!.nodes[id]).filter(Boolean)
    : [];
}

export function proxySubscriptions(state: ProxyState) {
  return state.sources
    ? state.sources.subscriptionOrder.map((id) => state.sources!.subscriptions[id]).filter(Boolean)
    : [];
}

export function proxyInlineNodes(state: ProxyState) {
  return state.sources
    ? state.sources.inlineNodeOrder.map((id) => state.sources!.inlineNodes[id]).filter(Boolean)
    : [];
}

export function createProxyStore(): ProxyStore {
  let state = freeze({
    status: null,
    sources: null,
    phase: "loading",
    busy: "",
    error: null,
    message: "正在加载代理状态和节点来源……",
    confirmation: null,
  });
  const listeners = new Set<(state: ProxyState) => void>();
  let destroyed = false;

  const publish = (next: ProxyState): boolean => {
    if (destroyed || next === state) return false;
    state = freeze(next);
    for (const listener of listeners) listener(state);
    return true;
  };

  const store: ProxyStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    beginLoad(operation = "refresh") {
      if (state.busy) return false;
      return publish({
        ...state,
        phase: operation === "refresh" ? "loading" : "writing",
        busy: operation,
        error: null,
        confirmation: null,
        message: operation === "refresh" ? "正在刷新代理状态和节点来源……" : "正在执行代理操作，请勿重复提交……",
      });
    },
    commitStatus(status) {
      return publish({
        ...state,
        status,
        phase: state.sources ? "idle" : "partial",
        busy: state.busy === "refresh" ? "" : state.busy,
        error: state.sources ? null : state.error,
        message: "代理运行状态已更新。",
      });
    },
    commitSources(sources, message = "代理节点来源已更新。") {
      return publish({
        ...state,
        sources,
        phase: state.status ? "idle" : "partial",
        busy: state.busy === "refresh" ? "" : state.busy,
        error: null,
        message,
      });
    },
    commitAuthority(status, sources, message = "代理状态和节点来源已权威重读。", error = null) {
      return publish({
        ...state,
        status,
        sources,
        phase: error ? "partial" : "idle",
        busy: "",
        error,
        message,
        confirmation: null,
      });
    },
    fail(error) {
      return publish({
        ...state,
        phase: state.status || state.sources ? "partial" : "error",
        busy: "",
        error,
        confirmation: null,
        message: "操作失败，当前安全事实已保留。请刷新后重试。",
      });
    },
    beginWrite(operation) {
      if (state.busy) return false;
      return publish({
        ...state,
        phase: "writing",
        busy: operation,
        error: null,
        confirmation: null,
        message: "正在执行代理操作，请勿重复提交……",
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
