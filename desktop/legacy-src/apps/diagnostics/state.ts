import {
  validateDiagnosticsSnapshot,
  type DiagnosticsSnapshot,
} from "./model";

export interface DiagnosticsErrorPresentation {
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
}

export interface DiagnosticsState {
  readonly snapshot: DiagnosticsSnapshot | null;
  readonly busy: boolean;
  readonly error: DiagnosticsErrorPresentation | null;
  readonly message: string;
}

export interface DiagnosticsStore {
  subscribe(listener: (state: DiagnosticsState) => void): () => void;
  getState(): DiagnosticsState;
  beginRefresh(): boolean;
  commit(snapshot: DiagnosticsSnapshot, message?: string): boolean;
  fail(error: DiagnosticsErrorPresentation, message?: string): boolean;
  setMessage(message: string): boolean;
  destroy(): void;
}

function freeze(state: DiagnosticsState): DiagnosticsState {
  return Object.freeze(state);
}

export function createDiagnosticsStore(): DiagnosticsStore {
  let state = freeze({ snapshot: null, busy: false, error: null, message: "正在等待首次诊断检查。" });
  const listeners = new Set<(state: DiagnosticsState) => void>();
  let destroyed = false;
  const publish = (next: DiagnosticsState): boolean => {
    if (destroyed || next === state) return false;
    state = freeze(next);
    for (const listener of listeners) listener(state);
    return true;
  };
  const store: DiagnosticsStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    beginRefresh() {
      if (state.busy) return false;
      return publish({ ...state, busy: true, error: null, message: "正在刷新诊断信息……" });
    },
    commit(snapshot, message = "服务、功能、安全配置和任务调度状态已刷新。") {
      validateDiagnosticsSnapshot(snapshot);
      return publish({ snapshot, busy: false, error: null, message });
    },
    fail(error, message = "诊断刷新未完成；当前安全快照保持不变。请重试。") {
      return publish({ ...state, busy: false, error, message });
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
