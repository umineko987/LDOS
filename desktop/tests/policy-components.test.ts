import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import Policy from "../src/apps/policy/Policy.svelte";
import Desktop from "../src/shell/Desktop.svelte";
import { createDesktopRuntime } from "./fixtures/desktop";
import type { ApiClient } from "../src/core/api/client";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import controllerSource from "../src/apps/policy/controller.ts?raw";
import modelSource from "../src/apps/policy/model.ts?raw";
import policySource from "../src/apps/policy/Policy.svelte?raw";
import serviceSource from "../src/apps/policy/service.ts?raw";
import stateSource from "../src/apps/policy/state.ts?raw";

const api = Object.freeze({}) as ApiClient;
const policyCss = readFileSync(new URL("../src/apps/policy/policy.css", import.meta.url), "utf8");

describe("Svelte Policy integration", () => {
  it("renders accessible site settings and keeps the reset impact warning", () => {
    const body = render(Policy, { props: { api } }).body;
    for (const marker of ["data-policy-app", 'data-domain-owner="policy"', '<h1 id="policy-heading">站点</h1>', "选择站点", "采集设置", "保存与恢复", "五个站点的设置状态", "恢复默认设置", 'aria-live="polite"', 'aria-label="站点设置；可纵向滚动"', 'autocomplete="off"', "恢复默认会删除当前站点覆盖；已创建和运行中的任务不受影响。", "仅影响后续新建任务。"]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("mounts Policy in Desktop and keeps the dirty boundary", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("policy");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="policy"');
    expect(body).toContain("data-policy-app");
    expect(desktopSource).toContain('<Policy {api} registerUnsavedChanges=');
    expect(desktopSource).toContain('shell.registerUnsavedChanges("policy", reader, discard)');
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
    expect(policyCss).toContain("min-width: 0");
    expect(policyCss).toContain("overflow-y: auto");
    expect(policyCss).toContain("@media (forced-colors: active)");
  });
});
