import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import Proxy from "../src/apps/proxy/Proxy.svelte";
import Desktop from "../src/shell/Desktop.svelte";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import { createDesktopRuntime } from "./fixtures/desktop";
import controllerSource from "../src/apps/proxy/controller.ts?raw";
import modelSource from "../src/apps/proxy/model.ts?raw";
import proxySource from "../src/apps/proxy/Proxy.svelte?raw";
import serviceSource from "../src/apps/proxy/service.ts?raw";
import stateSource from "../src/apps/proxy/state.ts?raw";

const proxyCss = readFileSync(new URL("../src/apps/proxy/proxy.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;

describe("Svelte Proxy integration", () => {
  it("renders accessible Proxy settings with runtime, sources, and danger controls", () => {
    const body = render(Proxy, { props: { api, polling } }).body;
    for (const marker of [
      "data-proxy-app",
      'data-domain-owner="proxy"',
      '<h1 id="proxy-heading">代理</h1>',
      "运行状态",
      "运行池",
      "节点来源",
      "启动代理池",
      "应用并重新加载",
      "订阅地址",
      "节点文件",
      "手动节点",
      "危险操作",
      'aria-live="polite"',
      'aria-label="代理设置；可纵向滚动"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("mounts Proxy in the Desktop settings page", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("proxy");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="proxy"');
    expect(body).toContain("data-proxy-app");
    expect(body).not.toContain('data-application-content="proxy"');
    expect(desktopSource).toContain('<Proxy {api} {polling} />');
  });

  it("keeps keyed domain lists, one owner, shared API/polling, confirmations, and cleanup", () => {
    expect(proxySource).toContain("{#each nodes as node (node.id)}");
    expect(proxySource).toContain("{#each subscriptions as item (item.id)}");
    expect(proxySource).toContain("{#each inlineNodes as item (item.id)}");
    expect(proxySource.match(/createProxyStore\s*\(/g)).toHaveLength(1);
    expect(modelSource).toContain("nodes: Readonly<Record<string, ProxyNode>>");
    expect(modelSource).toContain("subscriptionOrder: readonly string[]");
    expect(stateSource).toContain("confirmation: ProxyConfirmation | null");
    expect(proxySource).toContain('aria-modal="true"');
    expect(proxySource).toContain("trappedTabIndex");
    expect(proxySource).toContain("controller.destroy()");
    expect(controllerSource).toContain('key: STATUS_POLL_KEY');
    expect(controllerSource).toContain("pollHandle?.stop()");
    expect(serviceSource).toContain("Promise.all([");
    expect(serviceSource).toContain("PROXY_ENDPOINTS");
  });

  it("never bypasses boundaries or projects sensitive response/input fields", () => {
    const combined = [proxySource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /globalThis\.fetch/,
      /XMLHttpRequest/,
      /\b(?:localStorage|sessionStorage|indexedDB)\b/,
      /\bsetInterval\s*\(/,
      /innerHTML/,
      /console\./,
      /error\.details/,
    ]) expect(combined).not.toMatch(forbidden);
    expect(proxySource).not.toMatch(/\.url\b|\.node\b|proxy_url|display_url|display_path/);
    expect(proxySource).toContain('autocomplete="off"');
    expect(proxySource).toContain('subscriptionDraft = ""');
    expect(proxySource).toContain('nodeFileDraft = ""');
    expect(proxySource).toContain('inlineDraft = ""');
  });

  it("keeps application internals flat with forced-colors fallback", () => {
    expect(proxyCss).not.toMatch(/(?:-webkit-)?backdrop-filter\s*:/);
    expect(proxyCss).not.toMatch(/^\s*filter\s*:/m);
    expect(proxyCss).toContain(".proxy-workspace__track");
    expect(proxyCss).toContain("overflow-y: auto");
    expect(proxyCss).toContain("@media (forced-colors: active)");
  });
});
