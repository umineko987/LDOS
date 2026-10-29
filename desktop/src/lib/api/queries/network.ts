// 设置 › 网络用到的接口：代理池（view=desktop）、站点账号（view=vault）、站点策略（view=policy）。
// 响应是精确视图和 Legacy* 的并集，收窄在 #lib/domain/network.ts。
// 代理池的写操作只回 `{response_profile: "desktop-proxy-operation-v1"}`，调用方写完要重拉状态和来源。

import { queryOptions } from "@tanstack/svelte-query";

import type {
  DesktopProxySources,
  DesktopProxyStatus,
  LegacyAuthStatuses,
  LegacyProxySources,
  LegacyProxyStatus,
  LegacySitePolicies,
  PolicyFields,
  PolicyViewSnapshot,
  ProxyAction,
  VaultStatuses,
} from "#lib/domain/network.ts";

import { data, type Api } from "../client.ts";

const DESKTOP = { params: { query: { view: "desktop" as const } } };
const VAULT = { params: { query: { view: "vault" as const } } };
const POLICY = { params: { query: { view: "policy" as const } } };

export const networkKeys = {
  all: ["network"] as const,
  proxyStatus: () => [...networkKeys.all, "proxy", "status"] as const,
  proxySources: () => [...networkKeys.all, "proxy", "sources"] as const,
  proxy: () => [...networkKeys.all, "proxy"] as const,
  accounts: () => [...networkKeys.all, "accounts"] as const,
  policies: () => [...networkKeys.all, "policies"] as const,
};

export function proxyStatusQuery(api: Api) {
  return queryOptions({
    queryKey: networkKeys.proxyStatus(),
    queryFn: async ({ signal }): Promise<DesktopProxyStatus | LegacyProxyStatus> =>
      data(api.client.GET("/api/v1/proxy/status", { ...DESKTOP, signal })),
  });
}

export function proxySourcesQuery(api: Api) {
  return queryOptions({
    queryKey: networkKeys.proxySources(),
    queryFn: async ({ signal }): Promise<DesktopProxySources | LegacyProxySources> =>
      data(api.client.GET("/api/v1/proxy/sources", { ...DESKTOP, signal })),
  });
}

/** 启动和重载时刷新订阅（force_refresh）；停止不强制（有租约时后端会拒绝）。 */
export async function runProxyAction(api: Api, action: ProxyAction): Promise<void> {
  switch (action) {
    case "start":
      await data(api.client.POST("/api/v1/proxy/start", { ...DESKTOP, body: { force_refresh: true } }));
      return;
    case "reload":
      await data(api.client.POST("/api/v1/proxy/reload", { ...DESKTOP, body: { force_refresh: true } }));
      return;
    case "stop":
      await data(api.client.POST("/api/v1/proxy/stop", { ...DESKTOP, body: { force: false } }));
      return;
    case "probe":
      await data(api.client.POST("/api/v1/proxy/probe", { ...DESKTOP, body: {} }));
      return;
  }
}

const sourceParams = (id: string) => ({ params: { query: { view: "desktop" as const }, path: { source_id: id } } });

export const proxySources = {
  async addSubscription(api: Api, url: string): Promise<void> {
    await data(api.client.POST("/api/v1/proxy/sources/subscriptions", { ...DESKTOP, body: { url } }));
  },
  async replaceSubscription(api: Api, id: string, url: string): Promise<void> {
    await data(api.client.PUT("/api/v1/proxy/sources/subscriptions/{source_id}", { ...sourceParams(id), body: { url } }));
  },
  async removeSubscription(api: Api, id: string): Promise<void> {
    await data(api.client.DELETE("/api/v1/proxy/sources/subscriptions/{source_id}", sourceParams(id)));
  },
  async setNodeFile(api: Api, path: string): Promise<void> {
    await data(api.client.PUT("/api/v1/proxy/sources/node-file", { ...DESKTOP, body: { path } }));
  },
  async clearNodeFile(api: Api): Promise<void> {
    await data(api.client.DELETE("/api/v1/proxy/sources/node-file", DESKTOP));
  },
  async addInlineNodes(api: Api, nodes: readonly string[]): Promise<void> {
    await data(api.client.POST("/api/v1/proxy/sources/inline-nodes", { ...DESKTOP, body: { nodes: [...nodes] } }));
  },
  async replaceInlineNode(api: Api, id: string, node: string): Promise<void> {
    await data(api.client.PUT("/api/v1/proxy/sources/inline-nodes/{source_id}", { ...sourceParams(id), body: { node } }));
  },
  async removeInlineNode(api: Api, id: string): Promise<void> {
    await data(api.client.DELETE("/api/v1/proxy/sources/inline-nodes/{source_id}", sourceParams(id)));
  },
  /** 删掉运行时覆盖，回到配置文件里的来源。 */
  async clearOverride(api: Api): Promise<void> {
    await data(api.client.DELETE("/api/v1/proxy/sources/override", DESKTOP));
  },
};

export function accountsQuery(api: Api) {
  return queryOptions({
    queryKey: networkKeys.accounts(),
    queryFn: async ({ signal }): Promise<VaultStatuses | LegacyAuthStatuses> => data(api.client.GET("/api/v1/auth", { ...VAULT, signal })),
  });
}

type Site = VaultStatuses["items"][number]["site"];
const siteParams = (site: Site) => ({ params: { query: { view: "vault" as const }, path: { site } } });

export const accounts = {
  /** 打开项目浏览器让用户登录；pixiv 走 OAuth。会话状态从 GET /auth 里读。 */
  async authorize(api: Api, site: Site, kind: "managed_browser" | "oauth"): Promise<void> {
    if (kind === "oauth") await data(api.client.POST("/api/v1/auth/pixiv/oauth/start", VAULT));
    else await data(api.client.POST("/api/v1/auth/{site}/login/start", siteParams(site)));
  },
  async cancel(api: Api, site: Site, kind: "managed_browser" | "oauth", sessionId: string): Promise<void> {
    if (kind === "oauth") await data(api.client.DELETE("/api/v1/auth/pixiv/oauth/session", VAULT));
    else
      await data(
        api.client.DELETE("/api/v1/auth/{site}/login/{session_id}", {
          params: { query: { view: "vault" }, path: { site, session_id: sessionId } },
        }),
      );
  },
  async clear(api: Api, site: Site): Promise<void> {
    await data(api.client.DELETE("/api/v1/auth/{site}", siteParams(site)));
  },
};

export function policiesQuery(api: Api) {
  return queryOptions({
    queryKey: networkKeys.policies(),
    queryFn: async ({ signal }): Promise<PolicyViewSnapshot | LegacySitePolicies> =>
      data(api.client.GET("/api/v1/sites/policies", { ...POLICY, signal })),
  });
}

export const policies = {
  async update(api: Api, site: string, policy: PolicyFields): Promise<void> {
    await data(api.client.PUT("/api/v1/sites/policies/{site}", { params: { query: { view: "policy" }, path: { site } }, body: policy }));
  },
  /** 删掉站点覆盖，回到默认策略。 */
  async reset(api: Api, site: string): Promise<void> {
    await data(api.client.DELETE("/api/v1/sites/policies/{site}", { params: { query: { view: "policy" }, path: { site } } }));
  },
};
