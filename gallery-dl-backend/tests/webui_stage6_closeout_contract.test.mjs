import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

const REPOSITORY = existsSync(new URL("../README.md", import.meta.url))
  ? new URL("../", import.meta.url)
  : new URL("../../", import.meta.url);
const BACKEND = new URL("../", import.meta.url);
const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);

function read(url) {
  return readFileSync(url, "utf8");
}

function productionFiles(directory, suffixes) {
  const result = [];
  const visit = (url) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
      if (entry.isDirectory()) visit(child);
      else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) result.push(child);
    }
  };
  visit(directory);
  return result;
}

test("Stage 6 removes the retired START Store action, state, selector, and shell facade", () => {
  const paths = [
    "js/core/store-contract.js",
    "js/core/store-state.js",
    "js/core/store-window-transition.js",
    "js/core/actions.js",
  ];
  const source = paths.map((path) => read(new URL(path, WEBUI))).join("\n");
  for (const retired of [
    "UI_START_MENU_CHANGED",
    "startMenuChanged",
    "startMenuOpen",
    "setStartMenuOpen",
    "START 菜单状态",
  ]) {
    assert.doesNotMatch(source, new RegExp(retired), retired);
  }
  assert.doesNotMatch(read(new URL("js/core/store-window-transition.js", WEBUI)), /function\s+requireBoolean\b/);
});

test("Stage 6 deletes the production placeholder module and placeholder-only shell helpers", () => {
  assert.equal(existsSync(new URL("js/apps/placeholder.js", WEBUI)), false);
  const emptyState = read(new URL("js/components/empty-state.js", WEBUI));
  for (const retired of [
    "createApplicationShell",
    "createPlaceholderShell",
    "createCapabilityList",
    "createNavigation",
    "deferred-capabilities",
    "deferred-actions",
  ]) assert.doesNotMatch(emptyState, new RegExp(retired), retired);
  assert.match(emptyState, /export function createEmptyState/);
});

test("Stage 6 availability metadata is exactly ready or preview", () => {
  const definitions = read(new URL("js/core/app-definitions.js", WEBUI));
  const center = read(new URL("js/components/application-center.js", WEBUI));
  assert.match(definitions, /new Set\(\["ready", "preview"\]\)/);
  assert.doesNotMatch(`${definitions}\n${center}`, /\bplaceholder\b/);
  assert.equal((definitions.match(/availability:\s*"ready"/g) || []).length, 8);
  assert.equal((definitions.match(/availability:\s*"preview"/g) || []).length, 3);
});

test("Stage 6 production CSS contains no retired desktop selectors or taskbar token", () => {
  const desktop = read(new URL("styles/desktop.css", WEBUI));
  const controls = read(new URL("styles/controls.css", WEBUI));
  const tokens = read(new URL("styles/tokens.css", WEBUI));
  for (const selector of [
    ".desktop-icons",
    ".desktop-icon",
    ".start-menu",
    ".taskbar",
    ".start-button",
    ".task-window-button",
    ".task-window-overflow",
    ".taskbar-status",
    ".clock",
    ".window-actions",
  ]) {
    const pattern = new RegExp(`(?:^|[,\\s])${selector.replace(".", "\\.")}(?=[\\s,:.{#\\[]|$)`, "m");
    assert.doesNotMatch(`${desktop}\n${controls}`, pattern, selector);
  }
  assert.doesNotMatch(tokens, /--imageweave-taskbar-height/);
  assert.match(desktop, /\.dock__/);
  assert.match(desktop, /\.menu-bar/);
  assert.match(desktop, /\.window-traffic-light/);
});

test("Stage 6 production CSS uses thin modern state borders", () => {
  const cssFiles = productionFiles(new URL("styles/", WEBUI), [".css"]);
  const decorative = /(?:border(?:-(?:top|right|bottom|left))?(?:-style)?\s*:[^;\n]*\b(?:double|dotted|dashed)\b|outline\s*:[^;\n]*\b(?:double|dotted|dashed)\b)/i;
  const failures = cssFiles
    .map((path) => [path, read(path)])
    .filter(([, source]) => decorative.test(source))
    .map(([path]) => path.pathname.split("/webui/")[1]);
  assert.deepEqual(failures, []);
});

test("Stage 6 user-visible production text uses natural application names", () => {
  const webuiSources = productionFiles(new URL("js/", WEBUI), [".js"]);
  const backendSources = productionFiles(new URL("gdl_backend/", BACKEND), [".py"]);
  const executableName = /\b[A-Z][A-Z0-9_-]*\.(?:EXE|CPL)\b/;
  const failures = [...webuiSources, ...backendSources]
    .map((path) => [path, read(path)])
    .filter(([, source]) => executableName.test(source))
    .map(([path]) => path.pathname.split("/gallery-dl-backend/").at(-1));
  assert.deepEqual(failures, []);
});

test("Stage 6 README and current WebUI docs describe the final shell and preview boundary", () => {
  const readme = read(new URL("README.md", REPOSITORY));
  const backendDoc = read(new URL("docs/gallery-dl-backend.md", REPOSITORY));
  const architecture = read(new URL("docs/ARCHITECTURE.md", REPOSITORY));
  const fixtureReadme = read(new URL("tests/fixtures/webui/README.md", BACKEND));

  assert.match(readme, /裸[^\n]*\/ui\/[^\n]*空[^\n]*玻璃桌面/);
  assert.match(readme, /8[^\n]*真实应用/);
  assert.match(readme, /3[^\n]*前端预览[^\n]*0[^\n]*业务 API/);
  assert.match(readme, /Dock/);
  assert.match(readme, /应用中心/);
  assert.doesNotMatch(readme, /开发中[^\n]*占位|占位入口/);

  for (const source of [backendDoc, architecture]) {
    assert.doesNotMatch(source, /\b[A-Z][A-Z0-9_-]*\.(?:EXE|CPL)\b/);
    assert.match(source, /imageweave\.window-placements\.v2/);
    assert.match(source, /11[^\n]*应用/);
    assert.match(source, /3[^\n]*preview|3[^\n]*前端预览/i);
    assert.match(source, /0[^\n]*业务 API/);
  }
  assert.match(backendDoc, /不[^\n]*恢复[^\n]*(?:运行|焦点|最小化|窗口)/);
  assert.match(architecture, /五层|five-layer/i);
  assert.doesNotMatch(fixtureReadme, /intentionally\s+(?:a\s+)?red|phase\s*0[^\n]*red|coverage suite remains/i);
  assert.match(fixtureReadme, /Stage 5|阶段 5/);
  assert.match(fixtureReadme, /assets\/example\.png/);
});

test("Stage 6 README screenshot has fixed safe production provenance", () => {
  const imageUrl = new URL("assets/example.png", REPOSITORY);
  const metadataUrl = new URL("assets/example.json", REPOSITORY);
  assert.equal(existsSync(imageUrl), true);
  assert.equal(existsSync(metadataUrl), true);
  const image = readFileSync(imageUrl);
  const metadata = JSON.parse(read(metadataUrl));
  assert.deepEqual(Object.keys(metadata).toSorted(), [
    "browser",
    "capture_method",
    "file",
    "route",
    "runtime_data",
    "schema_version",
    "sha256",
    "source",
    "viewport",
  ]);
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.file, "example.png");
  assert.equal(metadata.source, "production-create-app");
  assert.equal(metadata.route, "#/tasks");
  assert.equal(metadata.runtime_data, false);
  assert.deepEqual(metadata.viewport, { width: 1440, height: 900, device_scale_factor: 1 });
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 1440);
  assert.equal(image.readUInt32BE(20), 900);
  assert.equal(createHash("sha256").update(image).digest("hex"), metadata.sha256);
  const provenance = JSON.stringify(metadata);
  assert.doesNotMatch(provenance, /(?:\/home\/|runtime\/downloads|tests\/fixtures|file:\/\/)/);
});

test("Stage 6 production closure has no fixtures, remote assets, data URIs, or invalid image references", () => {
  const production = productionFiles(WEBUI, [".html", ".css", ".js"])
    .map((path) => [path, read(path)]);
  const failures = [];
  for (const [path, source] of production) {
    const relative = path.pathname.split("/webui/")[1];
    for (const forbidden of [
      /tests\/fixtures|fixtures\/webui|stage5-preview-fixtures|testsOnly/,
      /@import\s+url/,
      /data:(?:image|font)/,
      /runtime\/downloads|file:\/\//,
    ]) if (forbidden.test(source)) failures.push(`${relative}: ${forbidden}`);
    if (/\.html$|\.css$/.test(relative) && /https?:\/\//.test(source)) {
      failures.push(`${relative}: remote asset URL`);
    }
  }
  assert.deepEqual(failures, []);
  const index = read(new URL("index.html", WEBUI));
  for (const match of index.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)) {
    assert.equal(existsSync(new URL(match[1], WEBUI)), true, match[1]);
  }
});
