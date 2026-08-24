import type { PollingHandle, PollingService } from "../../core/polling/service";
import {
  PROXY_STATUS_POLL_INTERVAL_MS,
  proxyErrorPresentation,
  validateInlineNodeInput,
  validateNodeFileInput,
  validateSubscriptionInput,
  type ProxyOperation,
} from "./model";
import type { ProxyDeleteAction, ProxyRuntimeAction, ProxyService } from "./service";
import type { ProxyConfirmedAction, ProxyConfirmation, ProxyStore } from "./state";

const PROXY_SCOPE = "app:proxy";
const STATUS_POLL_KEY = "proxy.status";

export interface ProxyController {
  activate(): void;
  refresh(): Promise<boolean>;
  runtime(action: ProxyRuntimeAction): Promise<boolean>;
  addSubscription(value: string): Promise<boolean>;
  replaceSubscription(id: string, value: string): Promise<boolean>;
  setNodeFile(value: string): Promise<boolean>;
  addInlineNodes(value: string): Promise<boolean>;
  replaceInlineNode(id: string, value: string): Promise<boolean>;
  requestRemove(action: ProxyConfirmedAction, id?: string): boolean;
  confirmRemove(confirmed: boolean): Promise<boolean>;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

const CONFIRMATION_COPY: Readonly<Record<ProxyConfirmedAction, Omit<ProxyConfirmation, "action" | "sourceId">>> = Object.freeze({
  "subscription-delete": Object.freeze({
    title: "删除订阅？",
    message: "将删除该订阅。运行中的代理池不会自动改变。",
    confirmLabel: "删除订阅",
    warning: "删除后点击“应用并重新加载”才会生效。",
  }),
  "inline-delete": Object.freeze({
    title: "删除手动节点？",
    message: "将删除该手动节点。运行中的代理池不会自动改变。",
    confirmLabel: "删除节点",
    warning: "删除后点击“应用并重新加载”才会生效。",
  }),
  "node-file-clear": Object.freeze({
    title: "清除节点文件？",
    message: "节点来源将不再引用当前文件；磁盘上的文件不会被删除。",
    confirmLabel: "清除引用",
    warning: "运行中的代理池保持不变，点击“应用并重新加载”后生效。",
  }),
  "override-reset": Object.freeze({
    title: "恢复配置文件中的节点来源？",
    message: "将删除界面保存的节点来源，并恢复配置文件默认值。",
    confirmLabel: "恢复默认设置",
    warning: "运行中的代理池不会自动改变；页面会继续显示待应用状态。",
  }),
});

export function createProxyController({
  store,
  service,
  polling,
}: {
  readonly store: ProxyStore;
  readonly service: ProxyService;
  readonly polling: PollingService;
}): ProxyController {
  let active = false;
  let destroyed = false;
  let version = 0;
  let statusGeneration = 0;
  let activeStatusGeneration = 0;
  let authorityController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let pollHandle: PollingHandle | null = null;
  let pendingRemove: Readonly<{ action: ProxyConfirmedAction; id: string }> | null = null;

  const readAuthority = async (message?: string): Promise<boolean> => {
    authorityController?.abort();
    const controller = new AbortController();
    const current = ++version;
    statusGeneration += 1;
    authorityController = controller;
    try {
      const authority = await service.readAuthority(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version) return false;
      statusGeneration += 1;
      return store.commitAuthority(authority.status, authority.sources, message);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      statusGeneration += 1;
      store.fail(proxyErrorPresentation(error));
      return false;
    } finally {
      if (authorityController === controller) authorityController = null;
    }
  };
  const readSources = async (message?: string): Promise<boolean> => {
    authorityController?.abort();
    const controller = new AbortController();
    const current = ++version;
    statusGeneration += 1;
    authorityController = controller;
    try {
      const sources = await service.readSources(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version) return false;
      return store.commitSources(sources, message);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      store.fail(proxyErrorPresentation(error));
      return false;
    } finally {
      if (authorityController === controller) authorityController = null;
    }
  };

  const runWrite = async (
    operation: ProxyOperation,
    write: (signal: AbortSignal) => Promise<void>,
    successMessage: string,
  ): Promise<boolean> => {
    if (!active || destroyed || !store.beginWrite(operation)) return false;
    version += 1;
    statusGeneration += 1;
    authorityController?.abort();
    operationController?.abort();
    const controller = new AbortController();
    const current = version;
    operationController = controller;
    let writeError: unknown = null;
    try {
      await write(controller.signal);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || current !== version) {
        if (operationController === controller) operationController = null;
        return false;
      }
      writeError = error;
    }
    if (!active || destroyed || controller.signal.aborted || current !== version) {
      if (operationController === controller) operationController = null;
      return false;
    }
    try {
      const authority = await service.readAuthority(controller.signal);
      if (!active || destroyed || controller.signal.aborted || current !== version) return false;
      statusGeneration += 1;
      if (writeError) {
        store.commitAuthority(
          authority.status,
          authority.sources,
          "权威状态已刷新；原操作未成功。",
          proxyErrorPresentation(writeError),
        );
        return false;
      }
      store.commitAuthority(authority.status, authority.sources, successMessage);
      return true;
    } catch (readError) {
      if (isAbortError(readError) || controller.signal.aborted || !active || destroyed || current !== version) return false;
      statusGeneration += 1;
      store.fail(proxyErrorPresentation(writeError ?? readError));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  const validSourceId = (action: ProxyConfirmedAction, id: string): boolean => {
    if (action === "subscription-delete") return /^sub_[0-9a-f]{64}$/.test(id);
    if (action === "inline-delete") return /^node_[0-9a-f]{64}$/.test(id);
    return id === "";
  };

  const requestRemove = (action: ProxyConfirmedAction, id = ""): boolean => {
    if (!validSourceId(action, id) || pendingRemove) return false;
    const requested = store.requestConfirmation({ action, sourceId: id, ...CONFIRMATION_COPY[action] });
    if (requested) pendingRemove = Object.freeze({ action, id });
    return requested;
  };

  const remove = async (pending: Readonly<{ action: ProxyConfirmedAction; id: string }>): Promise<boolean> => {
    const action: ProxyDeleteAction = pending.action === "subscription-delete"
      ? "subscription"
      : pending.action === "inline-delete"
        ? "inline"
        : pending.action === "node-file-clear"
          ? "node-file"
          : "override";
    const messages: Readonly<Record<ProxyConfirmedAction, string>> = Object.freeze({
      "subscription-delete": "订阅已删除；点击“应用并重新加载”后生效。",
      "inline-delete": "手动节点已删除；点击“应用并重新加载”后生效。",
      "node-file-clear": "节点文件引用已清除；点击“应用并重新加载”后生效。",
      "override-reset": "已恢复配置文件默认值；运行中的代理池尚未改变。",
    });
    return runWrite("source-write", (signal) => service.remove(action, pending.id, signal), messages[pending.action]);
  };

  const controller: ProxyController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      void readSources("代理节点来源已加载。");
      pollHandle = polling.start({
        key: STATUS_POLL_KEY,
        scope: PROXY_SCOPE,
        intervalMs: PROXY_STATUS_POLL_INTERVAL_MS,
        immediate: true,
        critical: false,
        task: async (signal) => {
          activeStatusGeneration = statusGeneration;
          return service.readStatus(signal);
        },
        onResult: (status) => {
          if (active && !destroyed && activeStatusGeneration === statusGeneration && !store.getState().busy) store.commitStatus(status);
        },
        onError: (error) => {
          if (active && !destroyed && activeStatusGeneration === statusGeneration && !store.getState().status) store.fail(proxyErrorPresentation(error));
        },
      });
    },
    async refresh() {
      if (!active || destroyed || !store.beginLoad("refresh")) return false;
      return readAuthority("代理状态和节点来源已刷新。");
    },
    runtime(action) {
      const messages: Readonly<Record<ProxyRuntimeAction, string>> = Object.freeze({
        start: "代理池已启动，状态已刷新。",
        stop: "代理池已停止，现有任务未被强制中断。",
        reload: "节点来源已应用，配置版本已更新。",
        probe: "全部节点检测完成，状态已刷新。",
      });
      return runWrite(action, (signal) => service.runtime(action, signal), messages[action]);
    },
    addSubscription(value) {
      const checked = validateSubscriptionInput(value);
      if (!checked.valid) {
        store.setMessage("订阅地址格式无效；敏感输入已清空，未发送请求。");
        return Promise.resolve(false);
      }
      return runWrite("source-write", (signal) => service.addSubscription(value, signal), "订阅已保存；当前运行池尚未改变。");
    },
    replaceSubscription(id, value) {
      const checked = validateSubscriptionInput(value);
      if (!checked.valid) {
        store.setMessage("新订阅地址格式无效；敏感输入已清空，未发送请求。");
        return Promise.resolve(false);
      }
      return runWrite("source-write", (signal) => service.replaceSubscription(id, value, signal), "订阅已更新；原地址不会重新显示。");
    },
    setNodeFile(value) {
      const checked = validateNodeFileInput(value);
      if (!checked.valid) {
        store.setMessage("节点文件格式无效；输入已清空，未发送请求。");
        return Promise.resolve(false);
      }
      return runWrite("source-write", (signal) => service.setNodeFile(value, signal), "节点文件已保存；当前运行池尚未改变。");
    },
    addInlineNodes(value) {
      const checked = validateInlineNodeInput(value, true);
      if (!checked.valid) {
        store.setMessage("手动节点格式无效；敏感输入已清空，未发送请求。");
        return Promise.resolve(false);
      }
      return runWrite("source-write", (signal) => service.addInlineNodes(value, signal), "手动节点已保存；完整节点信息已清空。");
    },
    replaceInlineNode(id, value) {
      const checked = validateInlineNodeInput(value, false);
      if (!checked.valid) {
        store.setMessage("新节点格式无效；敏感输入已清空，未发送请求。");
        return Promise.resolve(false);
      }
      return runWrite("source-write", (signal) => service.replaceInlineNode(id, value, signal), "手动节点已更新；原节点不会重新显示。");
    },
    requestRemove,
    async confirmRemove(confirmed) {
      const pending = pendingRemove;
      pendingRemove = null;
      store.clearConfirmation();
      if (!pending || !confirmed) {
        store.setMessage("已取消操作，敏感输入已清空。");
        return false;
      }
      return remove(pending);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      version += 1;
      pendingRemove = null;
      pollHandle?.stop();
      pollHandle = null;
      polling.stop(STATUS_POLL_KEY);
      authorityController?.abort();
      operationController?.abort();
      authorityController = null;
      operationController = null;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
