import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  extractVaultSessionFromSnapshot,
  extractVaultSessionReference,
  getVaultSiteDefinition,
  validateAuthorizationProxyInput,
} from "../core/vault-model.js";
import { actionCreators } from "../core/store.js";
import { createVaultView } from "../components/vault-view.js";

export const VAULT_ENDPOINTS = Object.freeze({
  status: "/api/v1/auth",
  proxy: "/api/v1/auth/proxy",
  browserProfile: "/api/v1/auth/browser-profile",
  pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
  pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
});

const AUTHORIZATION_POLL_KEY = "vault.authorization";
const AUTHORIZATION_POLL_INTERVAL_MS = 800;
const VAULT_VIEW_QUERY = "view=vault";

function vaultViewUrl(path) {
  return `${path}${path.includes("?") ? "&" : "?"}${VAULT_VIEW_QUERY}`;
}

function siteAuthPath(siteId) {
  if (!getVaultSiteDefinition(siteId)) throw new TypeError("授权目标无效");
  return `${VAULT_ENDPOINTS.status}/${encodeURIComponent(siteId)}`;
}

function sameSession(left, right) {
  return Boolean(left && right && left.site === right.site && left.kind === right.kind &&
    left.sessionId === right.sessionId);
}

export function createVaultController(context, {
  createView = createVaultView,
} = {}) {
  const { root, api, store, polling, dialogs } = context;
  const view = createView(context);
  if (!view || typeof view !== "object") throw new TypeError("授权视图无效");
  let active = false;
  let destroyed = false;
  let busy = "";
  const requestGate = createVaultRequestGate();
  let operationSequence = 0;
  let activeSession = null;
  let activeOperationController = null;
  let statusRead = null;
  let siteRead = null;
  let sessionRead = null;

  const linkSignal = (externalSignal, controller) => {
    if (!externalSignal) return () => {};
    const abort = () => controller.abort();
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
    return () => externalSignal.removeEventListener("abort", abort);
  };

  const abortRead = (entry) => entry?.controller.abort();

  const stopAuthorizationPolling = () => {
    polling.stop(AUTHORIZATION_POLL_KEY);
  };

  const syncAuthorizationPolling = () => {
    const selectedSite = view.selectedSite?.() || "";
    if (
      !active || destroyed || !activeSession ||
      (selectedSite && selectedSite !== activeSession.site)
    ) {
      stopAuthorizationPolling();
      return;
    }
    polling.start({
      key: AUTHORIZATION_POLL_KEY,
      scope: context.pollingScope,
      intervalMs: AUTHORIZATION_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      alwaysFocusRate: true,
      resume: "immediate",
      task(signal) {
        if (busy || !activeSession) return Promise.resolve(false);
        return pollActiveSession(signal);
      },
    });
  };

  const applySnapshot = (payload) => {
    const action = actionCreators.authStatusReceived(payload);
    const selectedSite = view.selectedSite?.() || "";
    const reference = extractVaultSessionFromSnapshot(payload, selectedSite);
    store.dispatch(action);
    if (reference && (!selectedSite || reference.site === selectedSite)) {
      activeSession = reference;
    } else if (!activeSession || !selectedSite || activeSession.site === selectedSite) {
      activeSession = null;
    }
    syncAuthorizationPolling();
  };

  const applySiteStatus = (payload, { syncPolling = true } = {}) => {
    const status = payload?.status && typeof payload.status === "object" ? payload.status : payload;
    store.dispatch(actionCreators.authSiteStatusReceived(status));
    const reference = extractVaultSessionReference(payload);
    const selectedSite = view.selectedSite?.() || "";
    if (reference && (!selectedSite || reference.site === selectedSite)) {
      activeSession = reference;
    } else if (!activeSession || !selectedSite || activeSession.site === status?.site) {
      activeSession = null;
    }
    if (syncPolling) syncAuthorizationPolling();
  };

  const readStatus = async (externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (statusRead) {
      if (!replace) return statusRead.promise;
      const replaced = statusRead;
      abortRead(replaced);
      if (!replaced.controller.signal.aborted) {
        try {
          await replaced.promise;
        } catch {
          // 被替换的读取由原调用方处理。
        }
      }
      if (!active || destroyed || statusRead !== replaced) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead("status");
    const promise = api.get(vaultViewUrl(VAULT_ENDPOINTS.status), { signal: controller.signal })
      .then((payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          !requestGate.isReadCurrent(ticket)
        ) return false;
        applySnapshot(payload);
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && (report || store.getState().auth.bySite.size === 0)) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (statusRead?.promise === promise) statusRead = null;
      });
    statusRead = { controller, promise };
    return promise;
  };

  const readSite = async (siteId, externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed || !getVaultSiteDefinition(siteId)) return false;
    if (siteRead) {
      if (!replace && siteRead.siteId === siteId) return siteRead.promise;
      const replaced = siteRead;
      abortRead(replaced);
      if (!replaced.controller.signal.aborted) {
        try {
          await replaced.promise;
        } catch {
          // 被替换的站点读取由原调用方处理。
        }
      }
      if (!active || destroyed || siteRead !== replaced) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead("site");
    const promise = api.get(vaultViewUrl(siteAuthPath(siteId)), {
      signal: controller.signal,
    })
      .then((payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          !requestGate.isReadCurrent(ticket) ||
          (view.selectedSite?.() && view.selectedSite() !== siteId)
        ) return false;
        applySiteStatus(payload);
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (siteRead?.promise === promise) siteRead = null;
      });
    siteRead = { controller, promise, siteId };
    return promise;
  };

  const pollActiveSession = async (externalSignal) => {
    if (!active || destroyed || !activeSession) return false;
    if (sessionRead) return sessionRead.promise;
    const reference = activeSession;
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead("session");
    const path = reference.kind === "oauth"
      ? `${siteAuthPath("pixiv")}`
      : `${siteAuthPath(reference.site)}/login/${encodeURIComponent(reference.sessionId)}`;
    const promise = api.get(vaultViewUrl(path), { signal: controller.signal })
      .then(async (payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          !requestGate.isReadCurrent(ticket) || !sameSession(reference, activeSession)
        ) return false;
        applySiteStatus(payload, { syncPolling: false });
        if (!activeSession && active && !destroyed) {
          requestGate.beginWrite();
          stopAuthorizationPolling();
          view.setOperationMessage("授权会话已结束，正在确认站点与完整授权状态。");
          await Promise.allSettled([
            readStatus(null, { replace: true, report: false }),
            readSite(reference.site, null, { report: false }),
          ]);
        } else {
          syncAuthorizationPolling();
        }
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (sessionRead?.promise === promise) sessionRead = null;
      });
    sessionRead = { controller, promise };
    return promise;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const invalidateReadsForWrite = () => {
    const ticket = requestGate.beginWrite();
    abortRead(statusRead);
    abortRead(siteRead);
    abortRead(sessionRead);
    return ticket;
  };

  const processOperationPayload = (payload) => {
    const reference = extractVaultSessionReference(payload);
    if (reference) activeSession = reference;
    if (payload?.status || payload?.site) {
      try {
        applySiteStatus(payload);
      } catch {
        // 写后统一安全快照刷新负责最终校验；不采用异常局部响应。
      }
    }
  };

  const runOperation = async ({
    kind,
    request = null,
    successMessage,
    writes = true,
    processPayload = false,
    rereadSite = "",
  }) => {
    if (!active || destroyed || busy) return false;
    const operation = ++operationSequence;
    const writeTicket = writes ? invalidateReadsForWrite() : null;
    if (!writes) {
      abortRead(statusRead);
      abortRead(siteRead);
      abortRead(sessionRead);
    }
    view.clearError();
    setBusy(kind);
    view.setWorkspacePhase?.(writes ? "writing" : "loading");
    view.setOperationMessage(
      kind === "refresh"
        ? "正在刷新授权状态……"
        : "正在执行授权操作，请勿重复提交……",
    );
    const controller = new AbortController();
    activeOperationController = controller;
    const isCurrent = () => Boolean(
      active && !destroyed && !controller.signal.aborted &&
      (!writeTicket || requestGate.isWriteCurrent(writeTicket))
    );
    const refreshAuthoritative = async () => {
      const outcomes = await Promise.allSettled([
        readStatus(null, { replace: true, report: false }),
        ...(rereadSite ? [readSite(rereadSite, null, { replace: true, report: false })] : []),
      ]);
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      const incomplete = outcomes.filter((outcome) =>
        outcome.status === "fulfilled" && outcome.value !== true);
      if (rejected.length === outcomes.length) throw rejected[0].reason;
      if (rejected.length || incomplete.length) view.setWorkspacePhase?.("partial");
      return rejected.length === 0 && incomplete.length === 0;
    };
    try {
      const payload = request ? await request(controller.signal) : null;
      if (!isCurrent()) return false;
      if (processPayload && payload) processOperationPayload(payload);
      const complete = await refreshAuthoritative();
      if (!isCurrent()) return false;
      view.clearError();
      view.setWorkspacePhase?.(complete ? "idle" : "partial");
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      try {
        await refreshAuthoritative();
      } catch {
        // 保留原操作错误，失败刷新不能覆盖受控指引。
      }
      view.showError(error);
      view.setWorkspacePhase?.(store.getState().auth.bySite.size ? "partial" : "error");
      view.setOperationMessage("操作失败，其他站点的上次状态已保留。请刷新后重试。");
      return false;
    } finally {
      view.clearSensitiveInputs();
      if (activeOperationController === controller) activeOperationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const runProxySecretOperation = async () => {
    const input = view.elements.proxyInput;
    let secret = input.value;
    let payload = null;
    let capturedPayload = null;
    input.value = "";
    try {
      payload = buildAuthorizationProxyPayload(secret);
      capturedPayload = payload;
      secret = "";
      payload = null;
      return await runOperation({
        kind: "proxy-save",
        request: (signal) => {
          try {
            return api.put(vaultViewUrl(VAULT_ENDPOINTS.proxy), capturedPayload, { signal });
          } finally {
            // context.api 已同步完成 JSON 序列化；不要让局部原始输入等待权威重读。
            capturedPayload = null;
          }
        },
        rereadSite: view.selectedSite?.() || "",
        successMessage: "登录代理设置已保存。",
      });
    } catch (error) {
      if (active && !busy) {
        view.showError({
          code: "invalid_authorization_proxy",
          status: 422,
          requestId: "",
          details: null,
        });
        view.setOperationMessage("登录代理地址格式无效，请修正后重试。");
      }
      return false;
    } finally {
      secret = "";
      payload = null;
      capturedPayload = null;
      input.value = "";
      view.clearSensitiveInputs();
    }
  };

  const confirm = async (options) => {
    // 对话框期间暂停会重建目标卡片的会话轮询，确保关闭后焦点返回原触发按钮。
    const lifecycle = requestGate.currentLifecycle();
    abortRead(sessionRead);
    stopAuthorizationPolling();
    const choice = await dialogs.open(options);
    view.clearSensitiveInputs();
    if (
      !active || destroyed || requestGate.currentLifecycle() !== lifecycle
    ) return false;
    syncAuthorizationPolling();
    if (choice !== "confirm") {
      view.setOperationMessage("已取消操作，敏感输入已清空，授权状态未改变。");
      return false;
    }
    return true;
  };

  const authorizeSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    if (!definition?.authorizeAction) return;
    const path = siteId === "pixiv"
      ? VAULT_ENDPOINTS.pixivOAuthStart
      : `${siteAuthPath(siteId)}/login/start`;
    await runOperation({
      kind: `authorize:${siteId}`,
      request: (signal) => api.post(vaultViewUrl(path), undefined, { signal }),
      processPayload: true,
      rereadSite: siteId,
      successMessage: `${definition.label} 授权已开始，请在打开的浏览器中完成登录。`,
    });
  };

  const cancelSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    const reference = activeSession;
    if (!definition || !reference || reference.site !== siteId) return;
    if (!await confirm({
      title: `关闭 ${definition.label} 授权标签页？`,
      message: "这会取消本次浏览器授权，不会删除此前已保存的站点凭证。",
      confirmLabel: "关闭授权标签页",
      dangerous: true,
      confirmationText: "关闭后可重新开始，正在运行的采集任务不会自动取消。",
    })) return;
    const path = reference.kind === "oauth"
      ? VAULT_ENDPOINTS.pixivOAuthSession
      : `${siteAuthPath(siteId)}/login/${encodeURIComponent(reference.sessionId)}`;
    await runOperation({
      kind: `cancel:${siteId}`,
      request: (signal) => api.delete(vaultViewUrl(path), { signal }),
      processPayload: true,
      rereadSite: siteId,
      successMessage: `${definition.label} 授权标签页已关闭，已保存凭证保持不变。`,
    });
  };

  const clearSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    if (!definition || definition.method === "anonymous") return;
    if (!await confirm({
      title: `删除 ${definition.label} 站点凭证？`,
      message: "这会删除服务保存的单站 Cookie 或 Token；授权浏览器数据将继续保留。",
      confirmLabel: "删除站点凭证",
      dangerous: true,
      confirmationText: "运行中的任务不会自动取消；确认删除后才会更新状态。",
    })) return;
    await runOperation({
      kind: `clear:${siteId}`,
      request: (signal) => api.delete(vaultViewUrl(siteAuthPath(siteId)), { signal }),
      processPayload: true,
      rereadSite: siteId,
      successMessage: `${definition.label} 站点凭证已删除，授权浏览器数据保持不变。`,
    });
  };

  const clearProfile = async () => {
    if (!await confirm({
      title: "清除授权浏览器数据？",
      message: "这会关闭活动授权，并删除 X、Pixiv 和 EH 共用的授权浏览器登录数据。",
      confirmLabel: "清除授权浏览器数据",
      dangerous: true,
      confirmationText: "各站点已保存的 Cookie 或 Token 不会被删除，运行中的任务不会被强制中断。",
    })) return;
    await runOperation({
      kind: "profile-clear",
      request: (signal) => api.delete(vaultViewUrl(VAULT_ENDPOINTS.browserProfile), { signal }),
      rereadSite: view.selectedSite?.() || "",
      successMessage: "授权浏览器数据已清除，各站点已保存凭证保持不变。",
    });
  };

  const resetProxy = async () => {
    if (!await confirm({
      title: "恢复登录代理默认设置？",
      message: "这会删除授权管理中保存的登录代理设置，并恢复配置文件默认值。",
      confirmLabel: "恢复默认设置",
      dangerous: true,
      confirmationText: "仅影响后续浏览器授权，不会修改代理管理中的采集代理池。",
    })) return;
    await runOperation({
      kind: "proxy-reset",
      request: (signal) => api.delete(vaultViewUrl(VAULT_ENDPOINTS.proxy), { signal }),
      rereadSite: view.selectedSite?.() || "",
      successMessage: "登录代理已恢复默认设置，授权状态已刷新。",
    });
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-vault-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.vaultAction || "";
    if (action === "refresh") {
      await runOperation({
        kind: "refresh",
        writes: false,
        rereadSite: view.selectedSite?.() || "",
        successMessage: "站点授权、授权浏览器数据和登录代理状态已刷新。",
      });
      return;
    }
    if (action === "site:danbooru" || action === "site:twitter" || action === "site:pixiv" ||
        action === "site:exhentai" || action === "site:pawchive") {
      const siteId = action.slice("site:".length);
      view.clearSensitiveInputs();
      requestGate.beginWrite();
      abortRead(statusRead);
      abortRead(siteRead);
      abortRead(sessionRead);
      activeSession = null;
      stopAuthorizationPolling();
      view.selectSite?.(siteId, { focus: true });
      view.setWorkspacePhase?.("loading");
      const outcomes = await Promise.allSettled([
        readStatus(null, { replace: true, report: false }),
        readSite(siteId, null, { replace: true, report: true }),
      ]);
      if (active && !destroyed) {
        const failed = outcomes.some((outcome) =>
          outcome.status === "rejected" || outcome.value !== true);
        view.setWorkspacePhase?.(failed ? "partial" : "idle");
      }
      return;
    }
    if (action === "profile-clear") {
      await clearProfile();
      return;
    }
    if (action === "proxy-reset") {
      await resetProxy();
      return;
    }
    const separator = action.indexOf(":");
    if (separator < 1) return;
    const kind = action.slice(0, separator);
    const siteId = action.slice(separator + 1);
    if (!getVaultSiteDefinition(siteId)) return;
    if (kind === "authorize") await authorizeSite(siteId);
    else if (kind === "cancel") await cancelSite(siteId);
    else if (kind === "clear") await clearSite(siteId);
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.proxyForm) return;
    event.preventDefault();
    if (busy) {
      view.clearSensitiveInputs();
      return;
    }
    if (!view.validateProxyInput({ announce: true })) {
      view.clearSensitiveInputs();
      view.showError({ code: "invalid_authorization_proxy", status: 422, requestId: "" });
      return;
    }
    const isDirect = view.elements.proxyInput.value.trim() === "";
    const currentProxy = store.getState().auth.authorizationProxy;
    if (isDirect && currentProxy?.configured && !await confirm({
      title: "将登录代理改为直连？",
      message: "留空保存表示始终直连，而不是恢复配置文件默认值。",
      confirmLabel: "保存为直连",
      dangerous: true,
      confirmationText: "只影响下一次授权浏览器和 Pixiv Token 交换。",
    })) return;
    await runProxySecretOperation();
  };

  const onInput = (event) => {
    if (event.target === view.elements.proxyInput) view.validateProxyInput({ announce: true });
  };

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.clearSensitiveInputs();
      view.setWorkspacePhase?.("loading");
      view.setOperationMessage("正在加载授权状态……");
      void readStatus(null, { replace: true, report: true })
        .then((loaded) => {
          if (loaded && active) {
            view.setWorkspacePhase?.("idle");
            view.setOperationMessage("授权状态已加载，可随时刷新。");
          }
        })
        .catch(() => {});
    },

    deactivate() {
      if (destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      activeOperationController?.abort();
      activeOperationController = null;
      abortRead(statusRead);
      abortRead(siteRead);
      abortRead(sessionRead);
      activeSession = null;
      stopAuthorizationPolling();
      view.clearSensitiveInputs();
      busy = "";
      view.setBusy("");
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },

    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      activeOperationController?.abort();
      abortRead(statusRead);
      abortRead(siteRead);
      abortRead(sessionRead);
      activeSession = null;
      stopAuthorizationPolling();
      view.clearSensitiveInputs();
      root.removeEventListener("click", onClick);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("input", onInput);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("VAULT.CPL 已挂载");
    controller = createVaultController(context);
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
