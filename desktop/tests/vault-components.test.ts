import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import Vault from "../src/apps/vault/Vault.svelte";
import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import AppWindow from "../src/shell/AppWindow.svelte";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import controllerSource from "../src/apps/vault/controller.ts?raw";
import modelSource from "../src/apps/vault/model.ts?raw";
import serviceSource from "../src/apps/vault/service.ts?raw";
import stateSource from "../src/apps/vault/state.ts?raw";
import vaultSource from "../src/apps/vault/Vault.svelte?raw";

const vaultCss = readFileSync(new URL("../src/apps/vault/vault.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;

const windowProps = {
  record: { appId: "vault" as const, state: "normal" as const, rect: { x: 20, y: 20, w: 800, h: 560 } },
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
};

describe("Svelte Vault integration", () => {
  it("renders the real accessible three-column Vault boundary", () => {
    const body = render(Vault, { props: { api, polling } }).body;
    for (const marker of [
      "data-vault-app",
      'data-domain-owner="vault"',
      "01 · 站点",
      "02 · 材料与会话",
      "03 · 共享与恢复",
      "共享授权浏览器数据",
      "登录代理",
      "危险操作",
      'aria-live="polite"',
      'aria-label="授权管理三栏工作区，可横向滚动查看站点、材料与共享恢复"',
      'autocomplete="off"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
    expect(body).not.toContain("P2 Shell");
  });

  it("uses Vault for its only AppWindow branch", () => {
    const body = render(AppWindow, { props: windowProps }).body;
    expect(body).toContain("data-vault-app");
    expect(body).not.toContain('data-application-content="vault"');
    expect(appWindowSource).toContain('record.appId === "vault"');
    expect(appWindowSource).toContain('<Vault {api} {polling} registerUnsavedChanges=');
    expect(appWindowSource.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
  });

  it("keeps keyed sites, one owner, shared API/polling, confirmation focus, and complete cleanup", () => {
    expect(vaultSource).toContain("{#each siteItems as item (item.definition.id)}");
    expect(vaultSource.match(/createVaultStore\s*\(/g)).toHaveLength(1);
    expect(stateSource).toContain("snapshot: VaultSnapshot | null");
    expect(modelSource).toContain("sites: Readonly<Record<string, VaultSiteStatus>>");
    expect(vaultSource).toContain('aria-modal="true"');
    expect(vaultSource).toContain("trappedTabIndex");
    expect(vaultSource).toContain("restoreVaultFocus");
    expect(vaultSource).toContain("controller.deactivate()");
    expect(vaultSource).toContain("controller.destroy()");
    expect(controllerSource).toContain('key: AUTHORIZATION_POLL_KEY');
    expect(controllerSource).toContain("alwaysFocusRate: true");
    expect(controllerSource).toContain("intervalMs: AUTHORIZATION_POLL_INTERVAL_MS");
    expect(controllerSource).toContain("polling.stopScope(VAULT_SCOPE)");
  });

  it("never bypasses I/O boundaries or projects secret response/session fields into UI/state", () => {
    const combined = [vaultSource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
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
    expect(vaultSource).not.toMatch(/sessionId|session_id|authorization_url|raw_cookie|raw_proxy_url|proxy_url/);
    expect(stateSource).not.toMatch(/sessionId|session_id|proxyDraft|proxy_url/);
    expect(vaultSource).not.toContain('type="password"');
    expect(vaultSource).toContain('type="text"');
    expect(vaultSource).toContain('proxyDraft = ""');
    expect((serviceSource.match(/"\/api\/v1\//g) ?? [])).toHaveLength(5);
    expect((serviceSource.match(/view=vault/g) ?? [])).toHaveLength(1);
  });

  it("keeps application internals flat with horizontal and forced-colors fallbacks", () => {
    expect(vaultCss).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:(?!\s*none)/m);
    expect(vaultCss).not.toMatch(/^\s*filter\s*:/m);
    expect(vaultCss).toContain(".vault-workspace-track");
    expect(vaultCss).toContain("min-width: 1120px");
    expect(vaultCss).toContain("overflow-x: auto");
    expect(vaultCss).toContain("@media (forced-colors: active)");
    expect(vaultCss).toContain("CanvasText");
    expect(vaultCss).toContain("Highlight");
    expect(vaultCss).not.toMatch(/@media\s*\(max-width\s*:/);
  });
});
