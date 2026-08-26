import type { ApiClient } from "../../core/api/client";
import {
  sanitizeProxySources,
  sanitizeProxyStatus,
  validateInlineNodeInput,
  validateNodeFileInput,
  validateSubscriptionInput,
  type ProxySources,
  type ProxyStatus,
} from "./model";

export const PROXY_ENDPOINTS = Object.freeze({
  status: "/api/v1/proxy/status",
  start: "/api/v1/proxy/start",
  reload: "/api/v1/proxy/reload",
  probe: "/api/v1/proxy/probe",
  stop: "/api/v1/proxy/stop",
  sources: "/api/v1/proxy/sources",
  subscriptions: "/api/v1/proxy/sources/subscriptions",
  nodeFile: "/api/v1/proxy/sources/node-file",
  inlineNodes: "/api/v1/proxy/sources/inline-nodes",
  override: "/api/v1/proxy/sources/override",
} as const);

export type ProxyRuntimeAction = "start" | "stop" | "reload" | "probe";
export type ProxyDeleteAction = "subscription" | "inline" | "node-file" | "override";

export interface ProxyService {
  readStatus(signal: AbortSignal): Promise<ProxyStatus>;
  readSources(signal: AbortSignal): Promise<ProxySources>;
  readAuthority(signal: AbortSignal): Promise<Readonly<{ status: ProxyStatus; sources: ProxySources }>>;
  runtime(action: ProxyRuntimeAction, signal: AbortSignal): Promise<void>;
  addSubscription(value: string, signal: AbortSignal): Promise<void>;
  replaceSubscription(id: string, value: string, signal: AbortSignal): Promise<void>;
  setNodeFile(value: string, signal: AbortSignal): Promise<void>;
  addInlineNodes(value: string, signal: AbortSignal): Promise<void>;
  replaceInlineNode(id: string, value: string, signal: AbortSignal): Promise<void>;
  remove(action: ProxyDeleteAction, id: string, signal: AbortSignal): Promise<void>;
}

function sourceId(value: string, prefix: "sub" | "node"): string {
  const pattern = prefix === "sub" ? /^sub_[0-9a-f]{64}$/ : /^node_[0-9a-f]{64}$/;
  if (!pattern.test(value)) throw new TypeError("invalid_proxy_source_id");
  return encodeURIComponent(value);
}

function validatedValue(result: ReturnType<typeof validateSubscriptionInput> | ReturnType<typeof validateNodeFileInput>): string {
  if (!result.valid || typeof result.value !== "string") throw new TypeError(`invalid_${result.field}`);
  return result.value;
}

export function createProxyService(api: ApiClient): ProxyService {
  const readStatus = async (signal: AbortSignal): Promise<ProxyStatus> => (
    sanitizeProxyStatus(await api.get(`${PROXY_ENDPOINTS.status}?view=desktop`, { signal }))
  );
  const readSources = async (signal: AbortSignal): Promise<ProxySources> => (
    sanitizeProxySources(await api.get(`${PROXY_ENDPOINTS.sources}?view=desktop`, { signal }))
  );

  const service: ProxyService = {
    readStatus,
    readSources,
    async readAuthority(signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      try {
        const [status, sources] = await Promise.all([
          readStatus(controller.signal),
          readSources(controller.signal),
        ]);
        return Object.freeze({ status, sources });
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async runtime(action, signal) {
      if (action === "start" || action === "reload") {
        await api.post(`${PROXY_ENDPOINTS[action]}?view=desktop`, { force_refresh: true }, { signal });
        return;
      }
      if (action === "stop") {
        await api.post(`${PROXY_ENDPOINTS.stop}?view=desktop`, { force: false }, { signal });
        return;
      }
      if (action === "probe") {
        await api.post(`${PROXY_ENDPOINTS.probe}?view=desktop`, {}, { signal });
        return;
      }
      throw new TypeError("invalid_proxy_runtime_action");
    },
    async addSubscription(value, signal) {
      await api.post(`${PROXY_ENDPOINTS.subscriptions}?view=desktop`, {
        url: validatedValue(validateSubscriptionInput(value)),
      }, { signal });
    },
    async replaceSubscription(id, value, signal) {
      await api.put(`${PROXY_ENDPOINTS.subscriptions}/${sourceId(id, "sub")}?view=desktop`, {
        url: validatedValue(validateSubscriptionInput(value)),
      }, { signal });
    },
    async setNodeFile(value, signal) {
      await api.put(`${PROXY_ENDPOINTS.nodeFile}?view=desktop`, {
        path: validatedValue(validateNodeFileInput(value)),
      }, { signal });
    },
    async addInlineNodes(value, signal) {
      const result = validateInlineNodeInput(value, true);
      if (!result.valid || !Array.isArray(result.value)) throw new TypeError("invalid_inline_node");
      await api.post(`${PROXY_ENDPOINTS.inlineNodes}?view=desktop`, { nodes: result.value }, { signal });
    },
    async replaceInlineNode(id, value, signal) {
      const result = validateInlineNodeInput(value, false);
      if (!result.valid || typeof result.value !== "string") throw new TypeError("invalid_inline_node");
      await api.put(`${PROXY_ENDPOINTS.inlineNodes}/${sourceId(id, "node")}?view=desktop`, {
        node: result.value,
      }, { signal });
    },
    async remove(action, id, signal) {
      const path = action === "subscription"
        ? `${PROXY_ENDPOINTS.subscriptions}/${sourceId(id, "sub")}`
        : action === "inline"
          ? `${PROXY_ENDPOINTS.inlineNodes}/${sourceId(id, "node")}`
          : action === "node-file"
            ? PROXY_ENDPOINTS.nodeFile
            : action === "override"
              ? PROXY_ENDPOINTS.override
              : null;
      if (!path) throw new TypeError("invalid_proxy_delete_action");
      await api.delete(`${path}?view=desktop`, { signal });
    },
  };
  return Object.freeze(service);
}
