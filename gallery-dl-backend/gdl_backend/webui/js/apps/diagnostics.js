import { isAbortError } from "../core/api.js";
import {
  buildDiagnosticsSnapshot,
  createDiagnosticsRequestGate,
  deriveDiagnosticsWorkspacePresentation,
  diagnosticsCopyText,
  DIAGNOSTICS_POLL_INTERVAL_MS,
} from "../core/diagnostics-model.js";
import { setElementInert } from "../core/dom.js";
import { actionCreators } from "../core/store.js";
import { createDiagnosticsView } from "../components/diagnostics-view.js";

export const DIAGNOSTICS_ENDPOINTS = Object.freeze({
  health: "/healthz",
  readiness: "/readyz",
  config: "/api/v1/config?view=diagnostics",
  scheduler: "/api/v1/scheduler/status?view=diagnostics",
});

const DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot";
const RECOVERY_TARGETS = new Set(["proxy", "tasks"]);

function safeErrorResponse(error) {
  if (!error || typeof error !== "object") return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  if (error.status > 0 && error.status < 500) return null;
  if (error.code !== "http_error" && error.code !== "request_failed") return null;
  return details;
}

async function readOutcome(api, path, signal) {
  try {
    return Object.freeze({ connected: true, data: await api.get(path, { signal }), error: null });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error;
    return Object.freeze({
      connected: Number.isInteger(error?.status) && error.status > 0,
      data: null,
      response: safeErrorResponse(error),
      error: Object.freeze({
        status: Number.isInteger(error?.status) ? error.status : 0,
        code: error?.code,
        requestId: error?.requestId,
      }),
    });
  }
}

export function createDiagnosticsController(context, {
  createView = createDiagnosticsView,
  clipboard = globalThis.navigator?.clipboard,
  now = Date.now,
} = {}) {
  const { root, api, store, polling, actions } = context;
  const view = createView(context);
  if (!view || typeof view !== "object") throw new TypeError("诊断视图无效");
  const requestGate = createDiagnosticsRequestGate();
  let active = false;
  let destroyed = false;
  let refreshing = false;
  let manualPromise = null;
  let cycleController = null;
  let activeCyclePromise = null;

  const currentSnapshot = () => store.getState().diagnostics.snapshot;

  const setPresentation = ({ forceRefreshing = refreshing } = {}) => {
    const presentation = deriveDiagnosticsWorkspacePresentation({
      snapshot: currentSnapshot(),
      refreshing: forceRefreshing,
    });
    view.setWorkspacePhase?.(presentation.state, presentation);
    return presentation;
  };

  const linkSignal = (externalSignal, controller) => {
    if (!externalSignal) return () => {};
    const abort = () => controller.abort();
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
    return () => externalSignal.removeEventListener("abort", abort);
  };

  const refresh = (externalSignal) => {
    if (!active || destroyed) return Promise.resolve(false);
    if (activeCyclePromise) return activeCyclePromise;
    const ticket = requestGate.beginCycle();
    const controller = new AbortController();
    cycleController = controller;
    const unlink = linkSignal(externalSignal, controller);
    refreshing = true;
    setPresentation();
    const promise = (async () => {
      try {
        const [health, readiness, config, scheduler] = await Promise.all([
          readOutcome(api, DIAGNOSTICS_ENDPOINTS.health, controller.signal),
          readOutcome(api, DIAGNOSTICS_ENDPOINTS.readiness, controller.signal),
          readOutcome(api, DIAGNOSTICS_ENDPOINTS.config, controller.signal),
          readOutcome(api, DIAGNOSTICS_ENDPOINTS.scheduler, controller.signal),
        ]);
        if (!active || destroyed || controller.signal.aborted || !requestGate.isCycleCurrent(ticket)) return false;
        const snapshot = buildDiagnosticsSnapshot({
          health,
          readiness,
          config,
          scheduler,
          checkedAt: now(),
          previous: currentSnapshot(),
        });
        store.dispatch(actionCreators.diagnosticsReceived(snapshot));
        const presentation = deriveDiagnosticsWorkspacePresentation({ snapshot });
        view.setWorkspacePhase?.(presentation.state, presentation);
        view.setOperationMessage(snapshot.offline
          ? snapshot.staleSections.length
            ? "服务离线，当前保留上次成功读取的分区并标记为陈旧。"
            : "服务离线，首次检查没有可显示的安全快照。"
          : snapshot.stale
            ? snapshot.staleSections.length
              ? "部分检查失败，仅对应分区保留上次安全快照并标记为陈旧。"
              : "部分检查失败；首次检查不会补造缺失事实。"
            : "服务、功能、安全配置和任务调度状态已刷新。");
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed) return false;
        view.setOperationMessage("诊断刷新未完成；当前安全快照保持不变。请重试。");
        setPresentation({ forceRefreshing: false });
        return false;
      } finally {
        unlink();
        if (cycleController === controller) cycleController = null;
        const currentPromise = activeCyclePromise === promise;
        if (currentPromise) {
          activeCyclePromise = null;
          refreshing = false;
        }
        if (currentPromise && active && requestGate.isCycleCurrent(ticket)) {
          setPresentation({ forceRefreshing: false });
        }
      }
    })();
    activeCyclePromise = promise;
    return promise;
  };

  const manualRefresh = () => {
    if (!active || destroyed) return Promise.resolve(false);
    if (manualPromise) return manualPromise;
    view.setBusy(true);
    const promise = Promise.resolve()
      .then(() => polling.trigger(DIAGNOSTICS_POLL_KEY))
      .finally(() => {
        if (manualPromise === promise) manualPromise = null;
        if (active && !destroyed) view.setBusy(false);
      });
    manualPromise = promise;
    return promise;
  };

  const copySummary = async () => {
    const snapshot = currentSnapshot();
    if (!snapshot || !active || destroyed) return false;
    const text = diagnosticsCopyText(snapshot);
    try {
      if (typeof clipboard?.writeText !== "function") {
        view.setOperationMessage("当前浏览器的剪贴板不可用，未复制任何内容。");
        return false;
      }
      await clipboard.writeText(text);
      if (!active || destroyed) return false;
      view.setOperationMessage("诊断摘要已复制，敏感信息已隐藏。");
      return true;
    } catch {
      if (active && !destroyed) {
        view.setOperationMessage("浏览器未允许写入剪贴板，请检查权限后重试。");
      }
      return false;
    }
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-diagnostics-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.diagnosticsAction;
    if (action === "refresh") await manualRefresh();
    else if (action === "copy") await copySummary();
    else if (action === "navigate") {
      const target = button.closest("[data-target-app]")?.dataset.targetApp || "";
      if (RECOVERY_TARGETS.has(target)) actions.navigateToApp(target);
    }
  };

  root.addEventListener("click", onClick);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.setOperationMessage("正在刷新诊断信息……");
      setPresentation({ forceRefreshing: true });
      polling.start({
        key: DIAGNOSTICS_POLL_KEY,
        scope: context.pollingScope,
        intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS,
        immediate: true,
        critical: false,
        resume: "immediate",
        task: refresh,
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      refreshing = false;
      manualPromise = null;
      requestGate.advanceLifecycle();
      polling.stop(DIAGNOSTICS_POLL_KEY);
      cycleController?.abort();
      cycleController = null;
      activeCyclePromise = null;
      view.setBusy(false);
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      refreshing = false;
      manualPromise = null;
      requestGate.advanceLifecycle();
      polling.stop(DIAGNOSTICS_POLL_KEY);
      cycleController?.abort();
      cycleController = null;
      activeCyclePromise = null;
      root.removeEventListener("click", onClick);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("系统诊断已挂载");
    controller = createDiagnosticsController(context);
  },
  activate() {
    controller?.activate();
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
