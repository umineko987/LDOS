import {
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  getPolicySiteDefinition,
  policyErrorPresentation,
  validatePolicyDraft,
  type PolicyDraft,
  type PolicySiteId,
} from "./model";
import type { PolicyService } from "./service";
import type { PolicyStore } from "./state";

export interface PolicyController {
  activate(): void;
  deactivate(): void;
  refresh(): Promise<boolean>;
  selectSite(site: PolicySiteId): boolean;
  requestDiscardSite(site: PolicySiteId): boolean;
  save(site: PolicySiteId, draft: PolicyDraft): Promise<boolean>;
  requestReset(site: PolicySiteId): boolean;
  confirmAction(confirmed: boolean): Promise<boolean>;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

const CONFIRMATION_COPY = Object.freeze({
  reset: Object.freeze({
    title: "恢复站点默认设置？",
    message: "将删除当前站点的自定义四字段设置，并恢复服务默认值。",
    confirmLabel: "恢复默认设置",
    warning: "已创建、排队或运行中的任务不受影响。",
  }),
  "discard-site": Object.freeze({
    title: "放弃未保存的更改？",
    message: "当前站点有未保存的更改，切换站点后将丢失。",
    confirmLabel: "放弃更改并切换",
    warning: "已保存的设置和运行中的任务不受影响。",
  }),
});

export function createPolicyController({ store, service }: { readonly store: PolicyStore; readonly service: PolicyService }): PolicyController {
  const gate = createPolicyRequestGate();
  let active = false;
  let destroyed = false;
  let version = 0;
  let readController: AbortController | null = null;
  let operationController: AbortController | null = null;

  const readAuthority = async (message: string, phase: "idle" | "saved" = "idle", error: unknown | null = null): Promise<boolean> => {
    readController?.abort();
    const controller = new AbortController();
    const current = ++version;
    const ticket = gate.beginRead();
    readController = controller;
    try {
      const snapshot = await service.read(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isReadCurrent(ticket)) return false;
      store.commitSnapshot(snapshot, {
        phase: error ? "error" : phase,
        error: error ? policyErrorPresentation(error) : null,
        message,
      });
      return true;
    } catch (readError) {
      if (isAbortError(readError) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(policyErrorPresentation(error ?? readError));
      return false;
    } finally {
      if (readController === controller) readController = null;
    }
  };

  const runWrite = async (operation: "save" | "reset", write: (signal: AbortSignal) => Promise<void>, successMessage: string): Promise<boolean> => {
    if (!active || destroyed || !store.beginWrite(operation)) return false;
    readController?.abort();
    operationController?.abort();
    const controller = new AbortController();
    const current = ++version;
    const ticket = gate.beginWrite();
    operationController = controller;
    let writeError: unknown = null;
    try {
      try {
        await write(controller.signal);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) return false;
        writeError = error;
      }
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isWriteCurrent(ticket)) return false;
      const snapshot = await service.read(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version || !gate.isWriteCurrent(ticket)) return false;
      store.commitSnapshot(snapshot, {
        phase: writeError ? "error" : "saved",
        error: writeError ? policyErrorPresentation(writeError) : null,
        message: writeError ? "权威设置已刷新；原操作未成功，草稿仍保留。" : successMessage,
      });
      return writeError === null;
    } catch (readError) {
      if (isAbortError(readError) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(policyErrorPresentation(writeError ?? readError));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  const controller: PolicyController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      gate.advanceLifecycle();
      store.setPhase("loading", "正在加载站点设置……");
      void readAuthority("站点设置已加载。", "idle");
    },
    deactivate() {
      if (!active || destroyed) return;
      active = false;
      gate.advanceLifecycle();
      version += 1;
      readController?.abort();
      operationController?.abort();
      readController = null;
      operationController = null;
      store.clearConfirmation();
      store.setPhase(store.getState().snapshot ? "idle" : "loading");
    },
    refresh() {
      if (!active || destroyed || !store.beginLoad()) return Promise.resolve(false);
      return readAuthority("站点设置已刷新。", "idle");
    },
    selectSite(site) {
      if (!getPolicySiteDefinition(site)) return false;
      return store.selectSite(site);
    },
    requestDiscardSite(site) {
      if (!active || destroyed || !getPolicySiteDefinition(site) || store.getState().busy) return false;
      return store.requestConfirmation({ action: "discard-site", site, ...CONFIRMATION_COPY["discard-site"] });
    },
    save(site, draft) {
      const validation = validatePolicyDraft(draft);
      if (!validation.valid || !validation.payload) {
        store.setMessage("请修正标记项后再保存；请求尚未发送。");
        return Promise.resolve(false);
      }
      return runWrite("save", (signal) => service.save(site, draft, signal), "设置已保存，将用于新建任务。");
    },
    requestReset(site) {
      const item = store.getState().snapshot?.sites[site];
      if (!active || destroyed || !item?.hasOverride || store.getState().busy) return false;
      return store.requestConfirmation({ action: "reset", site, ...CONFIRMATION_COPY.reset });
    },
    confirmAction(confirmed) {
      const confirmation = store.getState().confirmation;
      store.clearConfirmation();
      if (!confirmation || !confirmed) {
        store.setMessage("已取消操作，站点设置未改变。");
        return Promise.resolve(false);
      }
      if (confirmation.action === "discard-site") {
        store.selectSite(confirmation.site);
        store.setMessage("已放弃未保存的更改并切换站点。");
        return Promise.resolve(true);
      }
      return runWrite("reset", (signal) => service.reset(confirmation.site, signal), "该站点已恢复默认设置。");
    },
    destroy() {
      if (destroyed) return;
      if (active) controller.deactivate();
      destroyed = true;
      gate.advanceLifecycle();
      version += 1;
      readController?.abort();
      operationController?.abort();
      readController = null;
      operationController = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}

export { buildPolicyPayload, derivePolicyControls };
