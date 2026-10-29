import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  accounts,
  accountsQuery,
  networkKeys,
  policies,
  policiesQuery,
  proxySources,
  proxySourcesQuery,
  proxyStatusQuery,
  runProxyAction,
} from "./network.ts";

const OPERATION = { response_profile: "desktop-proxy-operation-v1" };

function recordingApi(payload: unknown = OPERATION) {
  const requests: { method: string; path: string; view: string | null; body: unknown }[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      requests.push({ method: request.method, path: url.pathname, view: url.searchParams.get("view"), body: text ? JSON.parse(text) : undefined });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const fetchWith = (options: { queryKey: readonly unknown[] }) =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(options as never);

const SUB = `sub_${"a".repeat(64)}`;
const NODE = `node_${"b".repeat(64)}`;

describe("network queries", () => {
  it("nests every key under network so one invalidate refreshes the page", () => {
    for (const key of [networkKeys.proxyStatus(), networkKeys.proxySources(), networkKeys.accounts(), networkKeys.policies()]) {
      expect(key[0]).toBe("network");
    }
    expect(networkKeys.proxyStatus().slice(0, 2)).toEqual(networkKeys.proxy());
  });

  it("asks for the precise views", async () => {
    const { api, requests } = recordingApi({});
    await fetchWith(proxyStatusQuery(api));
    await fetchWith(proxySourcesQuery(api));
    await fetchWith(accountsQuery(api));
    await fetchWith(policiesQuery(api));
    expect(requests.map((request) => [request.path, request.view])).toEqual([
      ["/api/v1/proxy/status", "desktop"],
      ["/api/v1/proxy/sources", "desktop"],
      ["/api/v1/auth", "vault"],
      ["/api/v1/sites/policies", "policy"],
    ]);
  });

  it("sends proxy runtime actions with their bodies", async () => {
    const { api, requests } = recordingApi();
    for (const action of ["start", "reload", "stop", "probe"] as const) await runProxyAction(api, action);
    expect(requests.map((request) => [request.method, request.path, request.view, request.body])).toEqual([
      ["POST", "/api/v1/proxy/start", "desktop", { force_refresh: true }],
      ["POST", "/api/v1/proxy/reload", "desktop", { force_refresh: true }],
      ["POST", "/api/v1/proxy/stop", "desktop", { force: false }],
      ["POST", "/api/v1/proxy/probe", "desktop", {}],
    ]);
  });

  it("edits proxy sources", async () => {
    const { api, requests } = recordingApi();
    await proxySources.addSubscription(api, "https://sub.example");
    await proxySources.replaceSubscription(api, SUB, "https://sub2.example");
    await proxySources.removeSubscription(api, SUB);
    await proxySources.setNodeFile(api, "~/nodes.yaml");
    await proxySources.clearNodeFile(api);
    await proxySources.addInlineNodes(api, ["socks5://h:1"]);
    await proxySources.replaceInlineNode(api, NODE, "socks5://h:2");
    await proxySources.removeInlineNode(api, NODE);
    await proxySources.clearOverride(api);
    expect(requests.every((request) => request.view === "desktop")).toBe(true);
    expect(requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/api/v1/proxy/sources/subscriptions", { url: "https://sub.example" }],
      ["PUT", `/api/v1/proxy/sources/subscriptions/${SUB}`, { url: "https://sub2.example" }],
      ["DELETE", `/api/v1/proxy/sources/subscriptions/${SUB}`, undefined],
      ["PUT", "/api/v1/proxy/sources/node-file", { path: "~/nodes.yaml" }],
      ["DELETE", "/api/v1/proxy/sources/node-file", undefined],
      ["POST", "/api/v1/proxy/sources/inline-nodes", { nodes: ["socks5://h:1"] }],
      ["PUT", `/api/v1/proxy/sources/inline-nodes/${NODE}`, { node: "socks5://h:2" }],
      ["DELETE", `/api/v1/proxy/sources/inline-nodes/${NODE}`, undefined],
      ["DELETE", "/api/v1/proxy/sources/override", undefined],
    ]);
  });

  it("authorizes, cancels and clears site accounts", async () => {
    const { api, requests } = recordingApi({});
    await accounts.authorize(api, "twitter", "managed_browser");
    await accounts.authorize(api, "pixiv", "oauth");
    await accounts.cancel(api, "twitter", "managed_browser", "c".repeat(32));
    await accounts.cancel(api, "pixiv", "oauth", "d".repeat(32));
    await accounts.clear(api, "exhentai");
    expect(requests.every((request) => request.view === "vault")).toBe(true);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/api/v1/auth/twitter/login/start"],
      ["POST", "/api/v1/auth/pixiv/oauth/start"],
      ["DELETE", `/api/v1/auth/twitter/login/${"c".repeat(32)}`],
      ["DELETE", "/api/v1/auth/pixiv/oauth/session"],
      ["DELETE", "/api/v1/auth/exhentai"],
    ]);
  });

  it("updates and resets site policies", async () => {
    const { api, requests } = recordingApi({});
    const policy = { max_concurrency: 3, retry_limit: 1, backoff_base_seconds: 1.5, proxy_mode: "required" as const };
    await policies.update(api, "pixiv", policy);
    await policies.reset(api, "pixiv");
    expect(requests).toEqual([
      { method: "PUT", path: "/api/v1/sites/policies/pixiv", view: "policy", body: policy },
      { method: "DELETE", path: "/api/v1/sites/policies/pixiv", view: "policy", body: undefined },
    ]);
  });
});
