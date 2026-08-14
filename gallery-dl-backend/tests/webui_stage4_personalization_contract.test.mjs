import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_WALLPAPER_COLOR_IDS,
  derivePersonalizationPreview,
  normalizePersonalizationPreferences,
  PERSONALIZATION_DEFAULTS,
  PERSONALIZATION_PREFERENCE_KEYS,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
} from "../gdl_backend/webui/js/core/personalization-model.js";
import {
  createPersonalizationView,
  PERSONALIZATION_SCENE_CHOICES,
} from "../gdl_backend/webui/js/components/personalization-view.js";
import {
  cleanupLegacyCustomWallpaper,
  WALLPAPER_STORAGE_SCHEMA,
} from "../gdl_backend/webui/js/core/wallpaper-storage.js";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEBUI_ROOT = resolve(TEST_ROOT, "../gdl_backend/webui");
const readWebui = (path) => readFileSync(resolve(WEBUI_ROOT, path), "utf8");
const APP_SOURCE = readWebui("js/apps/personalization.js");
const MODEL_SOURCE = readWebui("js/core/personalization-model.js");
const VIEW_SOURCE = readWebui("js/components/personalization-view.js");
const RUNTIME_SOURCE = readWebui("js/core/personalization.js");
const STORAGE_SOURCE = readWebui("js/core/wallpaper-storage.js");
const MAIN_SOURCE = readWebui("js/main.js");
const INDEX_SOURCE = readWebui("index.html");
const CSS_SOURCE = readWebui("styles/apps/personalization.css");
const CONTROLS_CSS_SOURCE = readWebui("styles/controls.css");
const DESKTOP_CSS_SOURCE = readWebui("styles/desktop.css");

function personalizationCssBlock(selector) {
  const marker = `${selector} {`;
  const start = CSS_SOURCE.indexOf(marker);
  assert.notEqual(start, -1, selector);
  const opening = CSS_SOURCE.indexOf("{", start);
  const closing = CSS_SOURCE.indexOf("}", opening);
  return CSS_SOURCE.slice(opening + 1, closing);
}

function state({ committed = {}, draft = {}, busy = false, systemReduced = false } = {}) {
  const committedPreferences = projectPersonalizationPreferences({
    ...PERSONALIZATION_DEFAULTS,
    ...committed,
  });
  const draftPreferences = projectPersonalizationPreferences({
    ...committedPreferences,
    ...draft,
  });
  return {
    committed: committedPreferences,
    draft: draftPreferences,
    dirty: !personalizationPreferencesEqual(committedPreferences, draftPreferences),
    busy,
    motion: {
      userMode: draftPreferences.animations,
      systemReduced,
      effective: draftPreferences.animations === "on" && !systemReduced,
      limitedBySystem: draftPreferences.animations === "on" && systemReduced,
    },
  };
}

function installViewDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  class TestNode {}
  class TestElement extends TestNode {
    constructor(tagName = "div") {
      super();
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.scrollLeft = 0;
    }
    setAttribute(name, value) {
      const normalized = String(value);
      this.attributes.set(name, normalized);
      if (name === "value") this.value = normalized;
      if (name === "type") this.type = normalized;
      if (name === "name") this.name = normalized;
      if (name === "id") this.id = normalized;
      if (name === "hidden") this.hidden = true;
      if (name === "disabled") this.disabled = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "hidden") this.hidden = false;
      if (name === "disabled") this.disabled = false;
    }
    append(...children) {
      for (const child of children) {
        if (child instanceof TestElement) child.parentElement = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    focus() { globalThis.document.activeElement = this; }
    scrollBy(options) {
      this.lastScrollBy = options;
      this.scrollLeft += Number(options?.left || 0);
    }
  }
  class TestButton extends TestElement {}
  class TestForm extends TestElement {}
  install("Node", TestNode);
  install("Element", TestElement);
  install("HTMLElement", TestElement);
  install("HTMLButtonElement", TestButton);
  install("HTMLFormElement", TestForm);
  install("document", {
    activeElement: null,
    createElement(tagName) {
      if (tagName === "button") return new TestButton(tagName);
      if (tagName === "form") return new TestForm(tagName);
      return new TestElement(tagName);
    },
  });

  const descendants = (element) => [
    element,
    ...(element.children || []).flatMap((child) => (
      child instanceof TestElement ? descendants(child) : []
    )),
  ];
  return {
    root: new TestElement("main"),
    descendants,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function deletionFixture({ store = true, failDelete = false } = {}) {
  const calls = { opens: [], deletes: [], gets: 0, closes: 0 };
  const database = {
    objectStoreNames: { contains: () => store },
    transaction() {
      const transaction = {
        objectStore() {
          return {
            get() { calls.gets += 1; throw new Error("unexpected read"); },
            delete(key) {
              calls.deletes.push(key);
              const request = {};
              queueMicrotask(() => {
                if (failDelete) request.onerror?.();
                else transaction.oncomplete?.();
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
    close() { calls.closes += 1; },
  };
  return {
    calls,
    indexedDB: {
      open(...args) {
        calls.opens.push(args);
        const request = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  };
}

test("Personalization migration：六场景和 animations 保留，custom 与危险记录回退", () => {
  assert.deepEqual(PERSONALIZATION_PREFERENCE_KEYS, ["animations", "wallpaperColor"]);
  assert.deepEqual(BUILT_IN_WALLPAPER_COLOR_IDS, [
    "graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper",
  ]);
  for (const wallpaperColor of BUILT_IN_WALLPAPER_COLOR_IDS) {
    assert.deepEqual(normalizePersonalizationPreferences({
      animations: "off",
      wallpaperColor,
      wallpaperFit: "tile",
      themeAccent: "#FFFFFF",
    }), { animations: "off", wallpaperColor });
  }
  assert.deepEqual(normalizePersonalizationPreferences({
    animations: "off", wallpaperKind: "custom", wallpaperColor: "forest",
  }), { animations: "off", wallpaperColor: "graphite" });
  assert.deepEqual(normalizePersonalizationPreferences({
    animations: false, wallpaperColor: { id: "forest" },
  }), PERSONALIZATION_DEFAULTS);

  let getterReads = 0;
  const accessor = Object.create(null);
  Object.defineProperty(accessor, "wallpaperColor", {
    enumerable: true,
    get() { getterReads += 1; return "forest"; },
  });
  assert.deepEqual(normalizePersonalizationPreferences(accessor), PERSONALIZATION_DEFAULTS);
  assert.throws(() => projectPersonalizationPreferences(accessor), TypeError);
  assert.equal(getterReads, 0);
  const dangerous = JSON.parse('{"animations":"off","wallpaperColor":"forest","__proto__":{}}');
  assert.deepEqual(normalizePersonalizationPreferences(dangerous), PERSONALIZATION_DEFAULTS);
});

test("Personalization preview：只投影深色场景、motion 与 dirty 状态", () => {
  for (const choice of PERSONALIZATION_SCENE_CHOICES) {
    const preview = derivePersonalizationPreview(state({
      draft: { wallpaperColor: choice.id, animations: "off" },
    }));
    assert.equal(Object.isFrozen(preview), true);
    assert.equal(Object.isFrozen(preview.scene), true);
    assert.equal(preview.scene.id, choice.id);
    assert.equal(preview.scene.label, choice.label);
    assert.equal(preview.appearance.tone, "dark");
    assert.equal(preview.motion.statusId, "off");
    assert.equal(preview.status.id, "dirty");
    assert.equal(JSON.stringify(preview).includes("blob:"), false);
  }
  const limited = derivePersonalizationPreview(state({ systemReduced: true }));
  assert.equal(limited.motion.statusId, "system-limited");
  assert.match(limited.motion.message, /减少动态效果/);
  assert.throws(() => derivePersonalizationPreview({ ...state(), unknown: true }), TypeError);
  assert.throws(() => derivePersonalizationPreview({ ...state(), dirty: true }), TypeError);
});

test("Personalization DOM：场景 / 动效 / 应用三栏且不存在任意颜色或本地文件入口", () => {
  const dom = installViewDom();
  let view;
  try {
    view = createPersonalizationView({
      root: dom.root,
      app: { label: "外观设置", windowTitle: "DESKTOP.CPL" },
    });
    const { elements } = view;
    assert.equal(elements.form.children.length, 1);
    assert.equal(elements.workspaceTrack.children.length, 3);
    assert.deepEqual(
      elements.workspaceTrack.children.map((column) => column.children[0].children[1].textContent),
      ["场景", "动效", "应用"],
    );
    assert.equal(dom.root.className, "app-view personalization-app");
    assert.equal(Object.keys(elements.sceneInputs).length, 6);
    assert.equal(Object.keys(elements.sceneChoiceElements).length, 6);
    assert.equal(Object.keys(elements.scenePreviewCanvases).length, 6);
    assert.equal(Object.keys(elements.motionInputs).length, 2);
    assert.deepEqual(
      PERSONALIZATION_SCENE_CHOICES.map(({ label }) => label),
      ["夜航石墨", "月岩", "深海", "深林", "雾褐", "暖夜"],
    );
    for (const choice of PERSONALIZATION_SCENE_CHOICES) {
      assert.equal(elements.sceneInputs[choice.id].type, "radio");
      assert.match(elements.sceneInputs[choice.id].getAttribute("aria-describedby"), /-state$/);
      assert.match(
        elements.scenePreviewCanvases[choice.id].className,
        new RegExp(`desktop-wallpaper--${choice.id}$`),
      );
    }
    const all = dom.descendants(dom.root);
    assert.equal(all.filter((element) => ["color", "file"].includes(element.type)).length, 0);
    assert.equal(all.filter((element) => element.tagName === "FORM").length, 1);
    assert.equal(all.filter((element) => element.getAttribute("aria-live") === "polite").length >= 5, true);

    const previewState = state({ draft: { wallpaperColor: "deep-ocean", animations: "off" } });
    view.renderState(previewState);
    assert.equal(elements.previewDesktop.dataset.personalizationScene, "deep-ocean");
    assert.equal(elements.previewDesktop.dataset.personalizationMotion, "off");
    assert.match(elements.previewSceneCanvas.className, /desktop-wallpaper--deep-ocean$/);
    assert.equal(elements.sceneInputs["deep-ocean"].checked, true);
    assert.equal(elements.sceneChoiceElements["deep-ocean"].dataset.personalizationSelected, "true");
    assert.equal(elements.sceneChoiceElements["deep-ocean"].dataset.personalizationCurrent, "false");
    assert.match(elements.sceneInputs["deep-ocean"].parentElement.children.at(-1).textContent, /已选择/);
    assert.equal(elements.sceneChoiceElements.graphite.dataset.personalizationSelected, "false");
    assert.equal(elements.sceneChoiceElements.graphite.dataset.personalizationCurrent, "true");
    assert.match(elements.sceneInputs.graphite.parentElement.children.at(-1).textContent, /当前应用/);
    assert.equal(elements.motionChoiceElements.off.dataset.personalizationSelected, "true");
    assert.equal(elements.motionChoiceElements.on.dataset.personalizationCurrent, "true");
    assert.match(elements.previewSceneFact.textContent, /深海/);
    assert.match(elements.previewToneFact.textContent, /深色夜航玻璃/);
    assert.deepEqual(view.readDraft(previewState.draft), previewState.draft);
    assert.equal(elements.applyButton.disabled, false);
    assert.equal(elements.cancelButton.disabled, false);
  } finally {
    view?.destroy();
    dom.restore();
  }
});

test("Personalization CSS T7.5：三栏夜航玻璃、真实场景、扁平状态与 canonical a11y", () => {
  assert.match(CSS_SOURCE, /\.window-body:has\(> \.personalization-app\)\s*\{[^}]*padding\s*:\s*0[^}]*overflow\s*:\s*hidden/s);
  assert.match(CSS_SOURCE, /\.personalization-app\s*\{[^}]*grid-template-rows\s*:\s*auto minmax\(0,\s*1fr\)[^}]*height\s*:\s*100%[^}]*background\s*:\s*transparent/s);
  const workspace = personalizationCssBlock(".personalization-workspace");
  assert.match(workspace, /padding:\s*24px/);
  assert.match(workspace, /overflow-x:\s*auto/);
  assert.match(workspace, /overflow-y:\s*hidden/);
  const track = personalizationCssBlock(".personalization-workspace-track");
  assert.match(track, /grid-template-columns:[^;]*minmax[^;]*minmax[^;]*minmax/);
  assert.match(track, /gap:\s*24px/);
  assert.match(track, /min-width:\s*1120px/);
  const column = personalizationCssBlock(".personalization-column");
  assert.match(column, /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(column, /border-radius:\s*var\(--imageweave-radius-card\)/);
  assert.match(column, /background:\s*var\(--imageweave-glass-surface-input\)/);
  assert.match(column, /inset 0 1px 0/);
  assert.match(column, /inset 0 -1px 0/);
  assert.doesNotMatch(column, /backdrop-filter|var\(--imageweave-shadow-/);
  assert.match(
    personalizationCssBlock(".personalization-column:first-child,\n.personalization-column--apply"),
    /background:\s*var\(--imageweave-glass-surface-secondary\)/,
  );
  const columnScroll = personalizationCssBlock(".personalization-column-scroll");
  assert.match(columnScroll, /padding:\s*24px/);
  assert.match(columnScroll, /overflow-y:\s*auto/);
  assert.match(CSS_SOURCE, /\.application-window\[data-maximized\] \.personalization-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);

  const solidRefs = CSS_SOURCE.match(/--imageweave-[\w-]*-solid/g) || [];
  assert.deepEqual(solidRefs, ["--imageweave-fallback-elevated-solid"]);
  assert.doesNotMatch(CSS_SOURCE, /--imageweave-state-[\w-]*-surface/);
  assert.doesNotMatch(
    CSS_SOURCE,
    /^\s*(?:-webkit-)?backdrop-filter\s*:(?![^\n]*\bnone\b)/m,
  );
  assert.doesNotMatch(CSS_SOURCE, /^\s*filter\s*:/m);
  assert.doesNotMatch(CSS_SOURCE, /(?:border-(?:left|right):\s*[34]px|inset\s+[34]px\s+0(?:px)?\s+0)/);
  assert.match(
    CSS_SOURCE,
    /\.personalization-choice,[\s\S]*?\.personalization-preview-fact\s*\{[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)[\s\S]*?border-radius:\s*var\(--imageweave-radius-control\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-weak\)[\s\S]*?box-shadow:\s*none[\s\S]*?transform:\s*none/,
  );
  const panel = personalizationCssBlock(".personalization-app .personalization-panel");
  assert.match(panel, /border-bottom:[^;]*--imageweave-border-weak/);
  assert.match(panel, /background:\s*transparent/);
  assert.match(panel, /background-image:\s*none/);
  assert.match(panel, /box-shadow:\s*none/);

  // Every thumbnail and the read-only desktop consume the real desktop scene
  // classes; Personalization CSS does not duplicate six arbitrary color maps.
  assert.match(VIEW_SOURCE, /function sceneCanvasClass\(sceneId\)[\s\S]*desktop-wallpaper--\$\{sceneId\}/);
  assert.match(VIEW_SOURCE, /scenePreview:\s*true/);
  assert.match(VIEW_SOURCE, /previewSceneCanvas\.className\s*=\s*sceneCanvasClass\(preview\.scene\.id\)/);
  assert.doesNotMatch(CSS_SOURCE, /personalization-preview-desktop\[data-personalization-scene=/);
  assert.doesNotMatch(CSS_SOURCE, /#20242A|#384554|#20364A|#294039|#403341|#E7E1D6/i);
  const sceneCanvas = personalizationCssBlock(".personalization-scene-canvas");
  assert.match(sceneCanvas, /width:\s*1440px/);
  assert.match(sceneCanvas, /height:\s*900px/);
  assert.match(sceneCanvas, /scale\(0\.05\)/);
  const scenePreview = personalizationCssBlock(".personalization-choice__scene-preview");
  assert.match(scenePreview, /border-radius:\s*var\(--imageweave-radius-control\)/);
  assert.match(scenePreview, /background:\s*var\(--imageweave-background-deepest\)/);
  const previewDesktop = personalizationCssBlock(".personalization-preview-desktop");
  assert.match(previewDesktop, /border-radius:\s*var\(--imageweave-radius-control\)/);
  assert.doesNotMatch(previewDesktop, /var\(--imageweave-shadow-/);
  assert.match(personalizationCssBlock(".personalization-preview-menu"), /--imageweave-glass-surface-secondary/);
  assert.match(personalizationCssBlock(".personalization-preview-window"), /--imageweave-glass-surface-input/);

  const radio = personalizationCssBlock('.personalization-choice input[type="radio"]');
  assert.match(radio, /width:\s*20px/);
  assert.match(radio, /height:\s*20px/);
  assert.match(radio, /accent-color:\s*var\(--imageweave-accent\)/);
  assert.match(CSS_SOURCE, /data-personalization-selected="true"[\s\S]*?data-personalization-current="true"[\s\S]*?border-color:\s*var\(--imageweave-border-focus\)/);
  assert.match(personalizationCssBlock(".personalization-choice__selection:not(:empty)::before"), /content:\s*"◆"/);
  const hover = personalizationCssBlock(".personalization-choice:hover:not(:has(input:disabled))");
  assert.match(hover, /background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(hover, /box-shadow:\s*none/);
  assert.match(hover, /transform:\s*none/);

  for (const [stateName, token] of [
    ["clean", "success"],
    ["dirty", "warning"],
    ["saving", "running"],
    ["success", "success"],
    ["error", "danger"],
  ]) {
    assert.match(
      CSS_SOURCE,
      new RegExp(`data-personalization-status="${stateName}"[\\s\\S]*?--imageweave-state-${token}`),
      stateName,
    );
  }
  for (const marker of [
    'content: "△ 未应用 · "',
    'content: "▶ 保存中 · "',
    'content: "✓ 完成 · "',
    'content: "! 保存失败 · "',
  ]) assert.match(CSS_SOURCE, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    personalizationCssBlock('.personalization-save-status[data-personalization-status="error"]'),
    /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/,
  );
  assert.match(
    CONTROLS_CSS_SOURCE,
    /\.personalization-button\.personalization-button--primary[\s\S]*?border-color:\s*var\(--imageweave-accent\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/,
  );
  assert.doesNotMatch(CSS_SOURCE, /\.personalization-button--primary\s*\{[^}]*background/s);
  assert.match(
    personalizationCssBlock(".personalization-actions .personalization-button"),
    /min-height:\s*var\(--imageweave-control-height\)/,
  );

  assert.doesNotMatch(CSS_SOURCE, /\b(?:100|120|150|180)ms\b/);
  assert.match(CSS_SOURCE, /var\(--imageweave-transition-standard\)/);
  assert.match(CSS_SOURCE, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  assert.match(CSS_SOURCE, /background:\s*var\(--imageweave-fallback-elevated-solid\)/);
  assert.match(CSS_SOURCE, /@media \(prefers-contrast: more\)/);
  assert.match(CSS_SOURCE, /@media \(forced-colors: active\)/);
  for (const expected of [
    "CanvasText",
    "ButtonFace",
    "Highlight",
    "background-image: none",
    "box-shadow: none",
    "backdrop-filter: none",
  ]) assert.match(CSS_SOURCE, new RegExp(expected));
  assert.match(CSS_SOURCE, /:root\[data-motion="off"\]/);
  assert.match(CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok((CSS_SOURCE.match(/transition: none !important/g) || []).length >= 3);
  assert.doesNotMatch(CSS_SOURCE, /@media\s*\(max-width\s*:/);
  assert.doesNotMatch(CSS_SOURCE, /desktop-wallpaper__(?:image|mask)|window-layer--opacity|personalization-(?:theme|image|mask|position)/i);
});

test("Personalization static boundary：0 API、0 mutable theme、0 retired runtime path", () => {
  const combined = [APP_SOURCE, MODEL_SOURCE, VIEW_SOURCE, RUNTIME_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /innerHTML/,
    /URL\.(?:createObjectURL|revokeObjectURL)/,
    /\.setProperty\s*\(/,
    /data-theme-tone/,
    /\bthemeRoot\b/,
    /\bwallpaper(?:Image|Mask|Fit|Position|MaskTone|MaskStrength|Blur)\b/,
    /\bwindowOpacity\b/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.equal((APP_SOURCE.match(/"\/api\//g) || []).length, 0);
  assert.deepEqual(PERSONALIZATION_PREFERENCE_KEYS, ["animations", "wallpaperColor"]);
  assert.deepEqual(WALLPAPER_STORAGE_SCHEMA, {
    databaseName: "imageweave-ui",
    storeName: "wallpapers",
    customKey: "custom",
  });
  assert.doesNotMatch(VIEW_SOURCE, /type:\s*"(?:color|file)"/);
  assert.doesNotMatch(INDEX_SOURCE, /data-desktop-wallpaper-(?:image|mask)|desktop-wallpaper__(?:image|mask)/);
  assert.doesNotMatch(DESKTOP_CSS_SOURCE, /desktop-wallpaper__(?:image|mask)|desktop-wallpaper--(?:custom|fit-|position-|mask-|blur-)|window-layer--opacity/);
  assert.equal(existsSync(resolve(WEBUI_ROOT, "js/core/wallpaper-image-import.js")), false);
  assert.match(MAIN_SOURCE, /void cleanupLegacyCustomWallpaper\(\)\.catch\(\(\) => \{\}\)/);
  assert.equal((MAIN_SOURCE.match(/cleanupLegacyCustomWallpaper\s*\(/g) || []).length, 1);
  assert.doesNotMatch(MAIN_SOURCE, /wallpaperStorage|wallpaperImage|wallpaperMask/);
});

test("wallpaper cleanup seam：delete-only、无 store 与失败都关闭且不读取", async () => {
  assert.doesNotMatch(STORAGE_SOURCE, /wallpaper-image-import|\bBlob\b|\.get\s*\(|\.put\s*\(|\breadonly\b|createObjectStore|deleteDatabase/);
  assert.equal((STORAGE_SOURCE.match(/\.delete\s*\(/g) || []).length, 1);
  const success = deletionFixture();
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: success.indexedDB }), true);
  assert.deepEqual(success.calls.opens, [["imageweave-ui"]]);
  assert.deepEqual(success.calls.deletes, ["custom"]);
  assert.equal(success.calls.gets, 0);
  assert.equal(success.calls.closes, 1);

  const missing = deletionFixture({ store: false });
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: missing.indexedDB }), true);
  assert.deepEqual(missing.calls.deletes, []);
  assert.equal(missing.calls.closes, 1);

  const failed = deletionFixture({ failDelete: true });
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: failed.indexedDB }), false);
  assert.equal(failed.calls.gets, 0);
  assert.equal(failed.calls.closes, 1);
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: null }), false);
});

test("生产 JavaScript import graph 中所有相对模块存在且删除模块无引用", () => {
  const jsRoot = resolve(WEBUI_ROOT, "js");
  const pending = [resolve(jsRoot, "main.js")];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /wallpaper-image-import/);
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const dependency = resolve(dirname(path), match[1]);
      assert.equal(existsSync(dependency), true, `${path} -> ${match[1]}`);
      pending.push(dependency);
    }
  }
  assert.equal(visited.has(resolve(jsRoot, "core/wallpaper-storage.js")), true);
  assert.equal(visited.has(resolve(jsRoot, "core/personalization.js")), true);
  assert.equal(visited.has(resolve(jsRoot, "apps/personalization.js")), true);
});
