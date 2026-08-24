import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import Proxy from "../src/apps/proxy/Proxy.svelte";
import AppWindow from "../src/shell/AppWindow.svelte";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import controllerSource from "../src/apps/proxy/controller.ts?raw";
import modelSource from "../src/apps/proxy/model.ts?raw";
import proxySource from "../src/apps/proxy/Proxy.svelte?raw";
import serviceSource from "../src/apps/proxy/service.ts?raw";
import stateSource from "../src/apps/proxy/state.ts?raw";

const proxyCss = readFileSync(new URL("../src/apps/proxy/proxy.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;

describe("Svelte Proxy integration", () => {
  it("renders the real accessible three-column Proxy boundary", () => {
    const body = render(Proxy, { props: { api, polling } }).body;
    for (const marker of [
      "data-proxy-app",
      'data-domain-owner="proxy"',
      "状态总览",
      "运行池控制",
      "来源编辑",
      "启动代理池",
      "应用并重新加载",
      "订阅地址",
      "节点文件",
      "手动节点",
      "危险操作",
      'aria-live="polite"',
      'aria-label="代理管理三段工作区，可横向滚动查看状态总览、运行池控制和来源编辑"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("uses Proxy for its only AppWindow branch", () => {
    const body = render(AppWindow, { props: {
      record: { appId: "proxy", state: "normal", rect: { x: 20, y: 20, w: 800, h: 560 } },
      api,
      polling,
      persistence: Object.freeze({}) as never,
      focused: true,
      onNavigate: vi.fn(),
      onFocus: vi.fn(),
      onMinimize: vi.fn(),
      onToggleMaximized: vi.fn(),
      onClose: vi.fn(),
      onBeginInteraction: vi.fn(),
      onKeyboardResize: vi.fn(),
    } }).body;
    expect(body).toContain("data-proxy-app");
    expect(body).not.toContain('data-application-content="proxy"');
    expect(appWindowSource).toContain('record.appId === "proxy"');
    expect(appWindowSource).toContain("<Proxy {api} {polling} />");
    expect(appWindowSource.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
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
    expect(proxyCss).toContain("overflow-x: auto");
    expect(proxyCss).toContain("@media (forced-colors: active)");
  });
});
