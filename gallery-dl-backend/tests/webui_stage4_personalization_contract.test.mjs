import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePersonalizationPreview,
  PERSONALIZATION_DEFAULTS,
  PERSONALIZATION_PREFERENCE_KEYS,
  projectPersonalizationPreferences,
} from "../gdl_backend/webui/js/core/personalization-model.js";
import {
  createPersonalizationView,
  WALLPAPER_COLOR_CHOICES,
} from "../gdl_backend/webui/js/components/personalization-view.js";
import { WALLPAPER_STORAGE_SCHEMA } from "../gdl_backend/webui/js/core/wallpaper-storage.js";

const SECRET = "stage4-personalization-cookie-token-path-secret-271828";
const APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/personalization.js", import.meta.url),
  "utf8",
);
const MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/personalization-model.js", import.meta.url),
  "utf8",
);
const VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/personalization-view.js", import.meta.url),
  "utf8",
);
const RUNTIME_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/personalization.js", import.meta.url),
  "utf8",
);
const STORAGE_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/wallpaper-storage.js", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/personalization.css", import.meta.url),
  "utf8",
);

function state(overrides = {}) {
  const draft = projectPersonalizationPreferences({
    ...PERSONALIZATION_DEFAULTS,
    ...(overrides.draft || {}),
  });
  return {
    committed: PERSONALIZATION_DEFAULTS,
    draft,
    dirty: overrides.dirty ?? false,
    busy: overrides.busy ?? false,
    customWallpaper: {
      loading: false,
      saved: false,
      pending: false,
      available: false,
      selectedReady: false,
      storageAvailable: true,
      ...(overrides.customWallpaper || {}),
    },
    motion: {
      userMode: draft.animations,
      systemReduced: false,
      effective: draft.animations === "on",
      limitedBySystem: false,
      ...(overrides.motion || {}),
    },
  };
}

function descendants(element) {
  return [element, ...(element.children || []).flatMap((child) => descendants(child))];
}

function installViewDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  class TestNode {}
  class TestClassList {
    constructor() { this.values = new Set(); }
    add(...values) { for (const value of values) this.values.add(value); }
    remove(...values) { for (const value of values) this.values.delete(value); }
    toggle(value, force) {
      if (force) this.values.add(value);
      else this.values.delete(value);
      return this.values.has(value);
    }
    contains(value) { return this.values.has(value); }
  }
  class TestElement extends TestNode {
    constructor(tagName = "div") {
      super();
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.classList = new TestClassList();
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
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
    toggleAttribute(name, force) {
      if (force) this.setAttribute(name, "");
      else this.removeAttribute(name);
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
    contains(target) {
      let current = target;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    }
    querySelectorAll() { return descendants(this).slice(1); }
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === "[hidden]" && current.hidden) return current;
        current = current.parentElement;
      }
      return null;
    }
    focus() { globalThis.document.activeElement = this; }
    scrollBy(options) {
      this.lastScrollBy = options;
      this.scrollLeft = (this.scrollLeft || 0) + Number(options?.left || 0);
    }
    click() {}
  }
  class TestButton extends TestElement {}
  class TestForm extends TestElement {}

  const documentObject = {
    activeElement: null,
    createElement(tagName) {
      if (tagName === "button") return new TestButton(tagName);
      if (tagName === "form") return new TestForm(tagName);
      return new TestElement(tagName);
    },
  };
  install("Node", TestNode);
  install("Element", TestElement);
  install("HTMLElement", TestElement);
  install("HTMLButtonElement", TestButton);
  install("HTMLFormElement", TestForm);
  install("document", documentObject);

  const root = new TestElement("main");
  return {
    root,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("Personalization preview：完整白名单矩阵投影为冻结安全事实", () => {
  for (const color of WALLPAPER_COLOR_CHOICES) {
    const preview = derivePersonalizationPreview(state({
      dirty: true,
      draft: {
        wallpaperColor: color.id,
        wallpaperFit: "contain",
        wallpaperPosition: "bottom-right",
        wallpaperMaskTone: "light",
        wallpaperMaskStrength: 65,
        wallpaperBlur: "medium",
        windowOpacity: "soft",
        animations: "off",
        themeAccent: "#abcdef",
        themeSurface: "#101010",
      },
    }));
    assert.equal(Object.isFrozen(preview), true);
    assert.equal(preview.wallpaper.kind, "color");
    assert.equal(preview.wallpaper.colorId, color.id);
    assert.equal(preview.wallpaper.label, color.label);
    assert.equal(preview.theme.accentHex, "#ABCDEF");
    assert.equal(preview.theme.surfaceHex, "#101010");
    assert.equal(preview.theme.tone, "dark");
    assert.equal(preview.wallpaper.fitId, "contain");
    assert.equal(preview.wallpaper.positionId, "bottom-right");
    assert.equal(preview.wallpaper.maskToneId, "light");
    assert.equal(preview.wallpaper.maskStrength, 65);
    assert.equal(preview.wallpaper.blurId, "medium");
    assert.equal(preview.window.opacityId, "soft");
    assert.equal(preview.motion.mode, "off");
    assert.equal(preview.motion.effective, false);
    assert.equal(preview.status.id, "dirty");
  }

  const customCases = [
    ["loading", { loading: true }],
    ["pending", { pending: true, available: true, selectedReady: true }],
    ["saved", { saved: true, available: true, selectedReady: true }],
    ["unavailable", { storageAvailable: false }],
    ["empty", {}],
  ];
  for (const [expected, customWallpaper] of customCases) {
    const preview = derivePersonalizationPreview(state({
      draft: { wallpaperKind: "custom" },
      customWallpaper,
    }));
    assert.equal(preview.wallpaper.kind, "custom");
    assert.equal(preview.custom.statusId, expected);
    assert.match(preview.custom.message, /本地|图片|壁纸/);
  }

  const limited = derivePersonalizationPreview(state({
    draft: { animations: "on" },
    motion: { systemReduced: true, effective: false, limitedBySystem: true },
  }));
  assert.equal(limited.motion.statusId, "system-limited");
  assert.match(limited.motion.message, /系统.*减少动态效果/);
});

test("Personalization preview：拒绝恶意键、accessor 与秘密运行时字段且不泄漏 marker", () => {
  assert.throws(() => derivePersonalizationPreview({
    ...state(),
    secret: SECRET,
  }), TypeError);
  assert.throws(() => derivePersonalizationPreview({
    ...state(),
    draft: { ...PERSONALIZATION_DEFAULTS, url: `blob:${SECRET}` },
  }), TypeError);
  assert.throws(() => derivePersonalizationPreview({
    ...state(),
    customWallpaper: { ...state().customWallpaper, fileName: `${SECRET}.png` },
  }), TypeError);
  const accessor = state();
  Object.defineProperty(accessor, "motion", { get() { throw new Error(SECRET); } });
  assert.throws(() => derivePersonalizationPreview(accessor), TypeError);

  const safe = derivePersonalizationPreview(state({
    draft: { wallpaperKind: "custom" },
    customWallpaper: { pending: true, available: true, selectedReady: true },
  }));
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(SECRET), false);
  for (const forbiddenKey of ["url", "path", "file", "name", "src", "exif", "blob"]) {
    assert.equal(Object.keys(safe).some((key) => key.toLowerCase().includes(forbiddenKey)), false, forbiddenKey);
  }
  assert.doesNotMatch(serialized, /(?:blob:|https?:\/\/|[A-Za-z]:\\|\/home\/)/);
});

test("Personalization DOM：全高三栏顺序、实时桌面语义、仅两个 color 与文字 live 状态", () => {
  const dom = installViewDom();
  let view;
  try {
    view = createPersonalizationView({
      root: dom.root,
      app: { label: "外观设置", windowTitle: "DESKTOP.CPL" },
    });
    const { elements } = view;
    assert.equal(elements.workspace.tagName, "SECTION");
    assert.equal(elements.workspace.getAttribute("tabindex"), "0");
    assert.equal(elements.form.children.length, 1, "form 必须只包裹 workspace，不能嵌套 form");
    assert.equal(elements.workspaceTrack.children.length, 3);
    assert.deepEqual(
      elements.workspaceTrack.children.map((column) => column.children[0].children[0].textContent),
      ["01 · 实时预览", "02 · 主题与壁纸", "03 · 显示与应用"],
    );
    assert.equal(
      elements.workspaceTrack.children.every((column) => column.children[1].className.includes("personalization-column-scroll")),
      true,
    );
    const all = descendants(dom.root);
    assert.equal(all.filter((element) => element.tagName === "FORM").length, 1);
    assert.equal(all.filter((element) => element.type === "color").length, 2);
    assert.equal(all.filter((element) => element.tagName === "OUTPUT").length >= 3, true);
    assert.equal(all.some((element) => element.className.includes("personalization-preview-desktop")), true);
    assert.equal(all.some((element) => element.className.includes("personalization-preview-menu-bar")), true);
    assert.equal(all.some((element) => element.className.includes("personalization-preview-window")), true);
    assert.equal(all.some((element) => element.className.includes("personalization-preview-dock")), true);
    assert.equal(all.filter((element) => element.getAttribute("aria-live") === "polite").length >= 6, true);

    const originalAccent = elements.themeAccentInput;
    elements.themeAccentInput.focus();
    const forestState = state({
      dirty: true,
      draft: {
        wallpaperColor: "forest",
        wallpaperFit: "contain",
        wallpaperPosition: "bottom-right",
        windowOpacity: "soft",
        themeAccent: "#ABCDEF",
        themeSurface: "#101010",
      },
    });
    view.renderState(forestState);
    assert.equal(elements.themeAccentInput, originalAccent);
    assert.equal(globalThis.document.activeElement, originalAccent, "原位更新不得丢失 color focus");
    assert.equal(elements.previewDesktop.dataset.personalizationWallpaper, "forest");
    assert.equal(elements.previewDesktop.dataset.personalizationWindowOpacity, "soft");
    assert.equal(elements.previewState.dataset.personalizationPreviewState, "dirty");
    assert.match(elements.previewThemeFact.textContent, /#ABCDEF.*#101010/);
    assert.match(elements.previewToneFact.textContent, /深色界面/);
    assert.match(elements.previewBackgroundFact.textContent, /深林.*适应.*右下/);
    assert.equal(view.scrollWorkspace(1), true);
    assert.equal(elements.workspace.lastScrollBy.left > 0, true);
    assert.equal(view.scrollWorkspace(-1), true);
    assert.equal(elements.workspace.lastScrollBy.left < 0, true);

    const restoredState = state();
    view.renderState(restoredState);
    assert.equal(elements.previewDesktop.dataset.personalizationWallpaper, "graphite");
    assert.equal(elements.previewState.dataset.personalizationPreviewState, "clean");
    assert.match(elements.previewThemeFact.textContent, /#46515D.*#F4F1EA/);
    assert.match(elements.previewToneFact.textContent, /浅色界面/);
    assert.match(elements.previewBackgroundFact.textContent, /石墨.*填充.*居中/);

    const customState = state({
      dirty: true,
      draft: { wallpaperKind: "custom", animations: "on" },
      customWallpaper: { pending: true, available: true, selectedReady: true },
      motion: { systemReduced: true, effective: false, limitedBySystem: true },
    });
    view.renderState(customState);
    assert.equal(elements.previewDesktop.dataset.personalizationWallpaper, "custom");
    assert.equal(elements.previewDesktop.dataset.personalizationMotion, "system-limited");
    assert.equal(elements.previewState.dataset.personalizationPreviewState, "dirty");
    assert.match(elements.previewWallpaperStatus.textContent, /本地图片正在桌面预览/);
    assert.match(elements.previewMotionFact.textContent, /系统.*限制|减少动态效果/);
    assert.equal(JSON.stringify(elements.previewDesktop.dataset).includes("blob:"), false);
    assert.equal("renderPreviewFromState" in view, false, "preview 不再暴露二次渲染入口");
  } finally {
    view?.destroy();
    dom.restore();
  }
});

test("Personalization CSS：normal 横滚、maximized 三栏同屏、独立纵滚与可访问媒体契约", () => {
  assert.match(CSS_SOURCE, /\.window-body:has\(> \.personalization-app\)\s*\{[^}]*padding\s*:\s*0[^}]*overflow\s*:\s*hidden/s);
  assert.match(CSS_SOURCE, /\.personalization-app\s*\{[^}]*grid-template-rows\s*:\s*auto minmax\(0,\s*1fr\)[^}]*height\s*:\s*100%/s);
  assert.match(CSS_SOURCE, /\.personalization-workspace\s*\{[^}]*overflow-x\s*:\s*auto[^}]*overflow-y\s*:\s*hidden/s);
  assert.match(CSS_SOURCE, /\.personalization-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;[^}]*min-width\s*:\s*(?:1120|1140|1160|1180|1200)px/s);
  assert.match(CSS_SOURCE, /\.personalization-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(CSS_SOURCE, /\.application-window\[data-maximized\] \.personalization-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(CSS_SOURCE, /\.application-window:not\(\[data-maximized\]\) \.personalization-workspace-track/);
  assert.match(CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(CSS_SOURCE, /--imageweave-surface-navigation-solid/);
  assert.match(CSS_SOURCE, /@media \(forced-colors: active\)/);
  assert.match(CSS_SOURCE, /CanvasText/);
  assert.match(CSS_SOURCE, /ButtonFace/);
  assert.match(CSS_SOURCE, /ButtonText/);
  assert.match(CSS_SOURCE, /Highlight/);
  assert.match(CSS_SOURCE, /box-shadow:\s*none/);
  assert.match(CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS_SOURCE, /:root\[data-motion="off"\]/);
  assert.match(APP_SOURCE, /event\.target !== view\.elements\.workspace/);
  assert.match(APP_SOURCE, /event\.key === "ArrowLeft"/);
  assert.match(APP_SOURCE, /event\.key === "ArrowRight"/);
  assert.match(VIEW_SOURCE, /workspace\.scrollBy/);
  assert.doesNotMatch(CSS_SOURCE, /@media\s*\(max-width\s*:\s*(?:767|420)px/);
  assert.doesNotMatch(CSS_SOURCE, /backdrop-filter/);
});

test("Personalization static boundary：0 endpoint、无旁路 I/O/DOM 注入/私有 URL，固定白名单不变", () => {
  const combined = [APP_SOURCE, MODEL_SOURCE, VIEW_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
    /URL\.(?:createObjectURL|revokeObjectURL)/,
    /\.style\b|cssText/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.equal((APP_SOURCE.match(/"\/api\//g) || []).length, 0);
  assert.equal((VIEW_SOURCE.match(/type:\s*"color"/g) || []).length, 1);
  assert.deepEqual(PERSONALIZATION_PREFERENCE_KEYS, [
    "animations", "wallpaperKind", "wallpaperColor", "wallpaperFit",
    "wallpaperPosition", "wallpaperMaskTone", "wallpaperMaskStrength",
    "wallpaperBlur", "windowOpacity", "themeAccent", "themeSurface",
  ]);
  assert.deepEqual(WALLPAPER_STORAGE_SCHEMA, {
    databaseName: "imageweave-ui",
    databaseVersion: 1,
    storeName: "wallpapers",
    customKey: "custom",
  });
  const runtimeSetProperties = [...RUNTIME_SOURCE.matchAll(/\.setProperty\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(runtimeSetProperties.length, RUNTIME_SOURCE.split(".setProperty(").length - 1);
  assert.deepEqual(new Set(runtimeSetProperties), new Set([
    "background-image", "--imageweave-accent", "--imageweave-surface",
  ]));
  assert.deepEqual(
    new Set(runtimeSetProperties.filter((name) => name.startsWith("--imageweave-"))),
    new Set(["--imageweave-accent", "--imageweave-surface"]),
  );
  assert.match(STORAGE_SOURCE, /projectWallpaperRecord/);
  assert.doesNotMatch(VIEW_SOURCE, /(?:blob:|\.src\s*=|file\.name|fileName|EXIF)/i);
  assert.doesNotMatch(VIEW_SOURCE, /任务栏|开始菜单|START|desktop-icons|taskbar/);
});
