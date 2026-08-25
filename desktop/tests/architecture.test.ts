import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{svelte,ts}", {
  eager: true,
  import: "default",
  query: "?raw",
});
const productionSources = Object.fromEntries(
  Object.entries(sources).filter(([path]) => !path.endsWith(".test.ts")),
);

function sourceEnding(suffix: string): string {
  const match = Object.entries(productionSources).find(([path]) => path.endsWith(suffix));
  if (!match) throw new Error(`missing_source:${suffix}`);
  return match[1];
}

describe("desktop architecture boundaries", () => {
  it("keeps fetch inside the one API client", () => {
    for (const [path, source] of Object.entries(productionSources)) {
      if (path.endsWith("/core/api/client.ts")) continue;
      expect(source, path).not.toMatch(/\bfetch\s*\(|globalThis\.fetch/);
    }
  });

  it("does not introduce a second production UI entry", () => {
    const forbiddenEntry = ["ui", "next"].join("-");
    for (const [path, source] of Object.entries(productionSources)) {
      expect(`${path}\n${source}`).not.toContain(forbiddenEntry);
    }
  });

  it("uses one typed application-definition source for MenuBar, ApplicationCenter, and Dock", () => {
    const definitions = sourceEnding("/core/applications/definitions.ts");
    const menu = sourceEnding("/shell/MenuBar.svelte");
    const center = sourceEnding("/shell/ApplicationCenter.svelte");
    const dock = sourceEnding("/shell/Dock.svelte");
    expect(definitions).toContain("APPLICATION_DEFINITIONS");
    expect(menu).toContain("APPLICATION_DEFINITIONS");
    expect(menu).toContain("deriveWindowMenu");
    expect(center).toContain("deriveApplicationGroups");
    expect(dock).toContain("deriveDockProjection");
    for (const source of [menu, center, dock]) {
      expect(source).not.toMatch(/["'](?:crawl|tasks|proxy|vault|review|policy|diagnostics|personalization|gallery|export)["']/);
    }
  });

  it("creates one production shell store and keeps business snapshots out of it", () => {
    const app = sourceEnding("/App.svelte");
    const shell = sourceEnding("/core/state/shell.ts");
    const joined = Object.values(productionSources).join("\n");
    expect(app.match(/createShellStore\s*\(/g)).toHaveLength(1);
    expect(joined.match(/createShellStore\s*\(/g)).toHaveLength(2);
    expect(shell).not.toMatch(/ApiClient|TaskSnapshot|CrawlSnapshot|serverSnapshot|draftForm|formValues/);
    expect(shell).not.toMatch(/localStorage|sessionStorage|\bfetch\s*\(/);
  });

  it("routes all Web Storage access through the single persistence adapter", () => {
    for (const [path, source] of Object.entries(productionSources)) {
      if (path.endsWith("/core/persistence/adapter.ts")) continue;
      expect(source, path).not.toMatch(/globalThis\.(?:localStorage|sessionStorage)|window\.(?:localStorage|sessionStorage)/);
    }
  });

  it("removes the superseded bootstrap shell", () => {
    const app = sourceEnding("/App.svelte");
    const main = sourceEnding("/main.ts");
    expect(`${app}\n${main}`).not.toMatch(/bootstrap-(?:desktop|menu|window|dock)|bootstrap\.css/);
    expect(main).toContain('import "./styles/shell.css"');
  });

  it("keeps all recurring scheduling in the one core polling service", () => {
    const app = sourceEnding("/App.svelte");
    const polling = sourceEnding("/core/polling/service.ts");
    expect(app.match(/createPollingService\s*\(/g)).toHaveLength(1);
    expect(polling).toContain("BACKGROUND_POLL_MULTIPLIER = 4");
    expect(polling).toContain("AbortController");
    for (const [path, source] of Object.entries(productionSources)) {
      if (path.endsWith("/core/polling/service.ts")) continue;
      expect(source, path).not.toMatch(/\bsetInterval\s*\(/);
    }
  });

  it("keeps each migrated domain owner outside shell state and one placeholder path", () => {
    const crawl = sourceEnding("/apps/crawl/Crawl.svelte");
    const crawlState = sourceEnding("/apps/crawl/state.ts");
    const crawlModel = sourceEnding("/apps/crawl/model.ts");
    const tasks = sourceEnding("/apps/tasks/Tasks.svelte");
    const tasksState = sourceEnding("/apps/tasks/state.ts");
    const proxy = sourceEnding("/apps/proxy/Proxy.svelte");
    const proxyState = sourceEnding("/apps/proxy/state.ts");
    const proxyModel = sourceEnding("/apps/proxy/model.ts");
    const vault = sourceEnding("/apps/vault/Vault.svelte");
    const vaultState = sourceEnding("/apps/vault/state.ts");
    const vaultModel = sourceEnding("/apps/vault/model.ts");
    const policy = sourceEnding("/apps/policy/Policy.svelte");
    const policyState = sourceEnding("/apps/policy/state.ts");
    const policyModel = sourceEnding("/apps/policy/model.ts");
    const diagnostics = sourceEnding("/apps/diagnostics/Diagnostics.svelte");
    const diagnosticsState = sourceEnding("/apps/diagnostics/state.ts");
    const diagnosticsModel = sourceEnding("/apps/diagnostics/model.ts");
    const window = sourceEnding("/shell/AppWindow.svelte");
    expect(crawl.match(/createCrawlStore\s*\(/g)).toHaveLength(1);
    expect(crawlState.match(/export function createCrawlStore\s*\(/g)).toHaveLength(1);
    expect(crawlModel).toContain("candidates: Readonly<Record<CrawlCandidateKey, CrawlCandidate>>");
    expect(tasks.match(/createTasksStore\s*\(/g)).toHaveLength(1);
    expect(tasksState.match(/export function createTasksStore\s*\(/g)).toHaveLength(1);
    expect(tasksState).toContain("entities: Readonly<Record<string, TaskEntity>>");
    expect(proxy.match(/createProxyStore\s*\(/g)).toHaveLength(1);
    expect(proxyState.match(/export function createProxyStore\s*\(/g)).toHaveLength(1);
    expect(proxyModel).toContain("nodes: Readonly<Record<string, ProxyNode>>");
    expect(vault.match(/createVaultStore\s*\(/g)).toHaveLength(1);
    expect(vaultState.match(/export function createVaultStore\s*\(/g)).toHaveLength(1);
    expect(vaultModel).toContain("sites: Readonly<Record<string, VaultSiteStatus>>");
    expect(policy.match(/createPolicyStore\s*\(/g)).toHaveLength(1);
    expect(policyState.match(/export function createPolicyStore\s*\(/g)).toHaveLength(1);
    expect(policyModel).toContain("sites: Readonly<Record<PolicySiteId, PolicyItem>>");
    expect(diagnostics.match(/createDiagnosticsStore\s*\(/g)).toHaveLength(1);
    expect(diagnosticsState.match(/export function createDiagnosticsStore\s*\(/g)).toHaveLength(1);
    expect(diagnosticsModel).toContain("readonly readiness: ReadinessDiagnostics | null");
    expect(window.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
    expect(window).toContain('record.appId === "crawl"');
    expect(window).toContain('record.appId === "tasks"');
    expect(window).toContain('record.appId === "proxy"');
    expect(window).toContain('record.appId === "vault"');
    expect(window).toContain('record.appId === "policy"');
    expect(window).toContain('record.appId === "diagnostics"');
    expect(sourceEnding("/core/state/shell.ts")).not.toMatch(/CrawlState|TasksState|BatchSummary|TaskEntity|ProxyState|ProxyStatus/);
    for (const [path, source] of Object.entries(productionSources)) {
      if (!path.includes("/core/")) continue;
      expect(source, path).not.toMatch(/from ["'][^"']*apps\/(?:crawl|tasks|proxy|vault)/);
    }
  });
});
