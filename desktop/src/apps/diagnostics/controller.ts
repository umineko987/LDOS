import type { PollingHandle, PollingRegistration, PollingService } from "../../core/polling/service";
import { translateCurrentUiText } from "../../core/i18n";
import {
  buildDiagnosticsSnapshot,
  createDiagnosticsRequestGate,
  diagnosticsCopyText,
  DIAGNOSTICS_POLL_INTERVAL_MS,
} from "./model";
import type { DiagnosticsService } from "./service";
import type { DiagnosticsStore } from "./state";

export const DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot";
export const DIAGNOSTICS_SCOPE = "app:diagnostics";

export interface DiagnosticsController {
  activate(): void;
  deactivate(): void;
  refresh(): Promise<boolean>;
  copySummary(): Promise<boolean>;
  navigate(targetApp: string): boolean;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function errorPresentation(error: unknown): { title: string; message: string; nextStep: string } {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 0;
  return Object.freeze({
    title: status >= 500 ? "诊断服务暂时不可用" : "诊断刷新失败",
    message: "当前安全诊断快照没有完成更新。",
    nextStep: "请稍后刷新；错误正文和敏感细节不会显示。",
  });
}

function linkSignal(externalSignal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!externalSignal) return () => {};
  const abort = (): void => controller.abort();
  if (externalSignal.aborted) abort();
  else externalSignal.addEventListener("abort", abort, { once: true });
  return () => externalSignal.removeEventListener("abort", abort);
}

export function createDiagnosticsController({
  store,
  service,
  polling,
  onNavigate = () => {},
}: {
  readonly store: DiagnosticsStore;
  readonly service: DiagnosticsService;
  readonly polling: PollingService;
  readonly onNavigate?: (appId: "proxy" | "tasks") => void;
}): DiagnosticsController {
  const requestGate = createDiagnosticsRequestGate();
  let active = false;
  let destroyed = false;
  let cycleController: AbortController | null = null;
  let activeCyclePromise: Promise<boolean> | null = null;
  let manualPromise: Promise<boolean> | null = null;
  let pollHandle: PollingHandle | null = null;

  const refreshCycle = (externalSignal?: AbortSignal): Promise<boolean> => {
    if (!active || destroyed) return Promise.resolve(false);
    if (activeCyclePromise) return activeCyclePromise;
    if (!store.beginRefresh()) return Promise.resolve(false);

    const ticket = requestGate.beginCycle();
    const controller = new AbortController();
    cycleController = controller;
    const unlink = linkSignal(externalSignal, controller);
    let promise!: Promise<boolean>;
    promise = (async () => {
      try {
        const outcome = await service.readAll(controller.signal);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isCycleCurrent(ticket)) return false;
        const snapshot = buildDiagnosticsSnapshot({
          ...outcome,
          checkedAt: Date.now(),
          previous: store.getState().snapshot,
        });
        store.commit(
          snapshot,
          snapshot.offline
            ? "服务离线，当前保留上次成功读取的安全分区。"
            : snapshot.stale
              ? "部分检查失败；可见分区已安全投影并标记陈旧。"
              : "服务、功能、安全配置和任务调度状态已刷新。",
        );
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed) return false;
        store.fail(errorPresentation(error));
        return false;
      } finally {
        unlink();
        if (cycleController === controller) cycleController = null;
        if (activeCyclePromise === promise) activeCyclePromise = null;
      }
    })();
    activeCyclePromise = promise;
    return promise;
  };

  const manualRefresh = (): Promise<boolean> => {
    if (!active || destroyed) return Promise.resolve(false);
    if (manualPromise) return manualPromise;
    const promise = Promise.resolve()
      .then(() => polling.trigger(DIAGNOSTICS_POLL_KEY))
      .then(Boolean)
      .finally(() => {
        if (manualPromise === promise) manualPromise = null;
      });
    manualPromise = promise;
    return promise;
  };

  const controller: DiagnosticsController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      requestGate.advanceLifecycle();
      const registration: PollingRegistration<boolean> = {
        key: DIAGNOSTICS_POLL_KEY,
        scope: DIAGNOSTICS_SCOPE,
        intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS,
        immediate: true,
        critical: false,
        task: (signal) => refreshCycle(signal),
        onResult: () => {},
        onError: (error) => {
          if (active && !destroyed) store.fail(errorPresentation(error));
        },
      };
      pollHandle = polling.start(registration);
    },
    deactivate() {
      if (!active || destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      manualPromise = null;
      pollHandle?.stop();
      pollHandle = null;
      polling.stop(DIAGNOSTICS_POLL_KEY);
      polling.stopScope(DIAGNOSTICS_SCOPE);
      cycleController?.abort();
      cycleController = null;
      activeCyclePromise = null;
    },
    refresh: manualRefresh,
    async copySummary() {
      const snapshot = store.getState().snapshot;
      const clipboard = globalThis.navigator?.clipboard;
      if (!active || destroyed || !snapshot) return false;
      if (typeof clipboard?.writeText !== "function") {
        store.setMessage("当前浏览器的剪贴板不可用，未复制任何内容。");
        return false;
      }
      try {
        await clipboard.writeText(translateCurrentUiText(diagnosticsCopyText(snapshot)));
        if (!active || destroyed) return false;
        store.setMessage("诊断摘要已复制，敏感信息已隐藏。");
        return true;
      } catch {
        if (active && !destroyed) store.setMessage("浏览器未允许写入剪贴板，请检查权限后重试。");
        return false;
      }
    },
    navigate(targetApp) {
      if (targetApp !== "proxy" && targetApp !== "tasks") return false;
      onNavigate(targetApp);
      return true;
    },
    destroy() {
      if (destroyed) return;
      if (active) controller.deactivate();
      destroyed = true;
      requestGate.advanceLifecycle();
      cycleController?.abort();
      cycleController = null;
      manualPromise = null;
      activeCyclePromise = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
