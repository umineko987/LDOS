import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import Policy from "../src/apps/policy/Policy.svelte";
import AppWindow from "../src/shell/AppWindow.svelte";
import type { ApiClient } from "../src/core/api/client";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import controllerSource from "../src/apps/policy/controller.ts?raw";
import modelSource from "../src/apps/policy/model.ts?raw";
import policySource from "../src/apps/policy/Policy.svelte?raw";
import serviceSource from "../src/apps/policy/service.ts?raw";
import stateSource from "../src/apps/policy/state.ts?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({}) as PersistenceService;
const windowProps = {
  record: { appId: "policy" as const, state: "normal" as const, rect: { x: 20, y: 20, w: 800, h: 560 } },
  api, polling, persistence, focused: true, onNavigate: vi.fn(), onFocus: vi.fn(), onMinimize: vi.fn(), onToggleMaximized: vi.fn(), onClose: vi.fn(), onBeginInteraction: vi.fn(), onKeyboardResize: vi.fn(),
};
const policyCss = readFileSync(new URL("../src/apps/policy/policy.css", import.meta.url), "utf8");

describe("Svelte Policy integration", () => {
  it("renders the real accessible three-column Policy boundary", () => {
    const body = render(Policy, { props: { api } }).body;
    for (const marker of ["data-policy-app", 'data-domain-owner="policy"', "01 · 站点", "02 · 当前站点", "03 · 状态与操作", "五个站点的设置状态", "完整四字段编辑器", "恢复默认设置", "aria-live=\"polite\"", 'aria-label="站点设置三栏工作区，可横向滚动查看站点、完整编辑器与保存恢复操作"', 'autocomplete="off"']) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("routes Policy through its only AppWindow branch and keeps the dirty boundary", () => {
    const body = render(AppWindow, { props: windowProps }).body;
    expect(body).toContain("data-policy-app");
    expect(appWindowSource).toContain('record.appId === "policy"');
    expect(appWindowSource).toContain("<Policy {api} registerUnsavedChanges=");
    expect(appWindowSource.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
    expect(policySource).toContain("registerUnsavedChanges");
    expect(policySource).toContain("beforeunload");
    expect(policySource).toContain('aria-modal="true"');
    expect(policySource).toContain("trappedTabIndex");
  });

  it("keeps one domain owner, exact API boundary, and no forbidden I/O", () => {
    expect(policySource).toContain("{#each items as entry (entry.definition.id)}");
    expect(policySource.match(/createPolicyStore\s*\(/g)).toHaveLength(1);
    expect(stateSource).toContain("snapshot: PolicySnapshot | null");
    expect(modelSource).toContain("buildPolicyPayload");
    expect(serviceSource).toContain("POLICY_ENDPOINTS");
    expect(serviceSource).toContain("view=policy");
    const combined = [policySource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
    for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /\b(?:localStorage|sessionStorage|indexedDB)\b/, /\bsetInterval\s*\(/, /innerHTML/, /console\./, /error\.details/]) expect(combined).not.toMatch(forbidden);
    expect(controllerSource).not.toContain("polling.start");
    expect(policyCss).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:/m);
    expect(policyCss).not.toMatch(/^\s*filter\s*:/m);
    expect(policyCss).toContain("min-width: 1120px");
    expect(policyCss).toContain("overflow-x: auto");
    expect(policyCss).toContain("@media (forced-colors: active)");
  });
});
