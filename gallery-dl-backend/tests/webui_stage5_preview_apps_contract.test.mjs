import { existsSync } from "node:fs";
import { readSourceText as readFileSync } from "./source-test-text.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import galleryApplication, { createGalleryController } from "../gdl_backend/webui/js/apps/gallery.js";
import exportApplication, { createExportController } from "../gdl_backend/webui/js/apps/export.js";
import {
  createGalleryUiState,
  galleryPresentation,
  projectGalleryState,
  toggleGallerySelection,
  updateGalleryUiState,
  visibleGalleryItems,
} from "../gdl_backend/webui/js/core/gallery-model.js";
import {
  exportPresentation,
  exportSelectionFacts,
  projectExportState,
  toggleExportSource,
  updateExportConfig,
} from "../gdl_backend/webui/js/core/export-model.js";
import {
  TESTS_ONLY_STAGE5,
  exportFixtures,
  galleryFixtures,
} from "./fixtures/webui/stage5-preview-fixtures.js";

const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const REGISTRY_SOURCE = readFileSync(new URL("js/core/app-registry.js", WEBUI), "utf8");
const INDEX_SOURCE = readFileSync(new URL("index.html", WEBUI), "utf8");

const PREVIEW_APPS = Object.freeze(["gallery", "export"]);
const SECRET_PARTS = ["stage5", "private", "value", "271828"];
const SECRET = SECRET_PARTS.join("-");
const APP_MODULES = Object.freeze({ gallery: galleryApplication, export: exportApplication });
const APP_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/apps/${appId}.js`, WEBUI), "utf8")]));
const MODEL_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/core/${appId}-model.js`, WEBUI), "utf8")]));
const VIEW_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/components/${appId}-view.js`, WEBUI), "utf8")]));
const CSS_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`styles/apps/${appId}.css`, WEBUI), "utf8")]));
const FIXTURE_SOURCE = readFileSync(new URL("fixtures/webui/stage5-preview-fixtures.js", import.meta.url), "utf8");
const FIXTURE_HOST_SOURCE = readFileSync(new URL("fixtures/webui/stage5-preview-host.js", import.meta.url), "utf8");

function sourceExists(path) {
  return existsSync(new URL(path, WEBUI));
}

test("Stage 5 registry uses two independent preview controllers instead of placeholders", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(
      REGISTRY_SOURCE,
      new RegExp(`import\\s+${appId}Application\\s+from\\s+["']\\.\\./apps/${appId}\\.js["']`),
      `${appId} must have an explicit production controller import`,
    );
    assert.doesNotMatch(
      REGISTRY_SOURCE,
      new RegExp(`\\[\\s*["']${appId}["'][^\\n]*createPlaceholderApplication`),
      `${appId} must not use createPlaceholderApplication`,
    );
  }
});

test("Stage 5 production model, view, controller, and stylesheet modules exist per app", () => {
  for (const appId of PREVIEW_APPS) {
    assert.equal(sourceExists(`js/apps/${appId}.js`), true, `${appId} controller is missing`);
    assert.equal(sourceExists(`js/core/${appId}-model.js`), true, `${appId} model is missing`);
    assert.equal(sourceExists(`js/components/${appId}-view.js`), true, `${appId} view is missing`);
    assert.equal(sourceExists(`styles/apps/${appId}.css`), true, `${appId} stylesheet is missing`);
  }
});

test("Stage 5 index explicitly loads all preview application styles", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(INDEX_SOURCE, new RegExp(`href=["']\\./styles/apps/${appId}\\.css["']`));
  }
});

test("Stage 5 preview production boundary declares no guessed business endpoints", () => {
  for (const appId of PREVIEW_APPS) {
    const paths = [
      `js/apps/${appId}.js`,
      `js/core/${appId}-model.js`,
      `js/components/${appId}-view.js`,
    ];
    for (const path of paths) {
      if (!sourceExists(path)) continue;
      const source = readFileSync(new URL(path, WEBUI), "utf8");
      assert.doesNotMatch(source, /\/api\//, `${path} must not declare a business API path`);
    }
  }
});

test("Stage 5 model state machines project loading/empty/content/error fixtures immutably", () => {
  assert.equal(TESTS_ONLY_STAGE5, true);
  const tables = [
    [projectGalleryState, galleryFixtures, ["loading", "empty", "content", "error"]],
    [projectExportState, exportFixtures, ["loading", "empty", "content", "error"]],
  ];
  for (const [project, fixtures, phases] of tables) {
    for (const phase of phases) {
      const state = project(fixtures[phase]);
      assert.equal(state.phase, phase);
      assert.equal(Object.isFrozen(state), true);
    }
    assert.equal(project({ phase: "unavailable" }).phase, "unavailable");
  }
  assert.equal(galleryPresentation(galleryFixtures.content).state, "content");
  assert.equal(exportPresentation(exportFixtures.loading).state, "loading");
});

test("Stage 5 strict projections reject non-plain, dangerous, accessor, enum/count/text, and secret-shaped fields", () => {
  const projectors = [projectGalleryState, projectExportState];
  for (const project of projectors) {
    assert.throws(() => project([]), TypeError);
    assert.throws(() => project(new (class State { constructor() { this.phase = "empty"; } })()), TypeError);
    assert.throws(() => project(JSON.parse('{"phase":"empty","__proto__":{"polluted":true}}')), TypeError);
    const accessor = { phase: "empty" };
    Object.defineProperty(accessor, "payload", { enumerable: true, get() { throw new Error(SECRET); } });
    assert.throws(() => project(accessor), TypeError);
    assert.equal({}.polluted, undefined);
  }

  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], width: Number.NaN,
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], mediaVariant: "unknown",
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], label: "x".repeat(100),
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], path: `/private/${SECRET}`,
  }] }), TypeError);
  assert.throws(() => projectExportState({ phase: "content", ...exportFixtures.content, progress: {
    ...exportFixtures.content.progress, total: Number.NaN,
  } }), TypeError);
  assert.throws(() => projectExportState({ phase: "content", ...exportFixtures.content, config: {
    ...exportFixtures.content.config, destinationPath: `/private/${SECRET}`,
  } }), TypeError);
});

test("Stage 5 projections never retain paths, URLs, credentials, raw errors, filenames, or runtime image fields", () => {
  const gallery = structuredClone(galleryFixtures.content);
  gallery.items[0].url = `https://private.invalid/${SECRET}`;
  const exported = structuredClone(exportFixtures.content);
  exported.config.destinationPath = `/private/${SECRET}`;
  for (const [project, value] of [
    [projectGalleryState, gallery], [projectExportState, exported],
  ]) {
    assert.throws(() => project(value), TypeError);
  }
  const safe = JSON.stringify({
    gallery: projectGalleryState(galleryFixtures.content),
    exported: projectExportState(exportFixtures.content),
  });
  for (const forbidden of [SECRET, "https://", "/private/", "filename", "cookie", "password", "secret", "raw error", "details"] ) {
    assert.equal(safe.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("Gallery interactions are deterministic: collection, search, sort, mode, selection and Quick Look id", () => {
  const state = projectGalleryState(galleryFixtures.content);
  let ui = createGalleryUiState();
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-06", "media-05", "media-04", "media-03", "media-02", "media-01"]);
  ui = updateGalleryUiState(ui, { query: "绿色", sort: "label", mode: "list" }, state.items);
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-03"]);
  ui = updateGalleryUiState(ui, { query: "", collection: "favorites" }, state.items);
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-03", "media-06", "media-01"]);
  ui = toggleGallerySelection(ui, "media-03", state.items);
  ui = toggleGallerySelection(ui, "media-01", state.items, { additive: true });
  assert.deepEqual(ui.selectedIds, ["media-03", "media-01"]);
  ui = updateGalleryUiState(ui, { inspectorOpen: false, quickLookId: "media-03" }, state.items);
  assert.equal(ui.inspectorOpen, false);
  assert.equal(ui.quickLookId, "media-03");
  assert.throws(() => updateGalleryUiState(ui, { quickLookId: "missing" }, state.items), TypeError);
});

test("Export source/config and deterministic running/success/error facts never use timers", () => {
  let state = projectExportState(exportFixtures.content);
  assert.deepEqual(exportSelectionFacts(state), { sourceCount: 2, itemCount: 276, reviewedCount: 276 });
  state = toggleExportSource(state, "source-partial");
  assert.deepEqual(exportSelectionFacts(state), { sourceCount: 3, itemCount: 356, reviewedCount: 328 });
  state = updateExportConfig(state, { format: "coco", shardSize: 50, includeRejected: true });
  assert.equal(state.config.format, "coco");
  assert.equal(state.config.shardSize, 50);
  assert.deepEqual(
    ["running", "success", "resultError"].map((name) => {
      const progress = projectExportState(exportFixtures[name]).progress;
      return [progress.state, progress.completed, progress.total, progress.code, progress.category];
    }),
    [
      ["running", 148, 276, "", ""],
      ["success", 276, 276, "", ""],
      ["error", 148, 276, "export_fixture_interrupted", "capability"],
    ],
  );
  assert.doesNotMatch(`${APP_SOURCES.export}\n${MODEL_SOURCES.export}\n${VIEW_SOURCES.export}`, /setTimeout|setInterval|requestAnimationFrame/);
  assert.match(VIEW_SOURCES.export, /aria-valuenow/);
  assert.match(VIEW_SOURCES.export, /aria-valuetext/);
  assert.match(VIEW_SOURCES.export, /\$\{percent\}%/);
  assert.match(VIEW_SOURCES.export, /下一步：检查导出能力状态后重试/);
});

test("Stage 5 controllers use unavailable adapters, make zero API calls, and stale reads stay inert", async () => {
  class TestRoot {
    constructor() { this.hidden = false; this.inert = false; this.dataset = {}; this.listeners = new Map(); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    toggleAttribute(name, enabled) { if (name === "inert") this.inert = Boolean(enabled); }
    removeAttribute(name) { if (name === "data-lifecycle") delete this.dataset.lifecycle; }
    querySelector() { return null; }
  }
  const previousElement = globalThis.Element;
  const previousHtmlElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "Element", { configurable: true, value: TestRoot });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: TestRoot });
  try {
    const constructors = [
      [createGalleryController, { phase: "content", items: galleryFixtures.content.items }],
      [createExportController, exportFixtures.content],
    ];
    for (const [createController, fixture] of constructors) {
      const root = new TestRoot();
      const calls = [];
      let resolveRead;
      const readPromise = new Promise((resolve) => { resolveRead = resolve; });
      const viewLog = [];
      const view = {
        render(state) { viewLog.push(state.phase); },
        getUiState() { return createGalleryUiState(); },
        closeQuickLook() { return false; }, releaseMedia() {}, destroy() { viewLog.push("destroy"); },
      };
      const controller = createController({ root, app: {} , api: { get() { calls.push("get"); }, post() { calls.push("post"); } } }, {
        adapter: { read: () => readPromise },
        createView: () => view,
      });
      controller.activate();
      controller.deactivate();
      resolveRead(fixture);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(calls, []);
      assert.equal(controller.getState().phase, "unavailable");
      assert.equal(root.hidden, true);
      assert.equal(root.inert, true);
      controller.destroy();
      assert.equal(viewLog.at(-1), "destroy");
      for (const listeners of root.listeners.values()) assert.equal(listeners.size, 0);
    }

  } finally {
    if (previousElement === undefined) delete globalThis.Element;
    else Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
    if (previousHtmlElement === undefined) delete globalThis.HTMLElement;
    else Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHtmlElement });
  }
});

test("Stage 5 applications expose complete lifecycle and production registry has zero placeholder use", () => {
  for (const [appId, application] of Object.entries(APP_MODULES)) {
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) assert.equal(typeof application[hook], "function", `${appId}.${hook}`);
  }
  assert.doesNotMatch(REGISTRY_SOURCE, /createPlaceholderApplication/);
  assert.doesNotMatch(REGISTRY_SOURCE, /apps\/placeholder\.js/);
});

test("Stage 5 fixture host is explicit tests-only injection and production source closure has zero fixture references", () => {
  assert.match(FIXTURE_SOURCE, /TESTS_ONLY_STAGE5\s*=\s*true/);
  assert.match(FIXTURE_HOST_SOURCE, /testsOnly:\s*true/);
  assert.match(FIXTURE_HOST_SOURCE, /createGalleryController/);
  assert.match(FIXTURE_HOST_SOURCE, /createExportController/);
  for (const mediaBoundary of [
    /createGalleryMediaFixture/,
    /new Image\(\)/,
    /URL\.createObjectURL/,
    /URL\.revokeObjectURL/,
    /addEventListener\("load"/,
    /addEventListener\("error"/,
    /removeEventListener\("load"/,
    /removeEventListener\("error"/,
    /MutationObserver/,
    /adapterState\s*\|\|\s*initialState/,
    /balancedObjectUrls/,
    /balancedListeners/,
    /ignoredLateEvents/,
  ]) assert.match(FIXTURE_HOST_SOURCE, mediaBoundary);
  const production = [REGISTRY_SOURCE, ...Object.values(APP_SOURCES), ...Object.values(MODEL_SOURCES), ...Object.values(VIEW_SOURCES)].join("\n");
  assert.doesNotMatch(production, /stage5-preview-fixtures|stage5-preview-host|tests\/fixtures|fixtures\/webui|testsOnly/);
  assert.doesNotMatch(production, /createGalleryMediaFixture|GALLERY_ERROR_MEDIA_TOKEN/);
});

test("Stage 5 static security and rendering boundaries forbid bypass I/O, unsafe DOM, runtime media, and fixture imports", () => {
  for (const appId of PREVIEW_APPS) {
    const combined = `${APP_SOURCES[appId]}\n${MODEL_SOURCES[appId]}\n${VIEW_SOURCES[appId]}`;
    for (const forbidden of [
      /\bfetch\s*\(/, /globalThis\.fetch/, /XMLHttpRequest/, /localStorage|sessionStorage|indexedDB/,
      /console\./, /innerHTML/, /URL\.createObjectURL/, /\bBlob\b/, /data:image/, /\/api\//,
      /tests\/fixtures|fixtures\/webui/,
    ]) assert.doesNotMatch(combined, forbidden, `${appId}: ${forbidden}`);
  }
  assert.doesNotMatch(`${VIEW_SOURCES.gallery}\n${MODEL_SOURCES.gallery}`, /<img|document\.createElement\(["']img|\.src\s*=/i);
  assert.doesNotMatch(`${APP_SOURCES.export}\n${MODEL_SOURCES.export}\n${VIEW_SOURCES.export}`, /fixture|夹具|setTimeout|setInterval|requestAnimationFrame/i);
});

test("Stage 5 CSS preserves preview layouts while all T8 previews use canonical nocturne glass", () => {
  for (const appId of PREVIEW_APPS) {
    const css = CSS_SOURCES[appId];
    assert.match(css, new RegExp(`\\.${appId}-workspace\\s*\\{[\\s\\S]*overflow-x:\\s*auto[\\s\\S]*overflow-y:\\s*hidden`));
    assert.match(css, new RegExp(`\\.${appId}-column-scroll(?:\\s*,[^\\{]+)?\\s*\\{[\\s\\S]*?overflow-y:\\s*auto`));
    assert.match(css, /application-window\[data-maximized\]/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /data-motion="off"/);
    assert.match(css, /forced-colors:\s*active/);
    assert.match(css, /Canvas/);
    assert.match(css, /ButtonFace/);
    assert.match(css, /Highlight/);
    assert.doesNotMatch(css, /@media\s*\((?:max-width|max-height)/);
  }

  const exportCss = CSS_SOURCES.export;
  assert.doesNotMatch(exportCss, /--imageweave-(?:surface-(?:content|navigation|control)-solid|state-[\w-]*-surface(?:-solid)?)/);
  assert.doesNotMatch(exportCss, /text-transform:\s*uppercase|letter-spacing:\s*0\.0[6-9]em|inset\s+3px\s+0\s+0/);
  for (const expected of [
    "padding: 24px",
    "gap: 24px",
    "min-width: 1100px",
    "border: var(--imageweave-border-width) solid var(--imageweave-border-default)",
    "border-radius: var(--imageweave-radius-card)",
    "background: var(--imageweave-glass-surface-secondary)",
    "background: var(--imageweave-glass-surface-input)",
    "background: var(--imageweave-glass-surface-weak)",
    "border-radius: var(--imageweave-radius-control)",
    "background: var(--imageweave-glass-surface-button)",
    "background: var(--imageweave-glass-surface-hover)",
    "border-color: var(--imageweave-border-focus)",
    'content: "◆ 已选择"',
    "transform: none",
    "transition: width var(--imageweave-transition-standard)",
  ]) assert.match(exportCss, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(exportCss, /\.export-column\s*\{[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)[\s\S]*?inset 0 1px 0[\s\S]*?inset 0 -1px 0/);
  assert.match(exportCss, /\.export-source-card:hover,[\s\S]*?transform:\s*none/);
  assert.match(exportCss, /\.export-source-card\[data-selected="true"\]\s*\{[\s\S]*?border-color:\s*var\(--imageweave-border-focus\)/);
  assert.match(exportCss, /data-export-workspace-state="loading"[\s\S]*?border-color:\s*var\(--imageweave-state-running\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(exportCss, /data-export-workspace-state="error"[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  for (const [state, color] of [["running", "running"], ["success", "success"], ["error", "danger"]]) {
    assert.match(exportCss, new RegExp(`\\.export-progress-card--${state}\\s*\\{[\\s\\S]*?(?:border(?:-color)?:)[\\s\\S]*?var\\(--imageweave-state-${color}\\)`));
    assert.match(exportCss, new RegExp(`\\.export-progress-card--${state} \\.export-progress-fill\\s*\\{[\\s\\S]*?background:\\s*var\\(--imageweave-state-${color}\\)`));
  }
  assert.equal(
    exportCss.split("\n").filter((line) => /^\s*(?:-webkit-)?backdrop-filter:/.test(line) && !/:\s*none/.test(line)).length,
    0,
    "Export rows must inherit the application window backdrop",
  );
  assert.match(exportCss, /@supports not[\s\S]*?--imageweave-fallback-elevated-solid/);
  assert.match(exportCss, /prefers-contrast:\s*more/);
  assert.match(exportCss, /forced-colors:\s*active[\s\S]*?background-image:\s*none[\s\S]*?backdrop-filter:\s*none/);


  const css = CSS_SOURCES.gallery;
  assert.doesNotMatch(css, /--imageweave-(?:surface-(?:content|navigation|control)-solid|state-[\w-]*-surface-solid)/);
  assert.doesNotMatch(css, /text-transform:\s*uppercase|letter-spacing:\s*0\.0[6-9]em|inset\s+3px\s+0\s+0/);
  for (const expected of [
    "padding: 24px",
    "gap: 24px",
    "min-width: 1100px",
    "border: var(--imageweave-border-width) solid var(--imageweave-border-default)",
    "border-radius: var(--imageweave-radius-card)",
    "background: var(--imageweave-glass-surface-input)",
    "background: var(--imageweave-glass-surface-secondary)",
    "border-radius: var(--imageweave-radius-control)",
    "background: var(--imageweave-glass-surface-weak)",
    "background: var(--imageweave-glass-surface-button)",
    "background: var(--imageweave-glass-surface-hover)",
    "border-color: var(--imageweave-border-focus)",
    'content: "◆ 已选择"',
    "transform: none",
    "transition: none",
    "height: min(48vh, 480px)",
  ]) assert.match(css, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(css, /\.gallery-media-card:hover,[\s\S]*?transform:\s*none/);
  assert.match(css, /\.gallery-media-card\[data-selected="true"\]\s*\{[\s\S]*?border-color:\s*var\(--imageweave-border-focus\)/);
  assert.match(VIEW_SOURCES.gallery, /role:\s*"option"[\s\S]*?"aria-selected":\s*String\(selected\)[\s\S]*?已选择/);

  assert.match(css, /\.gallery-media-preview\s*\{[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)[\s\S]*?border-radius:\s*var\(--imageweave-radius-control\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(css, /\.gallery-media-preview\s*>\s*img,[\s\S]*?object-fit:\s*contain[\s\S]*?opacity:\s*1[\s\S]*?filter:\s*none[\s\S]*?mix-blend-mode:\s*normal[\s\S]*?transition:\s*none/);
  assert.match(css, /data-gallery-media-state="loading"/);
  assert.match(css, /data-gallery-media-state="error"/);

  assert.match(css, /data-gallery-workspace-state="loading"[\s\S]*?border-color:\s*var\(--imageweave-state-running\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(css, /data-gallery-workspace-state="error"[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-default\)/);

  assert.match(css, /\.gallery-quick-look__dialog\s*\{[\s\S]*?border-radius:\s*var\(--imageweave-radius-window\)[\s\S]*?background-color:\s*var\(--imageweave-glass-surface-default\)[\s\S]*?rgb\(255 255 255 \/ 0\.12\)[\s\S]*?box-shadow:\s*var\(--imageweave-shadow-window\)/);
  const supported = css.split("@supports ((-webkit-backdrop-filter", 2)[1].split("@supports not", 1)[0];
  assert.match(supported, /\.gallery-quick-look__dialog/);
  assert.match(supported, /blur\(var\(--imageweave-glass-blur-window\)\)/);
  assert.match(supported, /saturate\(var\(--imageweave-glass-saturation\)\)/);
  assert.equal(
    css.split("\n").filter((line) => /^\s*(?:-webkit-)?backdrop-filter:/.test(line) && !/:\s*none/.test(line)).length,
    2,
    "Quick Look must be Gallery's only independent backdrop selector",
  );
  assert.match(css, /@supports not[\s\S]*?--imageweave-fallback-elevated-solid/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /forced-colors:\s*active[\s\S]*?background-image:\s*none[\s\S]*?backdrop-filter:\s*none/);
});

test("Stage 5 views declare disabled write reasons and Gallery Quick Look keyboard/release contracts", () => {
  for (const [appId, source] of Object.entries(VIEW_SOURCES)) {
    assert.match(source, new RegExp(`${appId}-write-reason`));
    assert.match(source, /aria-describedby/);
  }
  for (const phrase of ["导入", "删除", "在文件夹中显示", "写入标签", "导出所选"]) assert.match(VIEW_SOURCES.gallery, new RegExp(phrase));
  for (const phrase of ["选择目标", "开始导出", "取消导出", "打开结果"]) assert.match(VIEW_SOURCES.export, new RegExp(phrase));
  for (const fingerprint of [
    "动作已禁用，不会写入文件、读取路径或发送业务请求",
    'role: "progressbar"', '"aria-valuemin": "0"', '"aria-valuemax": String(maximum)',
    '"aria-valuenow": String(progress.completed)', '"aria-valuetext": valueText',
    'role: "status"', '"aria-live": "polite"', '"aria-atomic": "true"',
    "受控状态提供确定性进度", "错误事实：", "下一步：", "界面不会自行启动计时器",
  ]) assert.match(VIEW_SOURCES.export, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const stateName of ["loading", "empty", "content", "running", "success", "resultError", "error"]) {
    assert.match(FIXTURE_SOURCE, new RegExp(`\\b${stateName}:\\s*freeze\\(`));
  }
  for (const fingerprint of [
    'role: "dialog"', '"aria-modal": "true"', 'attributes: { id: "gallery-quick-look-description" }',
    "trapQuickLookFocus", "event.key !== \"Tab\"",
    "quickLookReturnFocus", "event.key === \"Escape\"", "view.releaseMedia()", "preview.replaceChildren()",
    "ArrowLeft", "ArrowRight", "EDITABLE_SELECTOR",
  ]) assert.match(`${APP_SOURCES.gallery}\n${VIEW_SOURCES.gallery}`, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(APP_SOURCES.export, /createExportUnavailableAdapter\(\)/);
  assert.match(APP_SOURCES.export, /projectExportState\(\{ phase: "unavailable" \}\)/);
  assert.doesNotMatch(`${APP_SOURCES.export}\n${MODEL_SOURCES.export}\n${VIEW_SOURCES.export}`, /context\.api|\/api\/|stage5-preview-fixtures|testsOnly|fetch\(|XMLHttpRequest/);
  assert.match(FIXTURE_HOST_SOURCE, /createExportController/);
  assert.match(FIXTURE_HOST_SOURCE, /adapterState\s*\|\|\s*initialState/);
});
