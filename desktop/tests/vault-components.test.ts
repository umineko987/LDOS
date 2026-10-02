import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import Vault from "../src/apps/vault/Vault.svelte";
import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import Desktop from "../src/shell/Desktop.svelte";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import { createDesktopRuntime } from "./fixtures/desktop";
import controllerSource from "../src/apps/vault/controller.ts?raw";
import modelSource from "../src/apps/vault/model.ts?raw";
import serviceSource from "../src/apps/vault/service.ts?raw";
import stateSource from "../src/apps/vault/state.ts?raw";
import vaultSource from "../src/apps/vault/Vault.svelte?raw";

const vaultCss = readFileSync(new URL("../src/apps/vault/vault.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;


describe("Svelte Vault integration", () => {
  it("renders accessible Vault settings with site, browser, and recovery controls", () => {
    const body = render(Vault, { props: { api, polling } }).body;
    for (const marker of [
      "data-vault-app",
      'data-domain-owner="vault"',
      '<h1 id="vault-heading">授权</h1>',
      "选择站点",
      "浏览器与登录代理",
      "共享授权浏览器数据",
      "登录代理",
      "危险操作",
      'aria-live="polite"',
      'aria-label="站点授权设置；可纵向滚动"',
      'autocomplete="off"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
    expect(body).not.toContain("P2 Shell");
  });

  it("mounts Vault in Desktop and registers its dirty boundary", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("vault");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="vault"');
    expect(body).toContain("data-vault-app");
    expect(body).not.toContain('data-application-content="vault"');
    expect(desktopSource).toContain('<Vault {api} {polling} registerUnsavedChanges=');
    expect(desktopSource).toContain('shell.registerUnsavedChanges("vault", reader, discard)');
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
    expect((serviceSource.match(/"\/api\/v1\//g) ?? [])).toHaveLength(6);
    expect((serviceSource.match(/view=vault/g) ?? [])).toHaveLength(1);
  });

  it("keeps vertically scrollable flat settings and forced-colors support", () => {
    expect(vaultCss).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:(?!\s*none)/m);
    expect(vaultCss).not.toMatch(/^\s*filter\s*:/m);
    expect(vaultCss).toContain(".vault-workspace-track");
    expect(vaultCss).toContain("min-width: 0");
    expect(vaultCss).toContain("overflow-y: auto");
    expect(vaultCss).toContain("@media (forced-colors: active)");
    expect(vaultCss).toContain("CanvasText");
    expect(vaultCss).toContain("Highlight");
    expect(vaultCss).toContain("@container (max-width: 900px)");
  });
});
