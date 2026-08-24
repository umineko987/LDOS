import type { PollingHandle, PollingService } from "../../core/polling/service";
import {
  AUTHORIZATION_POLL_INTERVAL_MS,
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  deriveVaultControls,
  getVaultSiteDefinition,
  mergeVaultSite,
  validateAuthorizationProxyInput,
  vaultErrorPresentation,
  type VaultSessionReference,
  type VaultSiteId,
  type VaultSnapshot,
} from "./model";
import type { VaultService } from "./service";
import {
  type VaultConfirmation,
  type VaultConfirmedAction,
  type VaultOperation,
  type VaultStore,
} from "./state";

const VAULT_SCOPE = "app:vault";
export const AUTHORIZATION_POLL_KEY = "vault.authorization";

interface AuthorityResult {
  readonly snapshot: VaultSnapshot;
  readonly session: VaultSessionReference | null;
  readonly complete: boolean;
  readonly error: unknown | null;
}

interface PendingConfirmation {
  readonly action: VaultConfirmedAction;
  readonly site: VaultSiteId | "";
}

export interface VaultController {
  activate(): void;
  deactivate(): void;
  refresh(): Promise<boolean>;
  selectSite(site: VaultSiteId): Promise<boolean>;
  authorize(site: VaultSiteId): Promise<boolean>;
  saveProxy(value: string): Promise<boolean>;
  requestCancel(site: VaultSiteId): boolean;
  requestClearSite(site: VaultSiteId): boolean;
  requestClearProfile(): boolean;
  requestResetProxy(): boolean;
  confirmAction(confirmed: boolean): Promise<boolean>;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function sameSession(left: VaultSessionReference | null, right: VaultSessionReference | null): boolean {
  return Boolean(left && right && left.site === right.site && left.kind === right.kind && left.sessionId === right.sessionId);
}

const CONFIRMATION_COPY: Readonly<Record<VaultConfirmedAction, (site: VaultSiteId | "") => Omit<VaultConfirmation, "action" | "site">>> = Object.freeze({
  "cancel-site": (site) => Object.freeze({
    title: `关闭 ${getVaultSiteDefinition(site)?.label ?? "站点"} 授权标签页？`,
    message: "这会取消本次浏览器授权，不会删除此前已保存的站点凭证。",
    confirmLabel: "关闭授权标签页",
    warning: "关闭后可重新开始，正在运行的采集任务不会自动取消。",
  }),
  "clear-site": (site) => Object.freeze({
    title: `删除 ${getVaultSiteDefinition(site)?.label ?? "站点"} 站点凭证？`,
    message: "这会删除服务保存的单站 Cookie 或 Token；授权浏览器数据将继续保留。",
    confirmLabel: "删除站点凭证",
    warning: "运行中的任务不会自动取消；确认删除后才会更新状态。",
  }),
  "profile-clear": () => Object.freeze({
    title: "清除共享授权浏览器数据？",
    message: "这会关闭活动授权，并删除 X、Pixiv 和 EH 共用的授权浏览器登录数据。",
    confirmLabel: "清除授权浏览器数据",
    warning: "各站点已保存的 Cookie 或 Token 不会被删除，运行中的任务不会被强制中断。",
  }),
  "proxy-reset": () => Object.freeze({
    title: "恢复登录代理默认设置？",
    message: "这会删除授权管理中保存的登录代理设置，并恢复配置文件默认值。",
    confirmLabel: "恢复默认设置",
    warning: "仅影响后续浏览器授权，不会修改代理管理中的采集代理池。",
  }),
  "proxy-direct": () => Object.freeze({
    title: "将登录代理改为直连？",
    message: "留空保存表示始终直连，而不是恢复配置文件默认值。",
    confirmLabel: "保存为直连",
    warning: "只影响下一次授权浏览器和 Pixiv Token 交换。",
  }),
});

export function createVaultController({
  store,
  service,
  polling,
}: {
  readonly store: VaultStore;
  readonly service: VaultService;
  readonly polling: PollingService;
}): VaultController {
  const gate = createVaultRequestGate();
  let active = false;
  let destroyed = false;
  let version = 0;
  let activeSession: VaultSessionReference | null = null;
  let statusController: AbortController | null = null;
  let siteController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let pollHandle: PollingHandle | null = null;
  let pending: PendingConfirmation | null = null;

  const stopAuthorizationPolling = (): void => {
    pollHandle?.stop();
    pollHandle = null;
    polling.stop(AUTHORIZATION_POLL_KEY);
  };

  const abortReads = (): void => {
    statusController?.abort();
    siteController?.abort();
    statusController = null;
    siteController = null;
  };

  const selectedSession = (reference: VaultSessionReference | null, site = store.getState().selectedSite): VaultSessionReference | null => (
    reference?.site === site ? reference : null
  );

  const readAuthorityPayload = async (site: VaultSiteId, signal: AbortSignal): Promise<AuthorityResult> => {
    const statusTicket = gate.beginRead("status");
    const siteTicket = gate.beginRead("site");
    const outcomes = await Promise.allSettled([
      service.readStatus(signal),
      service.readSite(site, signal),
    ] as const);
    const full = outcomes[0].status === "fulfilled" && gate.isReadCurrent(statusTicket) ? outcomes[0].value : null;
    const siteRead = outcomes[1].status === "fulfilled" && gate.isReadCurrent(siteTicket) ? outcomes[1].value : null;
    if (!full && !siteRead) {
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      throw rejected?.reason ?? new TypeError("invalid_vault_authority");
    }
    let snapshot = full?.snapshot ?? store.getState().snapshot;
    if (siteRead) snapshot = mergeVaultSite(snapshot, siteRead.status);
    if (!snapshot) throw new TypeError("invalid_vault_authority");
    const error = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")?.reason ?? null;
    return Object.freeze({
      snapshot,
      session: siteRead ? siteRead.session : selectedSession(full?.session ?? null, site),
      complete: outcomes.every((outcome) => outcome.status === "fulfilled"),
      error,
    });
  };

  const commitAuthority = (authority: AuthorityResult, message: string, operationError: unknown | null = null): boolean => {
    activeSession = selectedSession(authority.session);
    const error = operationError ?? authority.error;
    const committed = store.commitSnapshot(authority.snapshot, {
      phase: error || !authority.complete ? "partial" : "idle",
      error: error ? vaultErrorPresentation(error) : null,
      message,
    });
    syncAuthorizationPolling();
    return committed;
  };

  const readInitialStatus = async (): Promise<boolean> => {
    statusController?.abort();
    const controller = new AbortController();
    const ticket = gate.beginRead("status");
    const current = ++version;
    statusController = controller;
    try {
      const result = await service.readStatus(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isReadCurrent(ticket)) return false;
      activeSession = selectedSession(result.session);
      const committed = store.commitSnapshot(result.snapshot, { message: "授权状态已加载，可随时刷新。" });
      syncAuthorizationPolling();
      return committed;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(vaultErrorPresentation(error));
      return false;
    } finally {
      if (statusController === controller) statusController = null;
    }
  };

  const refreshAuthority = async (site: VaultSiteId, message: string): Promise<boolean> => {
    abortReads();
    operationController?.abort();
    const controller = new AbortController();
    const current = ++version;
    const writeTicket = gate.beginWrite();
    operationController = controller;
    try {
      const authority = await readAuthorityPayload(site, controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isWriteCurrent(writeTicket)) return false;
      return commitAuthority(authority, message);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(vaultErrorPresentation(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  const runWrite = async (
    operation: VaultOperation,
    site: VaultSiteId,
    write: (signal: AbortSignal) => Promise<unknown>,
    successMessage: string,
  ): Promise<boolean> => {
    if (!active || destroyed || !store.beginWrite(operation)) return false;
    stopAuthorizationPolling();
    abortReads();
    operationController?.abort();
    const controller = new AbortController();
    const current = ++version;
    const writeTicket = gate.beginWrite();
    operationController = controller;
    const clearOperation = (): void => {
      if (operationController === controller) operationController = null;
    };
    let writeError: unknown = null;
    try {
      await write(controller.signal);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) {
        clearOperation();
        return false;
      }
      writeError = error;
    }
    if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isWriteCurrent(writeTicket)) {
      clearOperation();
      return false;
    }
    try {
      const authority = await readAuthorityPayload(site, controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isWriteCurrent(writeTicket)) return false;
      commitAuthority(
        authority,
        writeError ? "权威授权状态已刷新；原操作未成功。" : successMessage,
        writeError,
      );
      return writeError === null && authority.complete;
    } catch (readError) {
      if (isAbortError(readError) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(vaultErrorPresentation(writeError ?? readError));
      return false;
    } finally {
      clearOperation();
    }
  };

  const pollCompletedSession = (site: VaultSiteId): void => {
    stopAuthorizationPolling();
    activeSession = null;
    store.setMessage("授权会话已结束，正在确认站点与完整授权状态。");
    void refreshAuthority(site, "授权会话已结束，站点与完整授权状态已确认。");
  };

  function syncAuthorizationPolling(): void {
    const selected = store.getState().selectedSite;
    if (!active || destroyed || !activeSession || activeSession.site !== selected) {
      stopAuthorizationPolling();
      return;
    }
    pollHandle = polling.start({
      key: AUTHORIZATION_POLL_KEY,
      scope: VAULT_SCOPE,
      intervalMs: AUTHORIZATION_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      alwaysFocusRate: true,
      task: async (signal) => {
        const reference = activeSession;
        if (!reference || store.getState().busy) return null;
        const ticket = gate.beginRead("session");
        const result = await service.readSession(reference, signal);
        return Object.freeze({ reference, result, ticket });
      },
      onResult: (payload) => {
        if (!payload || !active || destroyed || !gate.isReadCurrent(payload.ticket) || !sameSession(payload.reference, activeSession)) return;
        store.commitSite(payload.result.status, { clearBusy: false, message: `${payload.result.status.label} 授权会话状态已更新。` });
        activeSession = selectedSession(payload.result.session);
        if (!activeSession) pollCompletedSession(payload.reference.site);
      },
      onError: (error) => {
        if (active && !destroyed) store.fail(vaultErrorPresentation(error), "授权会话轮询失败；已加载状态继续保留。请手动刷新。");
      },
    });
  }

  const requestConfirmation = (action: VaultConfirmedAction, site: VaultSiteId | "" = ""): boolean => {
    if (pending || (site && !getVaultSiteDefinition(site))) return false;
    const requested = store.requestConfirmation({ action, site, ...CONFIRMATION_COPY[action](site) });
    if (!requested) return false;
    pending = Object.freeze({ action, site });
    stopAuthorizationPolling();
    return true;
  };

  const confirmedOperation = (choice: PendingConfirmation): Promise<boolean> => {
    const selected = store.getState().selectedSite;
    if (choice.action === "cancel-site") {
      const reference = activeSession;
      if (!reference || reference.site !== choice.site) return Promise.resolve(false);
      return runWrite(`cancel:${reference.site}`, reference.site, (signal) => service.cancel(reference, signal), `${getVaultSiteDefinition(reference.site)!.label} 授权标签页已关闭。`);
    }
    if (choice.action === "clear-site" && choice.site) {
      return runWrite(`clear:${choice.site}`, choice.site, (signal) => service.clearSite(choice.site as VaultSiteId, signal), `${getVaultSiteDefinition(choice.site)!.label} 站点凭证已删除。`);
    }
    if (choice.action === "profile-clear") {
      return runWrite("profile-clear", selected, (signal) => service.clearProfile(signal), "共享授权浏览器数据已清除，站点凭证保持不变。");
    }
    if (choice.action === "proxy-reset") {
      return runWrite("proxy-reset", selected, (signal) => service.resetProxy(signal), "登录代理已恢复配置文件默认值。");
    }
    if (choice.action === "proxy-direct") {
      return runWrite("proxy-save", selected, (signal) => service.saveProxy("", signal), "登录代理已保存为直连。");
    }
    return Promise.resolve(false);
  };

  const controller: VaultController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      gate.advanceLifecycle();
      void readInitialStatus();
    },
    deactivate() {
      if (!active || destroyed) return;
      active = false;
      gate.advanceLifecycle();
      version += 1;
      pending = null;
      activeSession = null;
      stopAuthorizationPolling();
      polling.stopScope(VAULT_SCOPE);
      abortReads();
      operationController?.abort();
      operationController = null;
      store.clearConfirmation();
    },
    async refresh() {
      if (!active || destroyed || !store.beginLoad()) return false;
      stopAuthorizationPolling();
      return refreshAuthority(store.getState().selectedSite, "站点、共享授权浏览器和登录代理状态已刷新。");
    },
    async selectSite(site) {
      if (!active || destroyed || !store.selectSite(site)) return false;
      activeSession = null;
      stopAuthorizationPolling();
      return refreshAuthority(site, `${getVaultSiteDefinition(site)!.label} 与完整授权状态已刷新。`);
    },
    authorize(site) {
      if (!getVaultSiteDefinition(site)?.authorizeAction) return Promise.resolve(false);
      return runWrite(`authorize:${site}`, site, (signal) => service.authorize(site, signal), `${getVaultSiteDefinition(site)!.label} 授权已开始，请在授权浏览器中完成登录。`);
    },
    async saveProxy(value) {
      const validation = validateAuthorizationProxyInput(value);
      if (!validation.valid) {
        store.setMessage(`${validation.error} 敏感输入已清空，未发送请求。`);
        return false;
      }
      if (validation.mode === "direct" && store.getState().snapshot?.authorizationProxy?.configured) {
        requestConfirmation("proxy-direct");
        return false;
      }
      let transient = buildAuthorizationProxyPayload(value).proxy_url;
      return runWrite("proxy-save", store.getState().selectedSite, (signal) => {
        const request = service.saveProxy(transient, signal);
        transient = "";
        return request;
      }, validation.mode === "direct" ? "登录代理已保存为直连。" : "登录代理设置已保存。");
    },
    requestCancel(site) {
      return Boolean(activeSession?.site === site && requestConfirmation("cancel-site", site));
    },
    requestClearSite(site) {
      const status = store.getState().snapshot?.sites[site];
      return Boolean(status?.capabilities.clear && status.configured && !status.session.active && requestConfirmation("clear-site", site));
    },
    requestClearProfile() {
      const controls = deriveVaultControls(store.getState().snapshot, { busy: store.getState().busy });
      return !controls.profileClear.disabled && requestConfirmation("profile-clear");
    },
    requestResetProxy() {
      const controls = deriveVaultControls(store.getState().snapshot, { busy: store.getState().busy });
      return !controls.proxyReset.disabled && requestConfirmation("proxy-reset");
    },
    async confirmAction(confirmed) {
      const choice = pending;
      pending = null;
      store.clearConfirmation();
      if (!choice || !confirmed) {
        store.setMessage("已取消操作，敏感输入已清空，授权状态未改变。");
        syncAuthorizationPolling();
        return false;
      }
      return confirmedOperation(choice);
    },
    destroy() {
      if (destroyed) return;
      if (active) controller.deactivate();
      destroyed = true;
      gate.advanceLifecycle();
      version += 1;
      pending = null;
      activeSession = null;
      stopAuthorizationPolling();
      polling.stopScope(VAULT_SCOPE);
      abortReads();
      operationController?.abort();
      operationController = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
