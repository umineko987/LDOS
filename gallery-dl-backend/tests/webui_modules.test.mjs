import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  buildRequestOptions,
  createApiClient,
  createIdempotencyKey,
  injectIdempotencyKey,
  normalizeApiError,
  parseResponseText,
} from "../gdl_backend/webui/js/core/api.js";
import {
  createShellActions,
  WINDOW_LAYOUT_DEBOUNCE_MS,
} from "../gdl_backend/webui/js/core/actions.js";
import {
  applications,
  DEFAULT_APP_ID,
  DEFAULT_ROUTE,
  getApplicationById,
} from "../gdl_backend/webui/js/core/app-registry.js";
import {
  createPollingManager,
  UNFOCUSED_POLL_MULTIPLIER,
} from "../gdl_backend/webui/js/core/polling.js";
import {
  createStorePollingFocusSource,
  POLLING_SCOPE_STATES,
} from "../gdl_backend/webui/js/core/polling-focus-source.js";
import {
  buildCrawlPayload,
  buildSearchPayload,
  candidateMatchesEhFilter,
  parseEhTag,
  projectCrawlSearchResponse,
  sanitizeAutocompleteResponse,
} from "../gdl_backend/webui/js/core/crawl-model.js";
import {
  buildDiagnosticsSnapshot,
  diagnosticsCopyText,
  DIAGNOSTICS_POLL_INTERVAL_MS,
  sanitizeDiagnosticsConfig,
  sanitizeDiagnosticsScheduler,
} from "../gdl_backend/webui/js/core/diagnostics-model.js";
import {
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  formatPolicySource,
  isPolicyDirty,
  policyConfigToDraft,
  policyConfigsEqual,
  policyErrorGuidance,
  safePolicyErrorDetail,
  sanitizePolicyResponse,
  validatePolicyDraft,
} from "../gdl_backend/webui/js/core/policy-model.js";
import {
  calculateReviewLayout,
  calculateSynchronizedCrop,
  clamp as loupeClamp,
  containContentRect,
  DEFAULT_MAGNIFICATION,
  formatMagnification,
  getContainContentRect,
  MAX_MAGNIFICATION,
  median as loupeMedian,
  MIN_MAGNIFICATION,
  normalizeImageDimensions,
  normalizePointerCoordinates,
  REFERENCE_PIXEL_HEIGHT,
  selectReferenceImage,
  updateMagnification,
} from "../gdl_backend/webui/js/core/review-loupe.js";
import {
  buildReviewDecisionPayload,
  deckAdvanceTarget,
  deckImageStepTarget,
  deckStepTarget,
  resolveDeckCommand,
  REVIEW_DECISION_BATCH_LIMIT,
  REVIEW_GROUP_LIMIT,
  REVIEW_POLL_INTERVAL_MS,
  reviewCompletionPresentation,
  reviewImageUrl,
  sanitizeReviewPage,
  splitReviewDecisionPayload,
  updateReviewImageSelection,
  validateReviewState,
} from "../gdl_backend/webui/js/core/review-model.js";
import {
  batchProgress,
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  shouldPollBatch,
  TASK_POLL_INTERVAL_MS,
  taskRecoveryTargets,
} from "../gdl_backend/webui/js/core/tasks-model.js";
import {
  deriveProxyControls,
  formatInlineNodeSource,
  formatRevisionPair,
  formatRuntimeNode,
  formatSubscriptionSource,
  proxyErrorGuidance,
  safeProxyErrorDetail,
  sanitizeProxySources,
  sanitizeProxyStatus,
  splitInlineNodeInput,
} from "../gdl_backend/webui/js/core/proxy-model.js";
import {
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  deriveVaultControls,
  extractVaultSessionFromSnapshot,
  formatAuthorizationProxy,
  formatVaultSite,
  sanitizeVaultSiteStatus,
  sanitizeVaultStatus,
  validateAuthorizationProxyInput,
  vaultErrorGuidance,
} from "../gdl_backend/webui/js/core/vault-model.js";
import {
  hashForRoute,
  parseHashRoute,
  resolveNavigationTarget,
} from "../gdl_backend/webui/js/core/router.js";
import {
  isBusinessActionType,
  reduceBusinessState,
} from "../gdl_backend/webui/js/core/store-business-transition.js";
import { normalizeAction } from "../gdl_backend/webui/js/core/store-contract.js";
import {
  cloneInput,
  makeImmutable,
} from "../gdl_backend/webui/js/core/store-data.js";
import { createStore as createStoreFromFactory } from "../gdl_backend/webui/js/core/store-factory.js";
import { createStoreRuntime } from "../gdl_backend/webui/js/core/store-runtime.js";
import {
  actionCreators as stateActionCreators,
  createInitialState as createStateSnapshot,
  selectors as stateSelectors,
} from "../gdl_backend/webui/js/core/store-state.js";
import { reduceNormalizedRootState } from "../gdl_backend/webui/js/core/store-transition.js";
import {
  isWindowActionType,
  reduceWindowState,
  withDerivedWindowFocus,
} from "../gdl_backend/webui/js/core/store-window-transition.js";
import * as storeFacade from "../gdl_backend/webui/js/core/store.js";
import {
  ACTION_TYPES,
  actionCreators,
  createInitialState,
  createStore,
  DEFAULT_WINDOW_RECT,
  rootReducer,
  selectors,
  UnknownActionError,
} from "../gdl_backend/webui/js/core/store.js";
import {
  createMotionController,
  MOTION_MEDIA_QUERY,
} from "../gdl_backend/webui/js/core/motion.js";
import {
  createPersonalizationRuntime,
  WALLPAPER_COLOR_CLASSES,
} from "../gdl_backend/webui/js/core/personalization.js";
import {
  BUILT_IN_WALLPAPER_COLOR_IDS,
  copyPersonalizationPreferences,
  derivePersonalizationPreview,
  isValidPersonalizationPreferences,
  normalizePersonalizationPreferences,
  PERSONALIZATION_DEFAULTS,
  PERSONALIZATION_OPTIONS,
  PERSONALIZATION_PREFERENCE_KEYS,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
  restoreDefaultPersonalizationPreferences,
} from "../gdl_backend/webui/js/core/personalization-model.js";
import {
  cleanupLegacyCustomWallpaper,
  WALLPAPER_STORAGE_SCHEMA,
} from "../gdl_backend/webui/js/core/wallpaper-storage.js";
import {
  clampRect,
  maximizedRect,
  nextRectForDrag,
  nextRectForResize,
} from "../gdl_backend/webui/js/core/window-geometry.js";
import {
  applyWindowRect,
  createWindowDomLifecycle,
} from "../gdl_backend/webui/js/core/window-dom-lifecycle.js";
import { createWindowHideController } from "../gdl_backend/webui/js/core/window-hide-controller.js";
import { createWindowInteractionController } from "../gdl_backend/webui/js/core/window-interaction.js";
import {
  measureWindowLayerViewport,
  windowLayerGeometryOptions,
} from "../gdl_backend/webui/js/core/window-workspace.js";
import {
  deriveWindowManagerSnapshot,
  deriveWindowRenderPlan,
  deriveWindowViews as derivePureWindowViews,
  nextKeyboardResizeRect,
  nextPointerInteractionRect,
  sameWindowRect,
} from "../gdl_backend/webui/js/core/window-policy.js";
import {
  createMenuBar,
  deriveWindowMenu,
  isShellShortcutTarget,
  shortcutModifier,
} from "../gdl_backend/webui/js/components/menu-bar.js";
import * as windowManagerFacade from "../gdl_backend/webui/js/core/window-manager.js";
import {
  createWindowManager,
  deriveWindowViews,
} from "../gdl_backend/webui/js/core/window-manager.js";
import {
  deserializeWindowLayout,
  deserializeWindowPlacements,
  migrateLegacyWindowLayout,
  projectWindowLayout,
  serializeWindowLayout,
  serializeWindowPlacements,
} from "../gdl_backend/webui/js/core/storage-layout.js";
import { createStoragePersistenceAdapter } from "../gdl_backend/webui/js/core/storage-persistence.js";
import {
  deserializeUiPreferences,
  projectUiPreferences,
  sanitizeUiPreferences,
  serializePersonalizationPreferences,
  serializeUiPreferences,
} from "../gdl_backend/webui/js/core/storage-preferences.js";
import { createStorageServiceFromAdapter } from "../gdl_backend/webui/js/core/storage-service.js";
import {
  parseStorageObject,
  projectApplicationId,
  projectBatchId,
  readApplicationIdSnapshot,
  readBatchIdSnapshot,
} from "../gdl_backend/webui/js/core/storage-snapshot.js";
import * as storageFacade from "../gdl_backend/webui/js/core/storage.js";
import {
  clampWindowRect,
  createDefaultWindowLayout,
  createStorageService,
  isValidBatchId,
  STORAGE_KEYS,
} from "../gdl_backend/webui/js/core/storage.js";
import { createIcon } from "../gdl_backend/webui/js/components/icons.js";
import {
  createStatusBadge,
  normalizeStatus,
  resolveStatusPresentation,
  updateStatusBadge,
} from "../gdl_backend/webui/js/components/status.js";
import {
  buildShellSnapshot,
  sanitizeHealthPayload,
  sanitizeReadinessPayload,
  SHELL_POLL_INTERVAL_MS,
  SHELL_POLL_SCOPE,
} from "../gdl_backend/webui/js/components/taskbar-summary.js";
import {
  _TASKBAR_VISIBLE_LIMIT,
  activateDockItem,
  activateTaskbarWindow,
  deriveDockModel,
  deriveTaskbarWindowModel,
  describeTaskbarWindows,
  createDock,
} from "../gdl_backend/webui/js/components/taskbar-windows.js";
import { createApplicationCenter } from "../gdl_backend/webui/js/components/application-center.js";
import { createEmptyState } from "../gdl_backend/webui/js/components/empty-state.js";
import {
  createErrorView,
  toSafeErrorViewModel,
} from "../gdl_backend/webui/js/components/error-view.js";
import { createDialogController } from "../gdl_backend/webui/js/components/dialog.js";
import { createSourceErrorWarning } from "../gdl_backend/webui/js/components/crawl-view.js";
import {
  createPersonalizationView,
  deriveMotionLimitationState,
  MOTION_LIMITATION_MESSAGE,
  PERSONALIZATION_SCENE_CHOICES,
} from "../gdl_backend/webui/js/components/personalization-view.js";
import crawlApplication, {
  CRAWL_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/crawl.js";
import diagnosticsApplication, {
  DIAGNOSTICS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/diagnostics.js";
import policyApplication, {
  POLICY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/policy.js";
import personalizationApplication from "../gdl_backend/webui/js/apps/personalization.js";
import reviewApplication, {
  REVIEW_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/review.js";
import tasksApplication, {
  TASKS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/tasks.js";
import proxyApplication, {
  PROXY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/proxy.js";
import vaultApplication, {
  VAULT_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/vault.js";

const EXPECTED_APPLICATION_METADATA = Object.freeze([
  ["crawl", "图片采集", "download", "/crawl", "图片采集", "workflow", "搜索来源、选择地址并创建有序采集批次。", 0, "ready", "normal"],
  ["tasks", "批次管理", "list", "/tasks", "批次管理", "workflow", "查看采集进度，并取消、重试或重新规划批次。", 1, "ready", "normal"],
  ["proxy", "代理管理", "network", "/proxy", "代理管理", "connections", "管理代理来源、运行池状态与连接探测。", 0, "ready", "normal"],
  ["vault", "授权管理", "key", "/vault", "授权管理", "connections", "管理站点授权、浏览器会话与授权代理。", 1, "ready", "normal"],
  ["review", "去重审核", "images", "/review", "去重审核", "workflow", "比较重复候选、确认保留项并应用整理结果。", 3, "ready", "maximized"],
  ["policy", "站点设置", "sliders", "/policy", "站点设置", "connections", "配置各站点的并发、重试和代理策略。", 2, "ready", "normal"],
  ["diagnostics", "系统诊断", "activity", "/diagnostics", "系统诊断", "system", "检查服务、配置能力与调度器健康状态。", 0, "ready", "normal"],
  ["personalization", "外观设置", "sliders", "/personalization", "外观设置", "system", "调整主题、壁纸、窗口可读性与动效。", 1, "ready", "normal"],
  ["gallery", "图片库", "folder", "/gallery", "图片库", "workflow", "浏览、搜索和整理已下载的图片。", 2, "preview", "normal"],
  ["schedule", "定时任务", "calendar", "/schedule", "定时任务", "workflow", "查看与编辑自动采集计划。", 4, "preview", "normal"],
  ["export", "数据集导出", "archive", "/export", "数据集导出", "workflow", "配置来源并导出审核后的数据集。", 5, "preview", "normal"],
].map(([id, label, icon, route, windowTitle, group, description, applicationCenterOrder, availability, defaultWindowState]) => Object.freeze({
  id, label, icon, route, windowTitle, group, description, applicationCenterOrder, availability, defaultWindowState,
})));

const APPLICATION_METADATA_KEYS = Object.freeze([
  "id",
  "label",
  "icon",
  "route",
  "windowTitle",
  "group",
  "description",
  "applicationCenterOrder",
  "availability",
  "defaultWindowState",
]);

function applicationMetadataSnapshot(items) {
  return items.map((item) => Object.fromEntries(
    APPLICATION_METADATA_KEYS.map((key) => [key, item[key]]),
  ));
}

function completeApplicationController() {
  return {
    mount() {},
    activate() {},
    deactivate() {},
    unmount() {},
  };
}

function windowRect(overrides = {}) {
  return { x: 48, y: 36, w: 720, h: 480, ...overrides };
}

function windowRecord(appId, windowState = "normal", rect = windowRect()) {
  return { appId, windowState, rect };
}

function shellSnapshot(overrides = {}) {
  return {
    health: { ok: true, process: "ok", database: "ok" },
    readiness: {
      ready: true,
      proxy: { status: "disabled", running: false, healthy: 0, sourceCount: 0 },
      dedup: { status: "disabled" },
    },
    apiConnected: true,
    summary: {
      api: { status: "ready", label: "API 已就绪" },
      proxy: { status: "disabled", label: "代理已禁用" },
      dedup: { status: "disabled", label: "去重已禁用" },
    },
    errors: { health: null, readiness: null },
    lastCheckedAt: 123,
    ...overrides,
  };
}

class MemoryStorage {
  constructor({ throws = false } = {}) {
    this.values = new Map();
    this.throws = throws;
    this.setCalls = 0;
  }

  getItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.setCalls += 1;
    if (this.throws) throw new Error("storage unavailable");
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    this.values.delete(key);
  }
}

class FakeMediaQueryList {
  constructor(matches = false) {
    this.matches = matches;
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === "change") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "change") this.listeners.delete(listener);
  }

  setMatches(matches) {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener({ matches });
  }
}

class FakeDomNode {
  constructor(nodeName = "") {
    this.nodeName = nodeName;
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, init = {}) {
    const event = {
      type,
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
        this.propagationStopped = true;
      },
      ...init,
    };
    if (!("target" in init)) event.target = this;
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    if (!event.propagationStopped && this.parentNode) {
      return this.parentNode.emit(type, { ...event, target: event.target });
    }
    return event;
  }

  append(...items) {
    for (const item of items) {
      if (item instanceof FakeDomDocumentFragment) {
        const fragmentChildren = [...item.children];
        item.children.length = 0;
        for (const child of fragmentChildren) this.append(child);
        continue;
      }
      const child = item instanceof FakeDomNode ? item : new FakeDomTextNode(String(item));
      child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...items) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.append(...items);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child instanceof FakeDomElement && child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child instanceof FakeDomElement && child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  get firstElementChild() {
    return this.children.find((child) => child instanceof FakeDomElement) || null;
  }

  get isConnected() {
    if (this instanceof FakeDomDocument) return true;
    return Boolean(this.parentNode?.isConnected);
  }
}

class FakeDomTextNode extends FakeDomNode {
  constructor(textContent) {
    super("#text");
    this.textContent = textContent;
  }
}

class FakeDomDocumentFragment extends FakeDomNode {
  constructor() {
    super("#document-fragment");
  }
}

function datasetNameForAttribute(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

class FakeDomElement extends FakeDomNode {
  constructor(tagName = "div") {
    super(tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.pointerCaptures = new Set();
    const styleValues = {};
    this.style = new Proxy(styleValues, {
      set: (target, property, value) => {
        target[property] = String(value);
        this.onStyleWrite?.(String(property), String(value));
        return true;
      },
    });
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) this.dataset[datasetNameForAttribute(name)] = normalized;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    const existed = this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
    if (name.startsWith("data-")) delete this.dataset[datasetNameForAttribute(name)];
    if (existed) this.onAttributeRemove?.(name);
  }

  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.hasAttribute(name) : force === true;
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  matches(selector) {
    const normalized = selector.trim();
    if (normalized === "button") return this.tagName === "BUTTON";
    if (normalized === "button:not([disabled])") {
      return this.tagName === "BUTTON" && !this.disabled;
    }
    const dataNotDisabled = /^(\[data-[^\]]+\]):not\(\[disabled\]\)$/i.exec(normalized);
    if (dataNotDisabled) return this.matches(dataNotDisabled[1]) && !this.disabled;
    const dataSelector = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(normalized);
    if (dataSelector) {
      const value = this.dataset[datasetNameForAttribute(`data-${dataSelector[1]}`)];
      return value !== undefined && (dataSelector[2] === undefined || value === dataSelector[2]);
    }
    if (normalized === '[role="menuitem"]') {
      return ["menuitem", "menuitemcheckbox"].includes(this.getAttribute("role"));
    }
    if (normalized.split(",").map((item) => item.trim()).includes(this.tagName.toLowerCase())) {
      return true;
    }
    const match = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(normalized);
    if (!match) return false;
    if (!this.hasAttribute(match[1])) return false;
    return match[2] === undefined || this.getAttribute(match[1]) === match[2];
  }

  closest(selector) {
    let current = this;
    while (current instanceof FakeDomElement) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  focus() {
    this.focused = true;
    if (globalThis.document && "activeElement" in globalThis.document) {
      globalThis.document.activeElement = this;
    }
  }

  setPointerCapture(pointerId) {
    this.pointerCaptures.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.pointerCaptures.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    if (!this.pointerCaptures.delete(pointerId)) return;
    this.emit("lostpointercapture", { pointerId });
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.replaceChildren();
    if (this._innerHTML.includes("<svg")) this.append(new FakeDomSvgElement("svg"));
  }

  get innerHTML() {
    return this._innerHTML || "";
  }
}

class FakeDomHtmlElement extends FakeDomElement {}
class FakeDomHtmlButtonElement extends FakeDomHtmlElement {}
class FakeDomSvgElement extends FakeDomElement {}

class FakeDomDocument extends FakeDomNode {
  constructor() {
    super("#document");
    this.documentElement = new FakeDomHtmlElement("html");
    this.documentElement.parentNode = this;
    this.activeElement = null;
    this.documentElement.clientWidth = 1_200;
    this.documentElement.clientHeight = 800;
  }

  createElement(tagName) {
    return tagName.toLowerCase() === "button"
      ? new FakeDomHtmlButtonElement(tagName)
      : new FakeDomHtmlElement(tagName);
  }
}

function createFakeWindowFragment() {
  const fragment = new FakeDomDocumentFragment();
  const windowElement = new FakeDomHtmlElement("section");
  windowElement.setAttribute("data-application-window", "");
  const titlebar = new FakeDomHtmlElement("header");
  titlebar.setAttribute("data-window-titlebar", "");
  const title = new FakeDomHtmlElement("strong");
  title.setAttribute("data-window-title", "");
  titlebar.append(title);
  for (const name of ["minimize", "maximize", "close"]) {
    const button = new FakeDomHtmlButtonElement("button");
    button.setAttribute(`data-window-${name}`, "");
    titlebar.append(button);
  }
  const body = new FakeDomHtmlElement("main");
  body.setAttribute("data-window-body", "");
  windowElement.append(titlebar, body);
  for (const direction of ["right", "bottom", "corner"]) {
    const handle = new FakeDomHtmlButtonElement("button");
    handle.setAttribute("data-window-resize", direction);
    windowElement.append(handle);
  }
  fragment.append(windowElement);
  return fragment;
}

function installWindowManagerDomFixture() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  const documentObject = new FakeDomDocument();
  const mobileViewport = new FakeMediaQueryList(false);
  const windowObject = new FakeDomNode("window");
  windowObject.innerWidth = 1_200;
  windowObject.innerHeight = 800;
  windowObject.matchMedia = () => mobileViewport;
  const windowLayer = new FakeDomHtmlElement("div");
  windowLayer.clientWidth = 1_200;
  windowLayer.clientHeight = 800;
  windowLayer.getBoundingClientRect = () => ({
    width: windowLayer.clientWidth,
    height: windowLayer.clientHeight,
  });
  const taskList = new FakeDomHtmlElement("div");
  const windowTemplate = {
    content: {
      cloneNode() {
        return createFakeWindowFragment();
      },
    },
  };

  install("Node", FakeDomNode);
  install("Element", FakeDomElement);
  install("HTMLElement", FakeDomHtmlElement);
  install("HTMLButtonElement", FakeDomHtmlButtonElement);
  install("SVGElement", FakeDomSvgElement);
  install("document", documentObject);
  install("window", windowObject);
  const computedValues = new Map([["--imageweave-taskbar-height", "40px"]]);
  install("getComputedStyle", () => ({
    getPropertyValue(name) {
      return computedValues.get(name) || "";
    },
  }));

  return Object.freeze({
    computedValues,
    documentObject,
    mobileViewport,
    windowObject,
    windowLayer,
    taskList,
    windowTemplate,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  });
}

function windowElementFor(layer, appId) {
  return layer.children.find((element) => element.dataset?.appId === appId) || null;
}

function createManagerActions(store, calls = []) {
  const dispatch = (name, action) => {
    const previous = selectors.windowStack(store.getState());
    calls.push([name, action.payload?.appId ?? null]);
    store.dispatch(action);
    return selectors.windowStack(store.getState()) !== previous;
  };
  return {
    beginWindowInteraction() {
      calls.push(["begin", null]);
      return true;
    },
    endWindowInteraction() {
      calls.push(["end", null]);
      return true;
    },
    focusWindow(appId) {
      return dispatch("focus", actionCreators.windowFocused(appId));
    },
    minimizeWindow(appId) {
      return dispatch("minimize", actionCreators.windowStateChanged(appId, "minimized"));
    },
    restoreWindow(appId) {
      return dispatch("restore", actionCreators.windowOpened(appId));
    },
    closeWindow(appId) {
      return dispatch("close", actionCreators.windowClosed(appId));
    },
    toggleWindowMaximized(appId) {
      const record = selectors.windowStack(store.getState())
        .find((candidate) => candidate.appId === appId);
      if (!record) return false;
      const next = record.windowState === "maximized" ? "normal" : "maximized";
      return dispatch("maximize", actionCreators.windowStateChanged(appId, next));
    },
    moveWindow(appId, rect) {
      return dispatch("move", actionCreators.windowMoved(appId, rect));
    },
  };
}

class FakeRootElement {
  constructor() {
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeThemeRoot extends FakeRootElement {
  constructor() {
    super();
    this.attributes.set("data-theme-tone", "light");
    this.properties = new Map();
    this.operations = [];
    this.failure = null;
    this.style = Object.freeze({
      getPropertyValue: (name) => this.properties.get(name) ?? "",
      setProperty: (name, value) => {
        if (name !== "--imageweave-accent" && name !== "--imageweave-surface") {
          throw new Error("unexpected theme property");
        }
        const normalized = String(value);
        this.properties.set(name, normalized);
        this.operations.push(["setProperty", name, normalized]);
        this.maybeFail(`setProperty:${name}`);
      },
      removeProperty: (name) => {
        const previous = this.properties.get(name) ?? "";
        this.properties.delete(name);
        this.operations.push(["removeProperty", name]);
        this.maybeFail(`removeProperty:${name}`);
        return previous;
      },
    });
  }

  maybeFail(operation) {
    if (this.failure !== operation) return;
    this.failure = null;
    throw new Error("theme setter fixture failure");
  }

  failNext(operation) {
    this.failure = operation;
  }

  setAttribute(name, value) {
    if (name !== "data-theme-tone") throw new Error("unexpected theme attribute");
    const normalized = String(value);
    this.attributes.set(name, normalized);
    this.operations.push(["setAttribute", name, normalized]);
    this.maybeFail(`setAttribute:${name}`);
  }

  removeAttribute(name) {
    if (name !== "data-theme-tone") throw new Error("unexpected theme attribute");
    this.attributes.delete(name);
    this.operations.push(["removeAttribute", name]);
    this.maybeFail(`removeAttribute:${name}`);
  }

  snapshot() {
    return Object.freeze({
      themeAccent: this.properties.get("--imageweave-accent") ?? "",
      themeSurface: this.properties.get("--imageweave-surface") ?? "",
      tone: this.getAttribute("data-theme-tone"),
    });
  }
}

class FakeClassList {
  constructor(values = []) {
    this.values = new Set(values);
    this.operations = [];
  }

  toggle(name, force) {
    this.operations.push([name, force === true]);
    if (force) this.values.add(name);
    else this.values.delete(name);
    return this.values.has(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeVisibility {
  constructor(state = "visible") {
    this.state = state;
    this.listeners = new Set();
  }

  getState = () => this.state;

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeFocusSource {
  constructor({ focusedScope = null, scopeStates = {} } = {}) {
    this.focusedScope = focusedScope;
    this.scopeStates = new Map(Object.entries(scopeStates));
    this.listeners = new Set();
  }

  getFocusedScope = () => this.focusedScope;

  getScopeState = (scope) => {
    if (!scope.startsWith("app:")) return POLLING_SCOPE_STATES.UNMANAGED;
    return this.scopeStates.get(scope) ?? POLLING_SCOPE_STATES.CLOSED;
  };

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update({ focusedScope = this.focusedScope, scopeStates = {} } = {}) {
    this.focusedScope = focusedScope;
    for (const [scope, state] of Object.entries(scopeStates)) {
      this.scopeStates.set(scope, state);
    }
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.sequence = 0;
    this.jobs = new Map();
    this.cleared = [];
  }

  setTimeout = (callback, delay) => {
    this.sequence += 1;
    this.jobs.set(this.sequence, { callback, due: this.now + delay });
    return this.sequence;
  };

  clearTimeout = (id) => {
    this.cleared.push(id);
    this.jobs.delete(id);
  };

  advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.jobs.entries()].sort((left, right) =>
        left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next || next[1].due > target) break;
      const [id, job] = next;
      this.jobs.delete(id);
      this.now = job.due;
      job.callback();
    }
    this.now = target;
  }

  runNext() {
    const next = [...this.jobs.entries()].sort((left, right) =>
      left[1].due - right[1].due || left[0] - right[0])[0];
    if (!next) return false;
    const [id, job] = next;
    this.jobs.delete(id);
    this.now = job.due;
    job.callback();
    return true;
  }

  delays() {
    return [...this.jobs.values()].map((job) => job.due - this.now).sort((a, b) => a - b);
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createPersonalizationStorageFixture(initialPreferences) {
  let preferences = { ...initialPreferences };
  let writesAllowed = true;
  const writes = [];
  const service = Object.freeze({
    readUiPreferences() {
      return { ...preferences };
    },
    writePersonalizationPreferences(next) {
      writes.push({ ...next });
      if (!writesAllowed) return false;
      preferences = { ...next };
      return true;
    },
  });
  return Object.freeze({
    service,
    writes,
    current: () => ({ ...preferences }),
    setWritesAllowed(value) {
      writesAllowed = value === true;
    },
  });
}

function createFakePolling(options = {}) {
  const timers = new FakeTimers();
  const visibility = options.visibility || new FakeVisibility();
  const errors = [];
  const manager = createPollingManager({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    visibilitySource: visibility,
    focusSource: options.focusSource || null,
    now: () => timers.now,
    onError: (error) => errors.push(error),
  });
  return { manager, timers, visibility, errors };
}

test("应用 registry 保持 11 项元数据、默认路由与生命周期基线", async () => {
  const registryModule = await import("../gdl_backend/webui/js/core/app-registry.js");
  assert.deepEqual(Object.keys(registryModule).sort(), [
    "DEFAULT_APP_ID",
    "DEFAULT_ROUTE",
    "applications",
    "getApplicationById",
    "getApplicationByRoute",
  ]);
  assert.equal(DEFAULT_APP_ID, "crawl");
  assert.equal(DEFAULT_ROUTE, "/crawl");
  assert.equal(applications.length, 11);
  assert.deepEqual(applicationMetadataSnapshot(applications), EXPECTED_APPLICATION_METADATA);
  assert.deepEqual(
    applications.filter((application) => application.availability === "preview")
      .map((application) => application.id),
    ["gallery", "schedule", "export"],
  );
  for (const application of applications) {
    assert.equal(Object.isFrozen(application), true, application.id);
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
      assert.equal(typeof application[hook], "function", `${application.id}.${hook}`);
    }
  }
  assert.deepEqual(
    applications.filter((application) => typeof application.beforeLeave === "function")
      .map((application) => application.id),
    ["review", "policy", "personalization", "schedule"],
  );
  assert.deepEqual(
    applications.filter((application) => typeof application.beforeWindowHide === "function")
      .map((application) => application.id),
    ["review", "policy", "personalization", "schedule"],
  );
});

test("纯 app metadata 与 registry 合并结果逐项一致", async () => {
  const {
    applicationDefinitions,
    DEFAULT_APP_ID: metadataDefaultAppId,
    DEFAULT_ROUTE: metadataDefaultRoute,
    getApplicationDefinitionById,
    getApplicationDefinitionByRoute,
  } = await import("../gdl_backend/webui/js/core/app-definitions.js");

  assert.equal(metadataDefaultAppId, DEFAULT_APP_ID);
  assert.equal(metadataDefaultRoute, DEFAULT_ROUTE);
  assert.equal(Object.isFrozen(applicationDefinitions), true);
  assert.deepEqual(applicationMetadataSnapshot(applicationDefinitions), EXPECTED_APPLICATION_METADATA);
  for (const [index, definition] of applicationDefinitions.entries()) {
    assert.equal(Object.isFrozen(definition), true, definition.id);
    assert.deepEqual(Object.keys(definition), APPLICATION_METADATA_KEYS, definition.id);
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
      assert.equal(hook in definition, false, `${definition.id}.${hook}`);
    }
    assert.equal(getApplicationDefinitionById(definition.id), definition);
    assert.equal(getApplicationDefinitionByRoute(definition.route), definition);
    assert.deepEqual(
      applicationMetadataSnapshot([applications[index]]),
      applicationMetadataSnapshot([definition]),
    );
  }
  assert.equal(getApplicationDefinitionById("unknown"), null);
  assert.equal(getApplicationDefinitionByRoute("/unknown"), null);
});

test("registry 按 ID 合并并拒绝重复、缺失、多余控制器及不完整生命周期", async () => {
  const { createApplicationRegistry } = await import(
    "../gdl_backend/webui/js/core/app-registry-factory.js"
  );
  const fixtureDefinitions = () => EXPECTED_APPLICATION_METADATA.slice(0, 2)
    .map((definition) => ({ ...definition }));

  const crawlController = completeApplicationController();
  const tasksController = completeApplicationController();
  const registry = createApplicationRegistry(fixtureDefinitions(), [
    ["tasks", tasksController],
    ["crawl", crawlController],
  ]);
  assert.deepEqual(registry.applications.map((application) => application.id), ["crawl", "tasks"]);
  assert.equal(registry.getApplicationById("crawl").mount, crawlController.mount);
  assert.equal(registry.getApplicationByRoute("/tasks").activate, tasksController.activate);

  const duplicateId = fixtureDefinitions();
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(
    () => createApplicationRegistry(duplicateId, [["crawl", crawlController]]),
    /应用 ID 重复：crawl/,
  );

  const duplicateRoute = fixtureDefinitions();
  duplicateRoute[1].route = duplicateRoute[0].route;
  assert.throws(
    () => createApplicationRegistry(duplicateRoute, [
      ["crawl", crawlController],
      ["tasks", tasksController],
    ]),
    /应用路由重复：\/crawl/,
  );

  assert.throws(
    () => createApplicationRegistry(fixtureDefinitions(), [["crawl", crawlController]]),
    /tasks 缺少控制器/,
  );
  assert.throws(
    () => createApplicationRegistry(fixtureDefinitions(), [
      ["crawl", crawlController],
      ["tasks", tasksController],
      ["extra", completeApplicationController()],
    ]),
    /存在多余控制器：extra/,
  );
  assert.throws(
    () => createApplicationRegistry(fixtureDefinitions(), [
      ["crawl", crawlController],
      ["crawl", completeApplicationController()],
      ["tasks", tasksController],
    ]),
    /控制器 ID 重复：crawl/,
  );

  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    const incompleteController = completeApplicationController();
    delete incompleteController[hook];
    assert.throws(
      () => createApplicationRegistry(fixtureDefinitions(), [
        ["crawl", incompleteController],
        ["tasks", tasksController],
      ]),
      new RegExp(`crawl 缺少生命周期方法：${hook}`),
    );
  }
});

test("图标工厂覆盖未知名称、class 投影与 SVG 宿主失败", () => {
  assert.throws(() => createIcon("unknown"), /未知图标/);
  const fixture = installWindowManagerDomFixture();
  const OriginalSvgElement = globalThis.SVGElement;
  try {
    const icon = createIcon("minus", { size: 16, strokeWidth: 2, className: "fixture-icon" });
    assert(icon instanceof SVGElement);
    assert.equal(icon.getAttribute("class"), "fixture-icon");
    globalThis.SVGElement = class IncompatibleSvgElement {};
    assert.throws(() => createIcon("minus"), /图标创建失败/);
  } finally {
    globalThis.SVGElement = OriginalSvgElement;
    fixture.restore();
  }
});

test("DIALOG 控制器拒绝缺失的 DOM 行为依赖", () => {
  assert.throws(
    () => createDialogController({ documentObject: null }),
    /对话框需要可用的 document/,
  );
});

test("Personalization 离开确认使用真实 dialog 焦点环、单飞与销毁回退", async () => {
  const previousNode = Object.getOwnPropertyDescriptor(globalThis, "Node");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  class DialogNode {}
  class DialogElement extends DialogNode {
    constructor(tagName, documentObject) {
      super();
      this.tagName = tagName.toUpperCase();
      this.ownerDocument = documentObject;
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.className = "";
      this.textContent = "";
      this.hidden = false;
      this.open = false;
      this.isConnected = false;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "open") this.open = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...children) {
      for (const child of children) {
        this.children.push(child);
        if (child instanceof DialogElement) child.parentElement = this;
      }
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, details = {}) {
      const event = {
        key: details.key,
        shiftKey: details.shiftKey === true,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
      };
      for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
      return event;
    }
    querySelectorAll() {
      const descendants = (element) => element.children.flatMap((child) => (
        child instanceof DialogElement ? [child, ...descendants(child)] : []
      ));
      return descendants(this).filter((element) => element.tagName === "BUTTON");
    }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() {
      this.ownerDocument.body.children = this.ownerDocument.body.children.filter(
        (child) => child !== this,
      );
      this.isConnected = false;
    }
  }
  const documentObject = { activeElement: null };
  let modalSupported = true;
  documentObject.createElement = (tagName) => {
    const element = new DialogElement(tagName, documentObject);
    if (tagName === "dialog" && !modalSupported) element.showModal = undefined;
    return element;
  };
  documentObject.body = new DialogElement("body", documentObject);
  documentObject.body.isConnected = true;
  documentObject.body.append = (...children) => {
    for (const child of children) {
      documentObject.body.children.push(child);
      child.parentElement = documentObject.body;
      child.isConnected = true;
    }
  };
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    writable: true,
    value: DialogNode,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: documentObject,
  });

  try {
    const previousFocus = new DialogElement("button", documentObject);
    previousFocus.isConnected = true;
    previousFocus.focus();
    const dialogs = createDialogController({ documentObject });
    assert.throws(() => dialogs.open({ title: "", message: "内容" }), TypeError);
    assert.throws(() => dialogs.open({
      title: "危险操作",
      message: "内容",
      dangerous: true,
      confirmLabel: "继续",
    }), /确认/);

    const result = dialogs.open({
      title: "放弃未应用的外观设置？",
      message: "当前场景或动效尚未应用。",
      confirmLabel: "放弃更改并离开",
      dangerous: true,
      confirmationText: "未应用内容不会写入浏览器存储。",
    });
    assert.throws(() => dialogs.open({ title: "重复", message: "重复" }), /一次只能/);
    const dialog = documentObject.body.children[0];
    const [cancelButton, confirmButton] = dialog.querySelectorAll();
    await Promise.resolve();
    assert.equal(documentObject.activeElement, cancelButton);
    let keyboard = dialog.emit("keydown", { key: "Tab", shiftKey: true });
    assert.equal(keyboard.defaultPrevented, true);
    assert.equal(documentObject.activeElement, confirmButton);
    keyboard = dialog.emit("keydown", { key: "Tab" });
    assert.equal(keyboard.defaultPrevented, true);
    assert.equal(documentObject.activeElement, cancelButton);
    confirmButton.emit("click");
    assert.equal(await result, "confirm");
    assert.equal(documentObject.body.children.length, 0);
    assert.equal(documentObject.activeElement, previousFocus);

    const cancelled = dialogs.open({ title: "离开？", message: "仍有更改" });
    const cancelDialog = documentObject.body.children[0];
    const escape = cancelDialog.emit("keydown", { key: "Escape" });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(escape.propagationStopped, true);
    assert.equal(await cancelled, "cancel");

    modalSupported = false;
    const destroyed = dialogs.open({ title: "离开？", message: "仍有更改" });
    assert.equal(documentObject.body.children[0].getAttribute("open"), "");
    dialogs.destroy();
    assert.equal(await destroyed, "cancel");
    assert.doesNotThrow(() => dialogs.destroy());
  } finally {
    if (previousNode) Object.defineProperty(globalThis, "Node", previousNode);
    else delete globalThis.Node;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
});

test("API 请求构造只在存在请求体时发送 JSON Content-Type", () => {
  const post = buildRequestOptions("post", {
    body: { name: "fixture" },
    headers: { "X-Test": "yes" },
  });
  assert.equal(post.method, "POST");
  assert.equal(post.cache, "no-store");
  assert.equal(post.headers.get("Accept"), "application/json");
  assert.equal(post.headers.get("Content-Type"), "application/json");
  assert.equal(post.body, '{"name":"fixture"}');

  const get = buildRequestOptions("GET", {
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(get.headers.get("Content-Type"), null);
  assert.equal("body" in get, false);
  assert.throws(() => buildRequestOptions("PATCH"), TypeError);
  assert.throws(() => buildRequestOptions("GET", { body: {} }), TypeError);
});

test("API 响应解析覆盖空响应、损坏 JSON 与后端错误模型", async () => {
  assert.deepEqual(parseResponseText(""), { kind: "empty", value: null });
  assert.deepEqual(parseResponseText('{"ok":true}'), { kind: "json", value: { ok: true } });
  assert.deepEqual(parseResponseText("<html>bad</html>"), { kind: "invalid", value: null });

  const responses = [
    new Response(null, { status: 204 }),
    new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      error: {
        code: "fixture_conflict",
        message: "操作冲突",
        details: { field: "name" },
        request_id: "body-request-id",
      },
    }), { status: 409, headers: { "X-Request-ID": "header-request-id" } }),
    new Response("<html>gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html", "X-Request-ID": "gateway-id" },
    }),
    new Response("{broken", { status: 200 }),
  ];
  const client = createApiClient({ fetchImpl: async () => responses.shift() });
  assert.equal(await client.get("/empty-204"), null);
  assert.equal(await client.get("/empty-200"), null);

  await assert.rejects(client.post("/conflict", {}), (error) => {
    assert(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "fixture_conflict");
    assert.equal(error.message, "操作冲突");
    assert.deepEqual(error.details, { field: "name" });
    assert.equal(error.requestId, "body-request-id");
    return true;
  });
  await assert.rejects(client.get("/gateway"), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, "http_error");
    assert.equal(error.details, null);
    assert.equal(error.requestId, "gateway-id");
    assert.equal(error.message.includes("gateway"), false);
    return true;
  });
  await assert.rejects(client.get("/broken"), (error) => {
    assert.equal(error.code, "invalid_response");
    assert.equal(error.details, null);
    return true;
  });
});

test("API 保留 AbortError，并把其他传输失败归一化", async () => {
  const aborted = new DOMException("aborted", "AbortError");
  const abortClient = createApiClient({ fetchImpl: async () => { throw aborted; } });
  await assert.rejects(abortClient.get("/abort"), (error) => error === aborted);

  const failedClient = createApiClient({ fetchImpl: async () => { throw new Error("private raw"); } });
  await assert.rejects(failedClient.delete("/offline"), (error) => {
    assert.equal(error.status, 0);
    assert.equal(error.code, "network_error");
    assert.equal(error.message.includes("private raw"), false);
    return true;
  });

  const normalized = normalizeApiError({
    status: 422,
    payload: { error: { code: "invalid", message: "无效", request_id: "req-1" } },
    requestId: "req-2",
  });
  assert.deepEqual(
    [normalized.status, normalized.code, normalized.message, normalized.requestId],
    [422, "invalid", "无效", "req-1"],
  );
});

test("幂等键优先使用 randomUUID，回退值不含业务数据", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    createIdempotencyKey({ cryptoObject: { randomUUID: () => uuid } }),
    `webui-${uuid}`,
  );
  const fallback = createIdempotencyKey({
    prefix: "crawl",
    cryptoObject: null,
    now: () => 1_000,
    random: () => 0.5,
  });
  assert.match(fallback, /^crawl-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(fallback.includes("secret"), false);
  const headers = injectIdempotencyKey({ Accept: "application/json" }, fallback);
  assert.equal(headers.get("Idempotency-Key"), fallback);
});

test("store/storage/window-manager 兼容入口保持精确 export shape", () => {
  assert.deepEqual(Object.keys(storeFacade), [
    "ACTION_TYPES",
    "DEFAULT_WINDOW_RECT",
    "UnknownActionError",
    "actionCreators",
    "createInitialState",
    "createStore",
    "rootReducer",
    "selectors",
  ]);
  assert.deepEqual(Object.keys(storageFacade), [
    "STORAGE_KEYS",
    "clampWindowRect",
    "createDefaultWindowLayout",
    "createStorageService",
    "isValidBatchId",
  ]);
  assert.deepEqual(Object.keys(windowManagerFacade), [
    "createWindowManager",
    "deriveWindowViews",
  ]);
});

test("store action 字符串、creator/selector shape 与初始 snapshot 保持兼容", () => {
  assert.deepEqual(ACTION_TYPES, {
    SYSTEM_SHELL_SUMMARY_UPDATED: "system/shellSummaryUpdated",
    DIAGNOSTICS_RECEIVED: "diagnostics/received",
    PROXY_STATUS_RECEIVED: "proxy/statusReceived",
    PROXY_SOURCES_RECEIVED: "proxy/sourcesReceived",
    POLICY_CONFIG_RECEIVED: "policy/configReceived",
    AUTH_STATUS_RECEIVED: "auth/statusReceived",
    AUTH_SITE_STATUS_RECEIVED: "auth/siteStatusReceived",
    CRAWL_SEARCH_RECEIVED: "crawl/searchReceived",
    CRAWL_CANDIDATE_SELECTION_CHANGED: "crawl/candidateSelectionChanged",
    CRAWL_VISIBLE_SELECTION_CHANGED: "crawl/visibleSelectionChanged",
    CRAWL_SOURCE_MOVED: "crawl/sourceMoved",
    CRAWL_CANDIDATE_MOVED: "crawl/candidateMoved",
    CRAWL_WEAK_VISIBILITY_CHANGED: "crawl/weakVisibilityChanged",
    CRAWL_EH_FILTER_CHANGED: "crawl/ehFilterChanged",
    CRAWL_EH_FILTER_CLEARED: "crawl/ehFilterCleared",
    BATCH_ACTIVE_ID_CHANGED: "batches/activeIdChanged",
    BATCH_RECENT_RECEIVED: "batches/recentReceived",
    BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived",
    BATCH_SNAPSHOT_CLEARED: "batches/snapshotCleared",
    REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived",
    REVIEW_SUMMARY_RECEIVED: "review/summaryReceived",
    REVIEW_IMAGE_SELECTION_CHANGED: "review/imageSelectionChanged",
    REVIEW_GROUP_CONFIRMED: "review/groupConfirmed",
    REVIEW_PAGE_SAVED: "review/pageSaved",
    REVIEW_CLEARED: "review/cleared",
    UI_WINDOW_OPENED: "ui/windowOpened",
    UI_WINDOW_CLOSED: "ui/windowClosed",
    UI_WINDOW_FOCUSED: "ui/windowFocused",
    UI_WINDOW_MOVED: "ui/windowMoved",
    UI_WINDOW_STATE_CHANGED: "ui/windowStateChanged",
  });
  assert.equal(Object.isFrozen(ACTION_TYPES), true);
  assert.deepEqual(Object.keys(actionCreators), [
    "shellSummaryUpdated", "diagnosticsReceived", "proxyStatusReceived",
    "proxySourcesReceived", "policyConfigReceived", "authStatusReceived",
    "authSiteStatusReceived", "crawlSearchReceived",
    "crawlCandidateSelectionChanged", "crawlVisibleSelectionChanged",
    "crawlSourceMoved", "crawlCandidateMoved", "crawlWeakVisibilityChanged",
    "crawlEhFilterChanged", "crawlEhFilterCleared", "activeBatchIdChanged",
    "recentBatchesReceived", "batchSnapshotReceived", "batchSnapshotCleared",
    "reviewWorkspaceReceived", "reviewSummaryReceived",
    "reviewImageSelectionChanged", "reviewGroupConfirmed", "reviewPageSaved",
    "reviewCleared", "windowOpened", "windowClosed", "windowFocused",
    "windowMoved", "windowStateChanged",
  ]);
  assert.deepEqual(Object.keys(selectors), [
    "focusedAppId", "taskbarSummary", "diagnostics",
    "proxyStatus", "proxySources", "policyConfig", "authSites",
    "authBrowserProfile", "authAuthorizationProxy", "crawl", "activeBatchId",
    "activeBatch", "batchTasks", "recentBatches", "review", "windowStack",
    "windowView",
  ]);
  assert.deepEqual(DEFAULT_WINDOW_RECT, { x: 160, y: 64, w: 800, h: 560 });
  assert.deepEqual(createInitialState(), {
    system: {
      health: null,
      readiness: null,
      apiConnected: false,
      summary: {
        api: { status: "disabled", label: "服务检查中" },
        proxy: { status: "disabled", label: "代理检查中" },
        dedup: { status: "disabled", label: "去重检查中" },
      },
      errors: { health: null, readiness: null },
      lastCheckedAt: null,
    },
    diagnostics: { snapshot: null },
    proxy: { status: null, sources: null },
    auth: { bySite: new Map(), browserProfile: null, authorizationProxy: null },
    policy: { config: null },
    crawl: {
      sources: [],
      relatedProfiles: [],
      addressCount: 0,
      weakEvidenceCount: 0,
      showWeakEvidence: false,
      ehTagFilter: new Map(),
    },
    batches: { activeId: "", active: null, tasks: [], recent: [] },
    review: {
      batchId: "",
      summary: null,
      groups: [],
      filter: "",
      offset: 0,
      limit: 0,
      total: 0,
      dirty: false,
      dirtyGroupIds: [],
    },
    ui: { windows: [], focusedAppId: null },
  });

  const rect = windowRect({ x: 7, y: 8, w: 640, h: 360 });
  assert.deepEqual(actionCreators.windowOpened("crawl"), {
    type: ACTION_TYPES.UI_WINDOW_OPENED,
    payload: { appId: "crawl" },
  });
  assert.deepEqual(actionCreators.windowOpened("crawl", {
    rect,
    maximized: true,
  }), {
    type: ACTION_TYPES.UI_WINDOW_OPENED,
    payload: { appId: "crawl", placement: { rect, maximized: true } },
  });
  assert.deepEqual(actionCreators.windowMoved("crawl", rect), {
    type: ACTION_TYPES.UI_WINDOW_MOVED,
    payload: { appId: "crawl", rect },
  });
});

test("root reducer 是纯转移并统一维护窗口去重、z 序和焦点回退", () => {
  const initial = createInitialState({
    windows: [
      windowRecord("crawl", "normal", windowRect({ x: 1 })),
      windowRecord("tasks", "normal", windowRect({ x: 2 })),
      windowRecord("crawl", "minimized", windowRect({ x: 3 })),
    ],
  });
  assert.deepEqual(initial.ui.windows.map((record) => [record.appId, record.rect.x]), [
    ["tasks", 2], ["crawl", 3],
  ]);
  assert.equal(initial.ui.focusedAppId, "tasks");

  const opened = rootReducer(initial, actionCreators.windowOpened("crawl"));
  assert.notEqual(opened, initial);
  assert.deepEqual(opened.ui.windows.map((record) => [record.appId, record.windowState]), [
    ["tasks", "normal"], ["crawl", "normal"],
  ]);
  assert.equal(opened.ui.focusedAppId, "crawl");
  assert.deepEqual(initial.ui.windows.map((record) => record.windowState), ["normal", "minimized"]);

  const closed = rootReducer(opened, actionCreators.windowClosed("crawl"));
  assert.equal(closed.ui.focusedAppId, "tasks");
  assert.throws(() => rootReducer(closed, { type: "unknown/action" }), UnknownActionError);
});

test("store contract/state/business/window/root/factory 各层可独立导入和纯执行", () => {
  assert.equal(stateActionCreators, actionCreators);
  assert.equal(stateSelectors, selectors);
  assert.deepEqual(createStateSnapshot(), createInitialState());
  assert.equal(isBusinessActionType(ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED), true);
  assert.equal(isBusinessActionType(ACTION_TYPES.UI_WINDOW_OPENED), false);
  assert.equal(isWindowActionType(ACTION_TYPES.UI_WINDOW_OPENED), true);
  assert.equal(isWindowActionType(ACTION_TYPES.REVIEW_CLEARED), false);

  const rawPayload = shellSnapshot();
  const normalized = normalizeAction(actionCreators.shellSummaryUpdated(rawPayload));
  rawPayload.summary.api.label = "mutated outside";
  const initial = createInitialState();
  const business = reduceBusinessState(initial, normalized);
  assert.equal(business.system.summary.api.label, "API 已就绪");
  assert.equal(initial.system.health, null);

  const openedWithoutFocus = reduceWindowState(
    initial,
    normalizeAction(actionCreators.windowOpened("crawl")),
  );
  assert.equal(openedWithoutFocus.ui.focusedAppId, null);
  const opened = withDerivedWindowFocus(openedWithoutFocus);
  assert.equal(opened.ui.focusedAppId, "crawl");
  const rootOpened = reduceNormalizedRootState(
    initial,
    normalizeAction(actionCreators.windowOpened("crawl")),
  );
  assert.deepEqual(rootOpened, opened);

  const factoryStore = createStoreFromFactory({ reportError: () => {} });
  factoryStore.dispatch(actionCreators.windowOpened("crawl"));
  assert.equal(factoryStore.getState().ui.focusedAppId, "crawl");

  const dangerous = JSON.parse(
    '{"appId":"crawl","constructor":{"prototype":{"polluted":true}}}',
  );
  assert.throws(
    () => rootReducer(initial, { type: ACTION_TYPES.UI_WINDOW_OPENED, payload: dangerous }),
    TypeError,
  );
  assert.equal({}.polluted, undefined);
});

test("store data 与 runtime 可脱离 root transition 单独导入和纯执行", () => {
  const source = { nested: [{ count: 1 }], map: new Map([["key", { safe: true }]]) };
  const cloned = cloneInput(source);
  assert.notEqual(cloned, source);
  assert.notEqual(cloned.nested, source.nested);
  assert.notEqual(cloned.map, source.map);
  source.nested[0].count = 99;
  source.map.get("key").safe = false;
  assert.deepEqual(cloned.nested, [{ count: 1 }]);
  assert.deepEqual(cloned.map.get("key"), { safe: true });

  const immutable = makeImmutable(cloned);
  assert.equal(Object.isFrozen(immutable), true);
  assert.equal(Object.isFrozen(immutable.nested[0]), true);
  assert.throws(() => immutable.map.clear(), TypeError);

  const notifications = [];
  const runtime = createStoreRuntime({
    initialState: { count: 0 },
    normalizeAction(input) {
      if (input?.type !== "fixture/increment") throw new TypeError("fixture action invalid");
      return { type: input.type, payload: cloneInput(input.payload) };
    },
    reducer(state, action) {
      return { count: state.count + action.payload.amount };
    },
    reportError: () => {},
  });
  runtime.subscribe((state) => state.count, (value, previous, action) => {
    notifications.push([value, previous, action.type]);
  });
  runtime.dispatch({ type: "fixture/increment", payload: { amount: 2 } });
  assert.equal(runtime.getState().count, 2);
  assert.deepEqual(notifications, [[2, 0, "fixture/increment"]]);
  assert.throws(() => runtime.dispatch({ type: "fixture/unknown" }), TypeError);
});

test("store runtime 拒绝危险键、循环与不支持对象，并深度只读 Map", () => {
  const store = createStore({
    initialState: { payload: null },
    reducer: (_state, action) => ({ payload: action.payload }),
    reportError: () => {},
  });
  const safeType = ACTION_TYPES.UI_WINDOW_OPENED;
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const payload = JSON.parse(`{"${key}":{"polluted":true}}`);
    assert.throws(() => store.dispatch({ type: safeType, payload }), TypeError);
  }
  assert.equal({}.polluted, undefined);

  const cyclic = { value: 1 };
  cyclic.self = cyclic;
  assert.throws(() => store.dispatch({ type: safeType, payload: cyclic }), TypeError);
  for (const payload of [new Date(), new Set(), /fixture/u, () => true, 1n]) {
    assert.throws(() => store.dispatch({ type: safeType, payload }), TypeError);
  }

  const source = new Map([["entry", { nested: [1, 2] }]]);
  store.dispatch({ type: safeType, payload: source });
  source.get("entry").nested.push(3);
  const stored = store.getState().payload;
  assert.deepEqual(stored.get("entry").nested, [1, 2]);
  assert.throws(() => stored.set("other", {}), TypeError);
  assert.throws(() => stored.get("entry").nested.push(3), TypeError);
  let callbackMap = null;
  stored.forEach((_value, _key, map) => { callbackMap = map; });
  assert.equal(callbackMap, stored);

  store.dispatch({ type: safeType, payload: { recovered: true } });
  assert.deepEqual(store.getState().payload, { recovered: true });
});

test("store 订阅快照、比较器、退订和 reducing/notifying 嵌套边界保持稳定", () => {
  const reports = [];
  const store = createStore({ reportError: (event) => reports.push(event) });
  const events = [];
  let unsubscribeSecond = () => {};
  let installedLate = false;
  store.subscribe(selectors.focusedAppId, (selected, previous, action) => {
    events.push(["first", selected, previous, action.type, Object.isFrozen(action)]);
    unsubscribeSecond();
    if (!installedLate) {
      installedLate = true;
      store.subscribe(selectors.focusedAppId, (value) => events.push(["late", value]));
    }
  });
  unsubscribeSecond = store.subscribe(
    selectors.focusedAppId,
    (value) => events.push(["second", value]),
  );
  store.subscribe(selectors.focusedAppId, () => events.push(["equal-never"]), {
    equality: () => true,
  });

  const receipt = store.dispatch(actionCreators.windowOpened("crawl"));
  assert.deepEqual(receipt, { type: ACTION_TYPES.UI_WINDOW_OPENED });
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(events, [[
    "first", "crawl", null, ACTION_TYPES.UI_WINDOW_OPENED, true,
  ]]);
  store.dispatch(actionCreators.windowClosed("crawl"));
  assert.deepEqual(events.at(-1), ["late", null]);
  assert.equal(events.some(([name]) => name === "second" || name === "equal-never"), false);

  let reducingStore;
  let nestedError = null;
  reducingStore = createStore({
    initialState: { count: 0 },
    reducer(state, action) {
      try {
        reducingStore.dispatch(actionCreators.windowClosed("crawl"));
      } catch (error) {
        nestedError = error;
      }
      return { count: state.count + (action.payload?.appId === "crawl" ? 1 : 0) };
    },
    reportError: (event) => reports.push(event),
  });
  reducingStore.dispatch(actionCreators.windowOpened("crawl"));
  assert.match(nestedError.message, /不得嵌套 dispatch/);
  assert.equal(reducingStore.getState().count, 1);
  assert.deepEqual(reports, []);
});

test("store 初始化完整状态并阻止外部修改数组、对象和 Map", () => {
  const initial = createInitialState();
  initial.crawl.sources.push({ site: "fixture" });
  initial.auth.bySite.set("fixture", { authorized: false });
  const store = createStore({ initialState: initial, reportError: () => {} });
  const state = store.getState();
  assert.deepEqual(
    Object.keys(state),
    ["system", "diagnostics", "proxy", "auth", "policy", "crawl", "batches", "review", "ui"],
  );
  assert(Object.isFrozen(state));
  assert(Object.isFrozen(state.crawl.sources));
  assert.throws(() => state.crawl.sources.push({}), TypeError);
  assert.throws(() => state.auth.bySite.set("other", {}), TypeError);

  initial.crawl.sources[0].site = "mutated";
  initial.auth.bySite.get("fixture").authorized = true;
  assert.equal(state.crawl.sources[0].site, "fixture");
  assert.equal(state.auth.bySite.get("fixture").authorized, false);
});

test("store 仅通过已知 action 更新，selector 避免无关通知", () => {
  const reports = [];
  const store = createStore({ reportError: (event) => reports.push(event) });
  let focusNotifications = 0;
  store.subscribe(selectors.focusedAppId, () => { focusNotifications += 1; });
  store.dispatch(actionCreators.shellSummaryUpdated(shellSnapshot()));
  assert.equal(focusNotifications, 0);
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(focusNotifications, 1);
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.deepEqual(store.getState().ui.windows.map((item) => ({
    appId: item.appId,
    windowState: item.windowState,
  })), [{ appId: "review", windowState: "maximized" }]);
  assert.throws(
    () => store.dispatch(actionCreators.windowStateChanged("review", "invisible")),
    TypeError,
  );
  assert.throws(() => store.dispatch({ type: "unknown/action" }), UnknownActionError);
  assert.deepEqual(reports, []);
});

test("store 克隆 action payload，订阅者异常与嵌套 dispatch 不阻断其他订阅者", () => {
  let reportCount = 0;
  const store = createStore({ reportError: () => { reportCount += 1; } });
  const payload = shellSnapshot();
  store.dispatch(actionCreators.shellSummaryUpdated(payload));
  payload.health.ok = false;
  payload.summary.api.label = "被外部修改";
  assert.equal(store.getState().system.health.ok, true);
  assert.equal(store.getState().system.summary.api.label, "API 已就绪");

  let secondSubscriberRan = false;
  store.subscribe(selectors.focusedAppId, () => {
    store.dispatch(actionCreators.windowClosed("crawl"));
  });
  store.subscribe(selectors.focusedAppId, () => {
    secondSubscriberRan = true;
    assert.throws(() => { store.getState().ui.focusedAppId = "proxy"; }, TypeError);
  });
  store.dispatch(actionCreators.windowOpened("crawl"));
  assert.equal(reportCount, 1);
  assert.equal(secondSubscriberRan, true);
  assert.equal(store.getState().ui.focusedAppId, "crawl");
});

test("store 初次订阅渲染期间同样禁止嵌套 dispatch", () => {
  let reportCount = 0;
  const store = createStore({ reportError: () => { reportCount += 1; } });
  store.subscribe(selectors.focusedAppId, () => {
    store.dispatch(actionCreators.windowOpened("crawl"));
  }, { fireImmediately: true });
  assert.equal(reportCount, 1);
  assert.equal(store.getState().ui.focusedAppId, null);
});

test("跨应用 action 先调用 router，只有路由结果才能更新 focusedAppId", () => {
  const store = createStore({ reportError: () => {} });
  const navigations = [];
  const writes = [];
  const storage = {
    writeCurrentApp: (appId) => writes.push(["app", appId]),
    writeWindowLayout: (windows) => writes.push([
      "layout",
      windows.map((item) => ({
        appId: item.appId,
        windowState: item.windowState,
        rect: { ...item.rect },
      })),
    ]),
    writeActiveBatchId: (batchId) => writes.push(["batch", batchId]),
    clearActiveBatchId: () => writes.push(["batch-clear"]),
  };
  const timers = new FakeTimers();
  const actions = createShellActions({
    store,
    router: { navigate: (target) => navigations.push(target) },
    storage,
    getRegisteredApplicationById: getApplicationById,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  actions.navigateToApp("review");
  assert.deepEqual(navigations, ["review"]);
  assert.equal(store.getState().ui.focusedAppId, null);
  actions.routeResolved(getApplicationById("review"));
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.throws(
    () => actions.routeResolved({ ...getApplicationById("tasks") }),
    /路由结果不是已注册应用/,
  );
  assert.equal(store.getState().ui.windows[0].windowState, "maximized");
  actions.toggleWindowMaximized("review");
  assert.equal(store.getState().ui.windows[0].windowState, "normal");
  actions.minimizeWindow("review");
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(navigations, ["review", null], "无聚焦窗口时必须同步桌面路由");
  actions.restoreWindow("review");
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.deepEqual(navigations, ["review", null, "review"]);
  assert.equal(WINDOW_LAYOUT_DEBOUNCE_MS >= 300, true);
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);
  assert.deepEqual(writes.map((entry) => entry[0]), ["app", "app"]);
  timers.runNext();
  assert.deepEqual(writes.map((entry) => entry[0]), ["app", "app", "layout"]);
  assert.deepEqual(writes.at(-1)[1].map((item) => item.windowState), ["normal"]);
  actions.destroy();
});

test("windowOpened 只在首次启动消费位置 hint，既有窗口状态不被覆盖", () => {
  const placement = {
    rect: windowRect({ x: 111, y: 77, w: 800, h: 520 }),
    maximized: true,
  };
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl", placement));
  assert.deepEqual(selectors.windowStack(store.getState()), [
    windowRecord("crawl", "maximized", placement.rect),
  ]);
  store.dispatch(actionCreators.windowStateChanged("crawl", "normal"));
  store.dispatch(actionCreators.windowOpened("crawl", {
    rect: windowRect({ x: 999 }),
    maximized: true,
  }));
  assert.deepEqual(selectors.windowStack(store.getState()), [
    windowRecord("crawl", "normal", placement.rect),
  ]);
});

test("windowOpened 重复打开同一 appId 不会产生第二个窗口", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("review"));
  const first = selectors.windowStack(store.getState())[0];
  store.dispatch(actionCreators.windowOpened("review"));
  const windows = selectors.windowStack(store.getState());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].appId, "review");
  assert.deepEqual(windows[0].rect, first.rect);
  assert.equal("zIndex" in windows[0], false);
});

test("windowOpened 已存在时会提到栈顶且从 minimized 恢复", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("review"));
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  store.dispatch(actionCreators.windowOpened("crawl"));
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((item) => [item.appId, item.windowState]),
    [["review", "maximized"], ["crawl", "normal"]],
  );
  assert.equal(store.getState().ui.focusedAppId, "crawl");
});

test("focusedAppId 始终为栈顶非 minimized 窗口", () => {
  const tamperedInitial = createInitialState({
    windows: [windowRecord("crawl"), windowRecord("tasks", "minimized")],
  });
  tamperedInitial.ui.focusedAppId = "tasks";
  const normalizedStore = createStore({
    initialState: tamperedInitial,
    reportError: () => {},
  });
  assert.equal(normalizedStore.getState().ui.focusedAppId, "crawl");

  const store = createStore({ reportError: () => {} });
  const assertDerivedFocus = () => {
    const windows = selectors.windowStack(store.getState());
    const expected = [...windows].reverse()
      .find((item) => item.windowState !== "minimized")?.appId ?? null;
    assert.equal(store.getState().ui.focusedAppId, expected);
  };

  for (const appId of ["crawl", "tasks", "review"]) {
    store.dispatch(actionCreators.windowOpened(appId));
    assertDerivedFocus();
  }
  store.dispatch(actionCreators.windowStateChanged("review", "minimized"));
  assertDerivedFocus();
  store.dispatch(actionCreators.windowFocused("crawl"));
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((item) => item.appId),
    ["tasks", "review", "crawl"],
  );
  assertDerivedFocus();
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  assertDerivedFocus();
});

test("全部 minimized 时 focusedAppId 为 null 且兼容视图仍可恢复", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("tasks"));
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  store.dispatch(actionCreators.windowStateChanged("tasks", "minimized"));
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: "tasks",
    windowState: "normal",
    visibility: "minimized",
  });
});

test("windowClosed 后聚焦回落到新栈顶", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("tasks"));
  store.dispatch(actionCreators.windowOpened("review"));
  store.dispatch(actionCreators.windowClosed("review"));
  assert.equal(store.getState().ui.focusedAppId, "tasks");
  store.dispatch(actionCreators.windowClosed("tasks"));
  assert.equal(store.getState().ui.focusedAppId, "crawl");
  store.dispatch(actionCreators.windowClosed("crawl"));
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(selectors.windowStack(store.getState()), []);
});

test("窗口 actions 对非法 state、rect 与未知 appId 均抛 TypeError", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  const unknownActions = [
    actionCreators.windowOpened("unknown"),
    actionCreators.windowClosed("unknown"),
    actionCreators.windowFocused("unknown"),
    actionCreators.windowMoved("unknown", windowRect()),
    actionCreators.windowStateChanged("unknown", "normal"),
  ];
  for (const action of unknownActions) {
    assert.throws(() => store.dispatch(action), TypeError);
  }
  for (const windowState of ["open", "closed", "MINIMIZED", null]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowStateChanged("crawl", windowState)),
      TypeError,
    );
  }
  for (const rect of [
    null,
    { x: 0, y: 0, w: 720 },
    { x: 0, y: 0, w: 720, h: 480, url: "https://example.invalid/layout" },
    windowRect({ x: Number.NaN }),
    windowRect({ y: Number.POSITIVE_INFINITY }),
    windowRect({ w: "720" }),
  ]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowMoved("crawl", rect)),
      TypeError,
    );
  }
});

test("窗口 rect 小于最小尺寸时抛 TypeError", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  for (const rect of [windowRect({ w: 359 }), windowRect({ h: 239 })]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowMoved("crawl", rect)),
      TypeError,
    );
  }
  store.dispatch(actionCreators.windowMoved("crawl", windowRect({ w: 360, h: 240 })));
  assert.deepEqual(store.getState().ui.windows[0].rect, windowRect({ w: 360, h: 240 }));
});

test("clampRect 在四个视口边缘都保留至少 32px 可见区域", () => {
  const viewport = { width: 1000, height: 700 };
  const options = { minW: 360, minH: 240, taskbarHeight: 40 };
  const topLeft = clampRect(
    { x: -5000, y: -5000, w: 720, h: 480 },
    viewport,
    options,
  );
  assert.deepEqual(topLeft, { x: -688, y: -448, w: 720, h: 480 });
  assert.equal(topLeft.x + topLeft.w, 32);
  assert.equal(topLeft.y + topLeft.h, 32);

  const bottomRight = clampRect(
    { x: 5000, y: 5000, w: 720, h: 480 },
    viewport,
    options,
  );
  assert.deepEqual(bottomRight, { x: 968, y: 180, w: 720, h: 480 });
  assert.equal(viewport.width - bottomRight.x, 32);
});

test("clampRect 与 maximizedRect 始终停在任务栏可用区上方", () => {
  const viewport = { width: 1024, height: 768 };
  const options = { minW: 360, minH: 240, taskbarHeight: 48 };
  const normal = clampRect(
    { x: 20, y: 700, w: 640, h: 400 },
    viewport,
    options,
  );
  assert.equal(normal.y + normal.h, 720);
  assert.deepEqual(maximizedRect(viewport, options), {
    x: 0,
    y: 0,
    w: 1024,
    h: 720,
  });
});

test("resize 遵守 360x240 最小尺寸且 drag 在边缘 clamp", () => {
  const viewport = { width: 1000, height: 700 };
  const options = { minW: 360, minH: 240, taskbarHeight: 40 };
  assert.deepEqual(nextRectForResize(
    { x: 100, y: 80, w: 500, h: 300 },
    { x: -1000, y: -1000 },
    viewport,
    options,
  ), { x: 100, y: 80, w: 360, h: 240 });
  assert.deepEqual(nextRectForDrag(
    { x: 100, y: 80, w: 500, h: 300 },
    { x: 5000, y: 5000 },
    viewport,
    options,
  ), { x: 968, y: 360, w: 500, h: 300 });
});

test("窗口几何严格拒绝未知字段、访问器与非有限数字", () => {
  assert.throws(() => clampRect(
    { x: 0, y: 0, w: 500, h: 300, zIndex: 1 },
    { width: 1000, height: 700 },
  ), TypeError);
  assert.throws(() => nextRectForDrag(
    { x: 0, y: 0, w: 500, h: 300 },
    { x: Number.NaN, y: 0 },
    { width: 1000, height: 700 },
  ), TypeError);
  const accessor = { x: 0, y: 0, w: 500 };
  Object.defineProperty(accessor, "h", { enumerable: true, get: () => 300 });
  assert.throws(() => clampRect(accessor, { width: 1000, height: 700 }), TypeError);
});

test("maximized 只改变窗口状态，恢复后保留最大化前 rect", () => {
  const rect = windowRect({ x: 91, y: 73, w: 640, h: 420 });
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl", "normal", rect)] }),
    reportError: () => {},
  });
  store.dispatch(actionCreators.windowStateChanged("crawl", "maximized"));
  assert.deepEqual(store.getState().ui.windows[0].rect, rect);
  store.dispatch(actionCreators.windowStateChanged("crawl", "normal"));
  assert.deepEqual(store.getState().ui.windows[0], windowRecord("crawl", "normal", rect));
});

test("窗口指针收尾在交互样式内同步最终矩形且重复结束幂等", () => {
  const fixture = installWindowManagerDomFixture();
  const initialRect = windowRect();
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("crawl", "normal", initialRect)],
    }),
    reportError: () => {},
  });
  const moveCalls = [];
  let beginCount = 0;
  let endCount = 0;
  let completionEvents = null;
  let windowElement = null;
  let manager = null;
  const actions = {
    beginWindowInteraction() {
      beginCount += 1;
      return true;
    },
    endWindowInteraction() {
      endCount += 1;
      completionEvents?.push([
        "end",
        windowElement.hasAttribute("data-window-interacting"),
      ]);
      return true;
    },
    moveWindow(appId, rect) {
      const snapshot = { ...rect };
      moveCalls.push([appId, snapshot]);
      completionEvents?.push([
        "move-before",
        windowElement.hasAttribute("data-window-interacting"),
      ]);
      store.dispatch(actionCreators.windowMoved(appId, snapshot));
      completionEvents?.push([
        "move-after",
        windowElement.hasAttribute("data-window-interacting"),
        {
          left: windowElement.style.left,
          top: windowElement.style.top,
          width: windowElement.style.width,
          height: windowElement.style.height,
        },
      ]);
      return true;
    },
    focusWindow() { return false; },
    minimizeWindow() { return false; },
    restoreWindow() { return false; },
    closeWindow() { return false; },
    toggleWindowMaximized() { return false; },
  };

  const finishAndAssert = (control, eventType, pointerId, finalRect) => {
    completionEvents = [];
    windowElement.onStyleWrite = (property) => {
      if (!["left", "top", "width", "height"].includes(property)) return;
      completionEvents.push([
        `sync-${property}`,
        windowElement.hasAttribute("data-window-interacting"),
      ]);
    };
    windowElement.onAttributeRemove = (name) => {
      if (name === "data-window-interacting") completionEvents.push(["remove-style"]);
    };

    control.emit(eventType, { pointerId });
    // 浏览器可在 pointerup/pointercancel 后继续派发 lostpointercapture。
    control.emit("lostpointercapture", { pointerId });

    const moveBefore = completionEvents.findIndex(([event]) => event === "move-before");
    const moveAfter = completionEvents.findIndex(([event]) => event === "move-after");
    const removeStyle = completionEvents.findIndex(([event]) => event === "remove-style");
    assert.equal(moveBefore >= 0, true);
    assert.equal(moveAfter > moveBefore, true);
    assert.equal(removeStyle > moveAfter, true, "最终 store/DOM 同步必须先于交互样式解除");
    assert.equal(completionEvents[moveBefore][1], true);
    assert.equal(completionEvents[moveAfter][1], true);
    assert.deepEqual(completionEvents[moveAfter][2], {
      left: `${finalRect.x}px`,
      top: `${finalRect.y}px`,
      width: `${finalRect.w}px`,
      height: `${finalRect.h}px`,
    });
    const syncEvents = completionEvents.filter(([event]) => event.startsWith("sync-"));
    assert.equal(syncEvents.length, 4);
    assert.equal(syncEvents.every(([, interacting]) => interacting === true), true);
    assert.deepEqual(completionEvents.at(-1), ["end", false]);
    assert.equal(windowElement.hasAttribute("data-window-interacting"), false);
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, finalRect);
    assert.deepEqual({
      left: windowElement.style.left,
      top: windowElement.style.top,
      width: windowElement.style.width,
      height: windowElement.style.height,
    }, {
      left: `${finalRect.x}px`,
      top: `${finalRect.y}px`,
      width: `${finalRect.w}px`,
      height: `${finalRect.h}px`,
    });
    windowElement.onStyleWrite = null;
    windowElement.onAttributeRemove = null;
    completionEvents = null;
  };

  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
    });
    windowElement = fixture.windowLayer.querySelector("[data-application-window]");
    const titlebar = windowElement.querySelector("[data-window-titlebar]");

    titlebar.emit("pointerdown", {
      pointerId: 7,
      clientX: 100,
      clientY: 100,
    });
    assert.equal(windowElement.getAttribute("data-window-interacting"), "drag");
    titlebar.emit("pointermove", { pointerId: 7, clientX: 125, clientY: 117 });
    titlebar.emit("pointermove", { pointerId: 7, clientX: 130, clientY: 120 });
    const draggedRect = { x: 78, y: 56, w: 720, h: 480 };
    assert.equal(moveCalls.length, 0, "高频 pointermove 不得提交 store");
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, initialRect);
    assert.equal(windowElement.style.left, `${draggedRect.x}px`);
    assert.equal(windowElement.style.top, `${draggedRect.y}px`);
    finishAndAssert(titlebar, "pointerup", 7, draggedRect);
    assert.equal(moveCalls.length, 1, "pointerup 与 lostpointercapture 只能提交一次");

    const resize = windowElement.querySelector('[data-window-resize="corner"]');
    resize.emit("pointerdown", {
      pointerId: 11,
      clientX: 300,
      clientY: 300,
    });
    assert.equal(windowElement.getAttribute("data-window-interacting"), "resize");
    resize.emit("pointermove", { pointerId: 11, clientX: 340, clientY: 330 });
    const resizedRect = { x: 78, y: 56, w: 760, h: 510 };
    assert.equal(moveCalls.length, 1, "缩放 pointermove 同样不得提交 store");
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, draggedRect);
    finishAndAssert(resize, "pointercancel", 11, resizedRect);
    assert.equal(moveCalls.length, 2, "pointercancel 与 lostpointercapture 只能提交一次");

    titlebar.emit("pointerdown", {
      pointerId: 13,
      clientX: 50,
      clientY: 50,
    });
    titlebar.emit("pointermove", { pointerId: 13, clientX: 40, clientY: 55 });
    const captureLostRect = { x: 68, y: 61, w: 760, h: 510 };
    assert.equal(moveCalls.length, 2, "lostpointercapture 前仍不得提前提交");
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, resizedRect);
    finishAndAssert(titlebar, "lostpointercapture", 13, captureLostRect);
    assert.equal(moveCalls.length, 3, "lostpointercapture 重入只能提交一次");

    assert.deepEqual(moveCalls, [
      ["crawl", draggedRect],
      ["crawl", resizedRect],
      ["crawl", captureLostRect],
    ]);
    assert.deepEqual([beginCount, endCount], [3, 3]);
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window DOM lifecycle collaborator 独立保持 mount/visibility/unmount 顺序与 z 投影", () => {
  const fixture = installWindowManagerDomFixture();
  const events = [];
  let lifecycle = null;
  try {
    lifecycle = createWindowDomLifecycle({
      bindInstanceEvents(instance) {
        events.push(["bind", instance.appId]);
        instance.cleanupEvents = () => events.push(["cleanup", instance.appId]);
      },
      displayedRect: (record) => ({ ...record.rect }),
      forcedMobileMaximized: () => false,
      onBeforeRemove: (appId) => events.push(["beforeRemove", appId]),
      onMount: (app) => events.push(["mount", app.id]),
      onRemoved: (appId) => events.push(["removed", appId]),
      onUnmount: (app) => events.push(["unmount", app.id]),
      onVisibilityChange: (visible, app) => events.push(["visibility", app.id, visible]),
      queueNormalRectRepair: (record, rect) => events.push(["repair", record.appId, rect.x]),
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
    });
    const instance = lifecycle.create("crawl");
    const record = windowRecord("crawl");
    const [view] = deriveWindowViews([record], "crawl", false);
    lifecycle.sync(instance, record, view, 4, "crawl");
    assert.equal(instance.element.style.zIndex, "4");
    assert.equal(instance.element.style.left, `${record.rect.x}px`);
    assert.equal(instance.visible, true);
    assert.equal(lifecycle.focusBody("crawl"), true);
    assert.equal(lifecycle.bodyFor("crawl"), instance.bodyEl);
    assert.equal(lifecycle.remove("crawl"), true);
    assert.equal(lifecycle.remove("crawl"), false);
    assert.equal(fixture.windowLayer.children.length, 0);
    assert.deepEqual(events, [
      ["bind", "crawl"],
      ["mount", "crawl"],
      ["repair", "crawl", record.rect.x],
      ["visibility", "crawl", true],
      ["beforeRemove", "crawl"],
      ["visibility", "crawl", false],
      ["unmount", "crawl"],
      ["cleanup", "crawl"],
      ["removed", "crawl"],
    ]);

    const element = new FakeDomHtmlElement("section");
    applyWindowRect(element, { x: 1, y: 2, w: 3, h: 4 });
    assert.deepEqual({
      left: element.style.left,
      top: element.style.top,
      width: element.style.width,
      height: element.style.height,
    }, { left: "1px", top: "2px", width: "3px", height: "4px" });
  } finally {
    for (const appId of [...(lifecycle?.keys() || [])]) lifecycle.remove(appId);
    fixture.restore();
  }
});

test("window interaction collaborator 独立保持 pointermove 零提交与统一单次收尾", () => {
  let record = windowRecord("crawl", "normal", windowRect());
  const calls = [];
  const element = new FakeDomHtmlElement("section");
  const control = new FakeDomHtmlElement("header");
  const instance = { appId: "crawl", element, interaction: null };
  const controller = createWindowInteractionController({
    actions: {
      beginWindowInteraction: () => calls.push(["begin"]),
      endWindowInteraction: () => calls.push(["end"]),
      moveWindow(appId, rect) {
        calls.push(["move", appId, { ...rect }]);
        record = { ...record, rect: { ...rect } };
      },
    },
    applyRect(target, rect) {
      calls.push(["apply", { ...rect }]);
      target.style.left = `${rect.x}px`;
    },
    displayedRect: (value) => ({ ...value.rect }),
    effectivelyMaximized: (value) => value.windowState === "maximized",
    getRecord: () => record,
    getViewport: () => ({ width: 1200, height: 800 }),
    getGeometryOptions: () => ({ minW: 360, minH: 240, taskbarHeight: 40 }),
    isMobileViewport: () => false,
    isUnavailable: () => false,
    isDestroying: () => false,
    normalRect: (value) => ({ ...value.rect }),
  });
  const startEvent = {
    button: 0,
    isPrimary: true,
    pointerId: 31,
    clientX: 100,
    clientY: 100,
    currentTarget: control,
  };
  controller.start(instance, startEvent, "drag");
  assert.equal(instance.interaction.type, "drag");
  controller.move(instance, { pointerId: 31, clientX: 140, clientY: 125 });
  assert.equal(calls.filter(([name]) => name === "move").length, 0);
  assert.equal(element.style.left, "88px");
  assert.equal(controller.finish(instance, { pointerId: 31 }), true);
  assert.equal(controller.finish(instance, { pointerId: 31 }), false);
  assert.deepEqual(calls.filter(([name]) => name === "move"), [[
    "move", "crawl", { x: 88, y: 61, w: 720, h: 480 },
  ]]);
  assert.deepEqual(calls.filter(([name]) => name === "begin" || name === "end"), [
    ["begin"], ["end"],
  ]);
});

test("window hide collaborator 独立去重 async 请求并淘汰失效实例", async () => {
  const instance = { appId: "crawl" };
  let currentInstance = instance;
  let record = windowRecord("crawl");
  let unavailable = false;
  let beforeHideCount = 0;
  const pending = [];
  const commits = [];
  const controller = createWindowHideController({
    getApplication: (appId) => ({ id: appId }),
    getInstance: () => currentInstance,
    getRecord: () => record,
    isUnavailable: () => unavailable,
    onBeforeHide() {
      beforeHideCount += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  controller.request(instance, "minimized", (app) => commits.push(app.id));
  controller.request(instance, "minimized", (app) => commits.push(`duplicate:${app.id}`));
  assert.equal(beforeHideCount, 1);
  pending.shift()(true);
  await flushPromises();
  assert.deepEqual(commits, ["crawl"]);

  controller.request(instance, "closed", (app) => commits.push(`stale:${app.id}`));
  assert.equal(beforeHideCount, 2);
  currentInstance = null;
  controller.invalidate("crawl");
  pending.shift()(true);
  await flushPromises();
  assert.deepEqual(commits, ["crawl"]);

  currentInstance = instance;
  unavailable = true;
  controller.request(instance, "closed", () => commits.push("unavailable"));
  assert.equal(beforeHideCount, 2);
  record = null;
  controller.destroy();
});

test("window-layer 工作区投影使用真实本地尺寸且几何选项不重复扣 Dock", () => {
  const fixture = installWindowManagerDomFixture();
  try {
    fixture.windowLayer.clientWidth = 1_440;
    fixture.windowLayer.clientHeight = 772;
    assert.deepEqual(measureWindowLayerViewport(fixture.windowLayer, fixture.documentObject), {
      width: 1_440,
      height: 772,
    });
    assert.deepEqual(windowLayerGeometryOptions(), {
      minW: 360,
      minH: 240,
      taskbarHeight: 0,
    });
    assert.deepEqual(
      maximizedRect(
        measureWindowLayerViewport(fixture.windowLayer, fixture.documentObject),
        windowLayerGeometryOptions(),
      ),
      { x: 0, y: 0, w: 1_440, h: 772 },
    );
  } finally {
    fixture.restore();
  }
});

test("window manager 最大化严格使用 window-layer 本地工作区且不重复扣 Dock", () => {
  const fixture = installWindowManagerDomFixture();
  fixture.windowLayer.clientWidth = 1_000;
  fixture.windowLayer.clientHeight = 600;
  fixture.computedValues.set("--imageweave-dock-height", "72px");
  const rect = windowRect({ x: 91, y: 73, w: 640, h: 420 });
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl", "normal", rect)] }),
    reportError: () => {},
  });
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions: createManagerActions(store),
    });
    const element = windowElementFor(fixture.windowLayer, "crawl");
    assert.deepEqual({
      left: element.style.left,
      top: element.style.top,
      width: element.style.width,
      height: element.style.height,
    }, { left: "91px", top: "73px", width: "640px", height: "420px" });

    element.querySelector("[data-window-maximize]").emit("click", { detail: 1 });
    assert.equal(element.hasAttribute("data-maximized"), true);
    assert.deepEqual({
      left: element.style.left,
      top: element.style.top,
      width: element.style.width,
      height: element.style.height,
    }, { left: "0px", top: "0px", width: "1000px", height: "600px" });

    element.querySelector("[data-window-maximize]").emit("click", { detail: 1 });
    assert.equal(element.hasAttribute("data-maximized"), false);
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, rect);
    assert.deepEqual({
      left: element.style.left,
      top: element.style.top,
      width: element.style.width,
      height: element.style.height,
    }, { left: "91px", top: "73px", width: "640px", height: "420px" });
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window manager 保持快照、z 序投影和生命周期/关闭回退顺序", () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("crawl"), windowRecord("tasks")],
    }),
    reportError: () => {},
  });
  const actionCalls = [];
  const lifecycle = [];
  const actions = createManagerActions(store, actionCalls);
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
      onMount: (app) => lifecycle.push(["mount", app.id]),
      onVisibilityChange: (visible, app) => lifecycle.push(["visibility", app.id, visible]),
      onBeforeHide: (app, visibility) => {
        lifecycle.push(["beforeHide", app.id, visibility]);
        return true;
      },
      onUnmount: (app) => lifecycle.push(["unmount", app.id]),
      onCloseFocus: (app) => lifecycle.push(["closeFocus", app.id]),
    });
    assert.deepEqual(manager.getSnapshot(), {
      appId: "tasks",
      visibility: "open",
      maximized: false,
      preferredWindowState: "normal",
    });
    assert.deepEqual(Object.keys(manager.getSnapshot()), [
      "appId", "visibility", "maximized", "preferredWindowState",
    ]);
    const crawlWindow = windowElementFor(fixture.windowLayer, "crawl");
    const tasksWindow = windowElementFor(fixture.windowLayer, "tasks");
    assert.equal(crawlWindow.style.zIndex, "0");
    assert.equal(tasksWindow.style.zIndex, "1");
    assert.equal(selectors.windowStack(store.getState()).some((record) => "zIndex" in record), false);

    crawlWindow.emit("pointerdown");
    assert.deepEqual(selectors.windowStack(store.getState()).map((record) => record.appId), [
      "tasks", "crawl",
    ]);
    assert.equal(tasksWindow.style.zIndex, "0");
    assert.equal(crawlWindow.style.zIndex, "1");

    const close = crawlWindow.querySelector("[data-window-close]");
    close.emit("click");
    assert.equal(selectors.focusedAppId(store.getState()), "tasks");
    assert.equal(windowElementFor(fixture.windowLayer, "crawl"), null);
    assert.deepEqual(lifecycle.slice(-4), [
      ["beforeHide", "crawl", "closed"],
      ["visibility", "crawl", false],
      ["unmount", "crawl"],
      ["closeFocus", "crawl"],
    ]);
  } finally {
    manager?.destroy();
    manager?.destroy();
    fixture.restore();
  }
  assert.equal(lifecycle.filter(([event]) => event === "unmount").length, 2);
});

test("菜单组件拒绝缺失宿主依赖且不建立窗口状态旁路", () => {
  const fixture = installWindowManagerDomFixture();
  const root = new FakeDomHtmlElement("header");
  const appName = new FakeDomHtmlElement("span");
  appName.setAttribute("data-menu-current-app", "");
  const menuHost = new FakeDomHtmlElement("nav");
  menuHost.setAttribute("data-menu-items", "");
  root.append(appName, menuHost);
  const store = createStore({ reportError: () => {} });
  const valid = {
    root,
    store,
    selectors,
    actions: { navigateToApp() {} },
    onWindowCommand() {},
    documentObject: fixture.documentObject,
    windowObject: fixture.windowObject,
  };
  try {
    assert.throws(() => createMenuBar({ ...valid, root: {} }), /宿主无效/);
    assert.throws(() => createMenuBar({ ...valid, store: null }), /中央状态/);
    assert.throws(() => createMenuBar({ ...valid, selectors: null }), /selector/);
    assert.throws(() => createMenuBar({ ...valid, actions: null }), /shell actions/);
    assert.throws(() => createMenuBar({ ...valid, onWindowCommand: null }), /窗口命令委托/);
    const incomplete = new FakeDomHtmlElement("header");
    assert.throws(() => createMenuBar({ ...valid, root: incomplete }), /DOM 不完整/);
  } finally {
    fixture.restore();
  }
});

test("窗口菜单命令只委托 window manager 生命周期入口", async () => {
  const fixture = installWindowManagerDomFixture();
  const root = new FakeDomHtmlElement("header");
  const appName = new FakeDomHtmlElement("span");
  appName.setAttribute("data-menu-current-app", "");
  const menuHost = new FakeDomHtmlElement("nav");
  menuHost.setAttribute("data-menu-items", "");
  root.append(appName, menuHost);
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("personalization")] }),
    reportError: () => {},
  });
  const actions = createManagerActions(store);
  actions.navigateToApp = () => false;
  let manager = null;
  let menu = null;
  let beforeHideCount = 0;
  let centerOpenCount = 0;
  let refreshCount = 0;
  const decisions = [];
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
      onBeforeHide(_app, visibility) {
        beforeHideCount += 1;
        assert.equal(visibility, "minimized");
        return new Promise((resolve) => decisions.push(resolve));
      },
    });
    menu = createMenuBar({
      root,
      store,
      selectors,
      actions,
      onWindowCommand: (command, appId) => manager.activate(command, appId),
      onOpenApplicationCenter() { centerOpenCount += 1; },
      onRefreshSummary() { refreshCount += 1; },
      documentObject: fixture.documentObject,
      windowObject: fixture.windowObject,
    });
    const windowTrigger = menuHost.querySelector('[data-shell-menu-trigger="window"]');
    windowTrigger.emit("click");
    const minimize = menuHost.querySelector('[data-menu-command="window:personalization"]');
    assert(minimize instanceof HTMLButtonElement);
    minimize.emit("click");
    manager.activate("minimize", "personalization");
    assert.equal(beforeHideCount, 1);
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "normal");
    assert.equal(selectors.focusedAppId(store.getState()), "personalization");

    decisions.shift()(false);
    await flushPromises();
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "normal");
    assert.equal(selectors.focusedAppId(store.getState()), "personalization");

    windowTrigger.emit("click");
    menuHost.querySelector('[data-menu-command="window:personalization"]').emit("click");
    assert.equal(beforeHideCount, 2);
    decisions.shift()(true);
    await flushPromises();
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "minimized");
    assert.equal(selectors.focusedAppId(store.getState()), null);
    // 覆盖菜单键盘导航、快捷键、外部关闭和幂等销毁分支。
    const fileTrigger = menuHost.querySelector('[data-shell-menu-trigger="file"]');
    fileTrigger.emit("click");
    for (const key of ["End", "Home", "ArrowDown", "ArrowUp"]) {
      fixture.documentObject.emit("keydown", { key, target: fixture.documentObject.activeElement });
    }
    fixture.documentObject.emit("keydown", { key: "Escape" });
    assert.equal(fileTrigger.getAttribute("aria-expanded"), "false");

    fileTrigger.emit("click");
    fixture.documentObject.emit("pointerdown", { target: new FakeDomHtmlElement("aside") });
    assert.equal(fileTrigger.getAttribute("aria-expanded"), "false");

    fixture.documentObject.emit("keydown", {
      key: "r", ctrlKey: true, target: new FakeDomHtmlElement("div"),
    });
    fixture.documentObject.emit("keydown", {
      key: "o", metaKey: true, target: new FakeDomHtmlElement("div"),
    });
    fixture.documentObject.emit("keydown", {
      key: "o", ctrlKey: true, altKey: true, target: new FakeDomHtmlElement("div"),
    });
    fixture.documentObject.emit("keydown", {
      key: "o",
      ctrlKey: true,
      defaultPrevented: true,
      target: new FakeDomHtmlElement("div"),
    });
    assert.deepEqual([refreshCount, centerOpenCount], [1, 1]);

    const escapeTrigger = menuHost.querySelector('[data-shell-menu-trigger="help"]');
    escapeTrigger.emit("click");
    let secondaryEscapeCount = 0;
    fixture.documentObject.addEventListener("keydown", (event) => {
      if (event.key === "Escape") secondaryEscapeCount += 1;
    });
    const escape = fixture.documentObject.emit("keydown", { key: "Escape" });
    assert.equal(escape.immediatePropagationStopped, true);
    assert.equal(secondaryEscapeCount, 0);

    assert.equal(menu.close(), false);
    assert.equal(manager.activate("open", "crawl"), false);
    menu.destroy();
    menu.destroy();
    menu = null;
    manager.destroy();
    assert.equal(manager.activate("focus", "personalization"), false);
    manager = null;
  } finally {
    menu?.destroy();
    manager?.destroy();
    fixture.restore();
  }
});

test("window manager 对 async beforeHide 去重并淘汰 stale request", async () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const calls = [];
  const actions = createManagerActions(store, calls);
  const pending = [];
  let beforeHideCount = 0;
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
      onBeforeHide() {
        beforeHideCount += 1;
        return new Promise((resolve) => pending.push(resolve));
      },
    });
    const element = windowElementFor(fixture.windowLayer, "crawl");
    const minimize = element.querySelector("[data-window-minimize]");
    minimize.emit("click");
    minimize.emit("click");
    assert.equal(beforeHideCount, 1);
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "normal");
    pending.shift()(true);
    await flushPromises();
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "minimized");
    assert.equal(calls.filter(([name]) => name === "minimize").length, 1);

    actions.restoreWindow("crawl");
    const close = element.querySelector("[data-window-close]");
    close.emit("click");
    assert.equal(beforeHideCount, 2);
    actions.closeWindow("crawl");
    pending.shift()(true);
    await flushPromises();
    assert.equal(calls.filter(([name]) => name === "close").length, 1);
    assert.deepEqual(selectors.windowStack(store.getState()), []);
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window manager 桌面 resize 取消交互且 normal rect 只异步修复一次", async () => {
  const fixture = installWindowManagerDomFixture();
  const originalRect = windowRect({ x: 5_000, y: 5_000 });
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl", "normal", originalRect)] }),
    reportError: () => {},
  });
  const calls = [];
  const actions = createManagerActions(store, calls);
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
    });
    await flushPromises();
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, {
      x: 1168, y: 320, w: 720, h: 480,
    });
    assert.equal(calls.filter(([name]) => name === "move").length, 1);

    const element = windowElementFor(fixture.windowLayer, "crawl");
    const titlebar = element.querySelector("[data-window-titlebar]");
    titlebar.emit("pointerdown", { pointerId: 21, clientX: 100, clientY: 100 });
    titlebar.emit("pointermove", { pointerId: 21, clientX: 140, clientY: 120 });
    const beforeResize = { ...selectors.windowStack(store.getState())[0].rect };
    fixture.windowObject.emit("resize");
    assert.equal(element.hasAttribute("data-window-interacting"), false);
    assert.equal(calls.filter(([name]) => name === "move").length, 1);
    assert.deepEqual(selectors.windowStack(store.getState())[0].rect, beforeResize);
    assert.equal(element.hasAttribute("data-maximized"), false);
    assert.deepEqual(manager.getSnapshot(), {
      appId: "crawl",
      visibility: "open",
      maximized: false,
      preferredWindowState: "normal",
    });
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window close 后固定应用聚焦 Dock，动态应用回退应用中心", () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({ windows: [
      windowRecord("crawl"),
      windowRecord("proxy"),
    ] }),
    reportError: () => {},
  });
  const actions = createManagerActions(store);
  let manager = null;
  const focusResults = [];
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions,
      onCloseFocus(app) {
        const appFocused = manager.focusDockButton(app.id);
        const fallbackFocused = appFocused ? false : manager.focusDockButton(null);
        focusResults.push([app.id, appFocused, fallbackFocused]);
      },
    });
    windowElementFor(fixture.windowLayer, "proxy")
      .querySelector("[data-window-close]").emit("click");
    assert.deepEqual(focusResults.at(-1), ["proxy", false, true]);
    assert.equal(
      fixture.documentObject.activeElement?.dataset?.dockItem,
      "application-center",
    );

    windowElementFor(fixture.windowLayer, "crawl")
      .querySelector("[data-window-close]").emit("click");
    assert.deepEqual(focusResults.at(-1), ["crawl", true, false]);
    assert.equal(fixture.documentObject.activeElement?.dataset?.dockItem, "app:crawl");
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window manager 最小化在应用停用后异步聚焦可见 Dock 目标", async () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("vault")] }),
    reportError: () => {},
  });
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions: createManagerActions(store),
      onVisibilityChange(visible) {
        if (!visible) windowElementFor(fixture.windowLayer, "vault")?.querySelector("[data-window-body]")?.focus();
      },
    });
    windowElementFor(fixture.windowLayer, "vault")
      .querySelector("[data-window-minimize]").emit("click");
    await flushPromises();
    assert.equal(fixture.documentObject.activeElement?.dataset?.dockItem, "app:vault");
  } finally {
    manager?.destroy();
    fixture.restore();
  }
});

test("window manager 任务栏激活执行最小化恢复，destroy 生命周期错误隔离且幂等", () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const calls = [];
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (message) => errors.push(message);
  let manager = null;
  try {
    manager = createWindowManager({
      windowLayer: fixture.windowLayer,
      windowTemplate: fixture.windowTemplate,
      taskList: fixture.taskList,
      store,
      actions: createManagerActions(store, calls),
      onVisibilityChange() {
        throw new Error("private lifecycle detail");
      },
      onUnmount() {
        throw new Error("private unmount detail");
      },
    });
    const findButton = (node) => {
      for (const child of node.children) {
        if (child.dataset?.dockItem === "app:crawl") return child;
        const nested = findButton(child);
        if (nested) return nested;
      }
      return null;
    };
    let taskButton = findButton(fixture.taskList);
    assert(taskButton instanceof HTMLButtonElement);
    taskButton.setAttribute("data-dock-item", "app:crawl");
    fixture.taskList.emit("click", { target: taskButton });
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "minimized");
    taskButton = findButton(fixture.taskList);
    taskButton.setAttribute("data-dock-item", "app:crawl");
    fixture.taskList.emit("click", { target: taskButton });
    assert.equal(selectors.windowStack(store.getState())[0].windowState, "normal");
    assert.equal(selectors.focusedAppId(store.getState()), "crawl");
    manager.destroy();
    manager.destroy();
    assert.equal(fixture.windowLayer.children.length, 0);
    assert.equal(fixture.taskList.children.length, 0);
    assert.deepEqual(errors, [
      "ImageWeave 应用生命周期执行失败",
      "ImageWeave 应用生命周期执行失败",
      "ImageWeave 应用生命周期执行失败",
      "ImageWeave 应用生命周期执行失败",
      "ImageWeave 应用卸载失败",
    ]);
    assert.equal(errors.some((message) => message.includes("private")), false);
  } finally {
    manager?.destroy();
    console.error = originalConsoleError;
    fixture.restore();
  }
});

test("window manager mount 失败会清理 DOM、任务栏和宿主监听", () => {
  const fixture = installWindowManagerDomFixture();
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  assert.throws(() => createWindowManager({
    windowLayer: fixture.windowLayer,
    windowTemplate: fixture.windowTemplate,
    taskList: fixture.taskList,
    store,
    actions: createManagerActions(store),
    onMount() {
      throw new Error("mount failed");
    },
  }), /mount failed/);
  assert.equal(fixture.windowLayer.children.length, 0);
  assert.equal(fixture.taskList.children.length, 0);
  assert.equal(fixture.mobileViewport.listeners.size, 0);
  assert.equal(fixture.windowObject.listeners.get("resize")?.size || 0, 0);
  fixture.restore();
});

test("布局防抖在交互期间不写 storage，destroy 会落定最终 rect", () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const timers = new FakeTimers();
  const layouts = [];
  const actions = createShellActions({
    store,
    router: { navigate() {} },
    storage: {
      writeCurrentApp() {},
      writeWindowLayout(windows) {
        layouts.push(windows.map((record) => ({ ...record, rect: { ...record.rect } })));
      },
      writeActiveBatchId() {},
      clearActiveBatchId() {},
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  actions.beginWindowInteraction();
  const finalRect = windowRect({ x: 144, y: 96, w: 800, h: 520 });
  actions.moveWindow("crawl", finalRect);
  assert.equal(layouts.length, 0);
  assert.equal(timers.jobs.size, 0);
  actions.endWindowInteraction();
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);
  actions.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0][0].rect, finalRect);
});

test("布局防抖从最后一次变化重新计算完整 300ms 静默期", () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const timers = new FakeTimers();
  const layouts = [];
  const actions = createShellActions({
    store,
    router: { navigate() {} },
    storage: {
      writeCurrentApp() {},
      writeWindowLayout(windows) {
        layouts.push(windows.map((record) => ({ ...record, rect: { ...record.rect } })));
      },
      writeActiveBatchId() {},
      clearActiveBatchId() {},
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  const firstRect = windowRect({ x: 80, y: 64, w: 760, h: 500 });
  const latestRect = windowRect({ x: 112, y: 88, w: 784, h: 512 });
  assert.equal(actions.moveWindow("crawl", firstRect), true);
  const firstJobId = timers.sequence;
  assert.equal(timers.jobs.get(firstJobId).due, WINDOW_LAYOUT_DEBOUNCE_MS);

  timers.advanceBy(250);
  assert.equal(layouts.length, 0);
  assert.equal(actions.moveWindow("crawl", latestRect), true);
  const latestJobId = timers.sequence;
  assert.notEqual(latestJobId, firstJobId);
  assert.deepEqual(timers.cleared, [firstJobId], "第二次变化必须清除旧 job");
  assert.equal(timers.jobs.has(firstJobId), false);
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);

  timers.advanceBy(WINDOW_LAYOUT_DEBOUNCE_MS - 250);
  assert.equal(timers.now, WINDOW_LAYOUT_DEBOUNCE_MS);
  assert.equal(layouts.length, 0, "旧 deadline 不得写入 storage");
  assert.deepEqual(timers.delays(), [250]);
  timers.advanceBy(249);
  assert.equal(layouts.length, 0);
  timers.advanceBy(1);
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0][0].rect, latestRect);
  assert.equal(timers.jobs.size, 0);

  timers.advanceBy(WINDOW_LAYOUT_DEBOUNCE_MS);
  assert.equal(layouts.length, 1, "最终只允许写入一次最新布局");
  actions.destroy();
  assert.equal(layouts.length, 1);
});

test("selectors.windowView 保持旧形状且 hash 只包含单个聚焦应用", () => {
  const store = createStore({ reportError: () => {} });
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: null,
    windowState: "normal",
    visibility: "closed",
  });
  store.dispatch(actionCreators.windowOpened("review"));
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: "review",
    windowState: "maximized",
    visibility: "open",
  });
  assert.deepEqual(Object.keys(selectors.windowView(store.getState())), [
    "appId", "windowState", "visibility",
  ]);
  assert.equal(selectors.windowStack(store.getState()), store.getState().ui.windows);
  assert.equal(hashForRoute(resolveNavigationTarget("review")), "#/review");
  assert.equal(hashForRoute(resolveNavigationTarget("review")).includes("?"), false);
  assert.equal(parseHashRoute("#/review?windows=crawl"), null);
});

test("每个已开窗口产生一个使用中文 label 的任务栏按钮描述", () => {
  const stack = [
    windowRecord("crawl"),
    windowRecord("tasks"),
    windowRecord("review", "maximized"),
  ];
  const descriptions = describeTaskbarWindows(stack, "review");
  assert.equal(descriptions.length, stack.length);
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.label, item.title]),
    stack.map((record) => {
      const app = getApplicationById(record.appId);
      return [record.appId, app.label, app.windowTitle];
    }),
  );
  assert.equal(descriptions[0].label, "图片采集");
  assert.equal(descriptions[0].title, "图片采集");
});

test("聚焦窗口任务栏按钮 aria-pressed 为 true 且其他为 false", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl"),
    windowRecord("review", "maximized"),
    windowRecord("tasks"),
  ], "tasks");
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.ariaPressed]),
    [["crawl", "false"], ["review", "false"], ["tasks", "true"]],
  );
});

test("minimized 窗口任务栏按钮描述带最小化标记", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl", "minimized"),
    windowRecord("tasks"),
  ], "tasks");
  assert.equal(descriptions[0].minimized, true);
  assert.equal(descriptions[0].ariaPressed, "false");
  assert.equal(descriptions[1].minimized, false);
});

test("超过六个窗口时严格前六个可见且其余进入任务栏溢出列表", () => {
  const readyIds = applications
    .filter((app) => app.availability === "ready")
    .map((app) => app.id);
  const model = deriveTaskbarWindowModel(
    readyIds.map((appId) => windowRecord(appId)),
    readyIds.at(-1),
  );
  assert.equal(_TASKBAR_VISIBLE_LIMIT, 6);
  assert.equal(model.buttons.length, readyIds.length);
  assert.deepEqual(model.visible.map((item) => item.appId), readyIds.slice(0, 6));
  assert.deepEqual(model.overflow.map((item) => item.appId), readyIds.slice(6));
});

test("任务栏按钮意图区分已聚焦最小化与非聚焦恢复后聚焦", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl"),
    windowRecord("tasks", "minimized"),
    windowRecord("review", "maximized"),
  ], "review");
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.activation]),
    [["crawl", "focus"], ["tasks", "restore"], ["review", "minimize"]],
  );
});

test("任务栏按钮真实激活路径只执行 descriptor 对应的生产回调", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("crawl"),
        windowRecord("tasks", "minimized"),
        windowRecord("review", "maximized"),
      ],
    }),
    reportError: () => {},
  });
  const stack = selectors.windowStack(store.getState());
  const descriptions = describeTaskbarWindows(
    stack,
    selectors.focusedAppId(store.getState()),
  );
  const byId = new Map(descriptions.map((item) => [item.appId, item]));
  const available = new Set(stack.map((record) => record.appId));
  const calls = [];
  const callbacks = {
    canActivate: (appId) => available.has(appId),
    minimize: (appId) => calls.push(["minimize-request", appId]),
    focus: (appId) => calls.push(["focus", appId]),
    restore: (appId) => {
      calls.push(["restore", appId]);
      store.dispatch(actionCreators.windowOpened(appId));
    },
  };

  assert.equal(activateTaskbarWindow(byId.get("review"), callbacks), true);
  assert.deepEqual(calls, [["minimize-request", "review"]]);

  calls.length = 0;
  assert.equal(activateTaskbarWindow(byId.get("crawl"), callbacks), true);
  assert.deepEqual(calls, [["focus", "crawl"]]);

  calls.length = 0;
  assert.equal(activateTaskbarWindow(byId.get("tasks"), callbacks), true);
  assert.deepEqual(calls, [["restore", "tasks"]]);
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((record) => [record.appId, record.windowState]),
    [["crawl", "normal"], ["review", "maximized"], ["tasks", "normal"]],
  );
  assert.equal(selectors.focusedAppId(store.getState()), "tasks");

  calls.length = 0;
  assert.equal(activateTaskbarWindow(null, callbacks), false);
  assert.equal(activateTaskbarWindow({ appId: "unknown", activation: "focus" }, callbacks), false);
  available.delete("crawl");
  assert.equal(activateTaskbarWindow(byId.get("crawl"), callbacks), false);
  assert.deepEqual(calls, []);
});

test("菜单打开应用中心先关闭 menu 并把可见 trigger 作为返回焦点", () => {
  const fixture = installWindowManagerDomFixture();
  const root = new FakeDomHtmlElement("header");
  const appName = new FakeDomHtmlElement("span");
  appName.setAttribute("data-menu-current-app", "");
  const menuHost = new FakeDomHtmlElement("nav");
  menuHost.setAttribute("data-menu-items", "");
  root.append(appName, menuHost);
  fixture.documentObject.documentElement.append(root);
  const centerHost = new FakeDomHtmlElement("div");
  fixture.documentObject.documentElement.append(centerHost);
  const store = createStore({ reportError: () => {} });
  let center = null;
  let menu = null;
  try {
    center = createApplicationCenter({
      host: centerHost,
      definitions: applications,
      onLaunch() {},
      documentObject: fixture.documentObject,
    });
    menu = createMenuBar({
      root,
      store,
      selectors,
      actions: { navigateToApp() {} },
      onWindowCommand() {},
      onOpenApplicationCenter: (trigger) => center.open(trigger),
      onRefreshSummary() {},
      documentObject: fixture.documentObject,
      windowObject: fixture.windowObject,
    });
    const fileTrigger = menuHost.querySelector('[data-shell-menu-trigger="file"]');
    fileTrigger.emit("click");
    menuHost.querySelector('[data-menu-command="open-center"]').emit("click");
    assert.equal(fileTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(center.isOpen(), true);
    fixture.documentObject.emit("keydown", { key: "Escape" });
    assert.equal(fixture.documentObject.activeElement, fileTrigger);
  } finally {
    menu?.destroy();
    center?.destroy();
    fixture.restore();
  }
});

test("应用中心 Tab/Shift+Tab 环绕且 Escape 只关闭顶层并恢复触发器", () => {
  const fixture = installWindowManagerDomFixture();
  const host = new FakeDomHtmlElement("div");
  fixture.documentObject.documentElement.append(host);
  const trigger = new FakeDomHtmlButtonElement("button");
  fixture.documentObject.documentElement.append(trigger);
  let center = null;
  try {
    center = createApplicationCenter({
      host,
      definitions: applications,
      onLaunch() {},
      documentObject: fixture.documentObject,
    });
    assert.equal(center.open(trigger), true);
    const panel = host.querySelector("[data-application-center-panel]");
    const focusable = panel.querySelectorAll("button:not([disabled])");
    const launchTarget = panel.querySelector("[data-application-center-app]:not([disabled])");
    assert.equal(focusable.length > 1, true);
    assert.equal(fixture.documentObject.activeElement, launchTarget);

    const first = focusable[0];
    const last = focusable.at(-1);
    first.focus();
    fixture.documentObject.emit("keydown", {
      key: "Tab", shiftKey: true, target: first,
    });
    assert.equal(fixture.documentObject.activeElement, last);
    fixture.documentObject.emit("keydown", {
      key: "Tab", shiftKey: false, target: last,
    });
    assert.equal(fixture.documentObject.activeElement, first);

    let secondaryEscapeCount = 0;
    fixture.documentObject.addEventListener("keydown", (event) => {
      if (event.key === "Escape") secondaryEscapeCount += 1;
    });
    const escape = fixture.documentObject.emit("keydown", { key: "Escape" });
    assert.equal(escape.immediatePropagationStopped, true);
    assert.equal(secondaryEscapeCount, 0);
    assert.equal(center.isOpen(), false);
    assert.equal(fixture.documentObject.activeElement, trigger);
    assert.equal(center.close(), false);
  } finally {
    center?.destroy();
    fixture.restore();
  }
});

test("Dock 应用中心动作显式传递实际 launcher button", () => {
  const fixture = installWindowManagerDomFixture();
  const container = new FakeDomHtmlElement("div");
  fixture.documentObject.documentElement.append(container);
  let dock = null;
  let receivedTrigger = null;
  try {
    dock = createDock({
      container,
      onActivate() {},
      onOpenApplicationCenter(trigger) { receivedTrigger = trigger; },
      documentObject: fixture.documentObject,
    });
    dock.render([], null);
    const launcher = container.querySelector('[data-dock-item="application-center"]');
    launcher.emit("click");
    assert.equal(receivedTrigger, launcher);
  } finally {
    dock?.destroy();
    fixture.restore();
  }
});

test("Dock overflow Escape 只关闭自己且隐藏项 focusButton 回退可见 trigger", () => {
  const fixture = installWindowManagerDomFixture();
  const container = new FakeDomHtmlElement("div");
  fixture.documentObject.documentElement.append(container);
  let dock = null;
  try {
    dock = createDock({
      container,
      onActivate() {},
      onOpenApplicationCenter() {},
      documentObject: fixture.documentObject,
    });
    dock.render([windowRecord("proxy")], "proxy", { visibleLimit: 5 });
    const overflowTrigger = container.querySelector("[data-dock-overflow-button]");
    overflowTrigger.emit("click");
    assert.equal(overflowTrigger.getAttribute("aria-expanded"), "true");
    assert.equal(dock.focusButton("proxy"), true);
    assert.equal(fixture.documentObject.activeElement, overflowTrigger);
    let secondaryEscapeCount = 0;
    fixture.documentObject.addEventListener("keydown", (event) => {
      if (event.key === "Escape") secondaryEscapeCount += 1;
    });
    const escape = fixture.documentObject.emit("keydown", { key: "Escape" });
    assert.equal(escape.immediatePropagationStopped, true);
    assert.equal(secondaryEscapeCount, 0);
    assert.equal(overflowTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.documentObject.activeElement, overflowTrigger);
  } finally {
    dock?.destroy();
    fixture.restore();
  }
});

test("Dock 纯模型覆盖固定动态顺序、四状态、overflow 与动作委托", () => {
  const stack = [
    windowRecord("tasks"),
    windowRecord("proxy", "minimized"),
    windowRecord("vault"),
    windowRecord("review", "maximized"),
  ];
  const model = deriveDockModel(stack, "review", { visibleLimit: 6 });
  assert.deepEqual(model.items.map((item) => [item.key, item.state, item.activation]), [
    ["application-center", "launcher", "open-center"],
    ["app:crawl", "closed", "open"],
    ["app:tasks", "background", "focus"],
    ["app:gallery", "closed", "open"],
    ["app:review", "focused", "minimize"],
    ["app:proxy", "minimized", "restore"],
    ["app:vault", "background", "focus"],
  ]);
  assert.equal(model.items.every((item) => item.ariaLabel.length > 0), true);
  assert.deepEqual(model.visible.map((item) => item.key), [
    "application-center", "app:crawl", "app:tasks", "app:gallery", "app:review", "app:proxy",
  ]);
  assert.deepEqual(model.overflow.map((item) => item.key), ["app:vault"]);
  const calls = [];
  const handlers = {
    openApplicationCenter: () => calls.push(["center"]),
    open: (appId) => calls.push(["open", appId]),
    minimize: (appId) => calls.push(["minimize", appId]),
    focus: (appId) => calls.push(["focus", appId]),
    restore: (appId) => calls.push(["restore", appId]),
  };
  for (const item of model.items.slice(0, 6)) assert.equal(activateDockItem(item, handlers), true);
  assert.deepEqual(calls, [
    ["center"], ["open", "crawl"], ["focus", "tasks"], ["open", "gallery"],
    ["minimize", "review"], ["restore", "proxy"],
  ]);
  assert.equal(activateDockItem(null, handlers), false);
  assert.equal(activateDockItem({ appId: "unknown", activation: "focus" }, handlers), false);
  assert.throws(() => deriveDockModel(stack, "review", { visibleLimit: 0 }), TypeError);
  assert.throws(() => deriveDockModel([stack[0], stack[0]], "tasks"), TypeError);
});

test("菜单窗口投影和 shell 快捷键过滤保持纯逻辑", () => {
  assert.deepEqual(deriveWindowMenu([
    windowRecord("crawl"),
    windowRecord("tasks", "minimized"),
    windowRecord("review", "maximized"),
  ], "review").map((item) => [item.appId, item.command, item.checked]), [
    ["crawl", "focus", false],
    ["tasks", "restore", false],
    ["review", "minimize", true],
  ]);
  assert.equal(shortcutModifier({ ctrlKey: true, metaKey: false }), true);
  assert.equal(shortcutModifier({ ctrlKey: false, metaKey: true }), true);
  assert.equal(shortcutModifier({ ctrlKey: false, metaKey: false }), false);
  const fixture = installWindowManagerDomFixture();
  try {
    const input = new FakeDomHtmlElement("input");
    const button = new FakeDomHtmlButtonElement("button");
    const plain = new FakeDomHtmlElement("div");
    assert.equal(isShellShortcutTarget(input), true);
    assert.equal(isShellShortcutTarget(button), true);
    assert.equal(isShellShortcutTarget(plain), false);
  } finally {
    fixture.restore();
  }
});

test("window pure policy 独立投影焦点/z 序、交互矩形与兼容快照", () => {
  assert.equal(derivePureWindowViews, deriveWindowViews);
  const stack = [
    windowRecord("crawl", "normal", windowRect({ x: 100, y: 80, w: 500, h: 300 })),
    windowRecord("tasks", "maximized", windowRect({ x: 40, y: 30, w: 640, h: 420 })),
  ];
  const plan = deriveWindowRenderPlan(stack, "tasks", false);
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(plan.map(({ record, view, zIndex }) => [
    record.appId, view.visible, view.maximized, zIndex,
  ]), [
    ["crawl", true, false, 0],
    ["tasks", true, true, 1],
  ]);
  assert.equal(plan[0].record, stack[0]);
  assert.equal("zIndex" in stack[0], false);

  const viewport = { width: 1000, height: 700 };
  const options = { minW: 360, minH: 240, taskbarHeight: 40 };
  const drag = nextPointerInteractionRect({
    type: "drag",
    resizeDirection: "",
    startClientX: 10,
    startClientY: 20,
    startRect: stack[0].rect,
  }, { clientX: 35, clientY: 50 }, viewport, options);
  assert.deepEqual(drag, { x: 125, y: 110, w: 500, h: 300 });
  const resize = nextPointerInteractionRect({
    type: "resize",
    resizeDirection: "right",
    startClientX: 10,
    startClientY: 20,
    startRect: stack[0].rect,
  }, { clientX: 42, clientY: 99 }, viewport, options);
  assert.deepEqual(resize, { x: 100, y: 80, w: 532, h: 300 });
  assert.deepEqual(
    nextKeyboardResizeRect(stack[0], "bottom", "ArrowDown", viewport, options),
    { x: 100, y: 80, w: 500, h: 316 },
  );
  assert.equal(nextKeyboardResizeRect(stack[0], "bottom", "ArrowRight", viewport, options), null);
  assert.equal(sameWindowRect(stack[0].rect, { ...stack[0].rect }), true);
  assert.deepEqual(deriveWindowManagerSnapshot(
    { appId: "tasks", visibility: "open", windowState: "maximized" },
    stack[1],
    false,
  ), {
    appId: "tasks",
    visibility: "open",
    maximized: true,
    preferredWindowState: "maximized",
  });
});

test("移动断点窗口视图全部最大化且仅聚焦窗口可见", () => {
  const views = deriveWindowViews([
    windowRecord("crawl"),
    windowRecord("tasks"),
    windowRecord("review", "minimized"),
  ], "tasks", true);
  assert.equal(views.every((view) => view.maximized), true);
  assert.deepEqual(
    views.map((view) => [view.appId, view.visible, view.open, view.minimized]),
    [
      ["crawl", false, true, false],
      ["tasks", true, true, false],
      ["review", false, false, true],
    ],
  );
});

test("退出移动断点后窗口 rect 原样恢复且源窗口栈不被改写", () => {
  const stack = [
    windowRecord("crawl", "normal", windowRect({ x: 91, y: 73, w: 641, h: 421 })),
    windowRecord("tasks", "normal", windowRect({ x: -220, y: 118, w: 812, h: 516 })),
  ];
  const original = structuredClone(stack);
  const mobileViews = deriveWindowViews(stack, "tasks", true);
  const restoredViews = deriveWindowViews(stack, "tasks", false);
  assert.equal(mobileViews.every((view) => view.maximized), true);
  assert.deepEqual(restoredViews.map((view) => view.rect), original.map((item) => item.rect));
  assert.deepEqual(stack, original);
});

test("preview 应用 hash 与导航目标可启动，畸形路由回桌面", () => {
  for (const target of ["gallery", "schedule", "export"]) {
    const app = getApplicationById(target);
    assert.equal(app?.availability, "preview", target);
    assert.equal(parseHashRoute(`#${app.route}`), app.route);
    assert.equal(resolveNavigationTarget(target), app.route);
    assert.equal(resolveNavigationTarget(app.route), app.route);
    assert.equal(hashForRoute(app.route), `#${app.route}`);
  }
  assert.equal(parseHashRoute("#/review"), "/review");
  assert.equal(parseHashRoute("#/review?windows=crawl"), null);
});

test("旧 workspace 只迁移严格位置偏好且启动保持空窗口栈", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  local.values.set(STORAGE_KEYS.windowLayout, JSON.stringify({ windows: [
    windowRecord("crawl", "normal", windowRect({ x: 12, y: 18 })),
    windowRecord("review", "maximized", windowRect({ x: 5_000, y: -5_000, w: 800, h: 560 })),
    windowRecord("gallery", "normal", windowRect()),
  ] }));
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  const placements = storage.readWindowPlacements({ width: 1024, height: 600 });
  assert.deepEqual(placements, [
    { appId: "crawl", rect: { x: 12, y: 18, w: 720, h: 480 }, maximized: false },
    { appId: "review", rect: { x: 992, y: -528, w: 800, h: 560 }, maximized: true },
    { appId: "gallery", rect: { x: 48, y: 36, w: 720, h: 480 }, maximized: false },
  ]);
  assert.equal(local.values.has(STORAGE_KEYS.windowLayout), false);
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.windowPlacements)), { placements });
  assert.deepEqual(createInitialState({ windows: [] }).ui.windows, []);
});

test("损坏的旧 workspace 静默清理且不会打开默认应用", () => {
  for (const serialized of [
    "{broken-json",
    JSON.stringify([]),
    JSON.stringify({ windows: {} }),
    JSON.stringify({ windows: [windowRecord("crawl", "open")] }),
    JSON.stringify({ windows: [windowRecord("crawl"), windowRecord("crawl")] }),
    JSON.stringify({ windows: [{ ...windowRecord("crawl"), zIndex: 99 }] }),
  ]) {
    const local = new MemoryStorage();
    local.values.set(STORAGE_KEYS.windowLayout, serialized);
    const storage = createStorageService({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
    });
    assert.doesNotThrow(() => storage.readWindowPlacements({ width: 800, height: 600 }));
    assert.deepEqual(storage.readWindowPlacements({ width: 800, height: 600 }), []);
    assert.equal(local.values.has(STORAGE_KEYS.windowLayout), false);
  }
});

test("DESKTOP.CPL 以 ready 应用注册且不改变既有应用相对顺序", () => {
  const personalization = getApplicationById("personalization");
  assert(personalization);
  assert.deepEqual({
    id: personalization.id,
    label: personalization.label,
    route: personalization.route,
    windowTitle: personalization.windowTitle,
    availability: personalization.availability,
    defaultWindowState: personalization.defaultWindowState,
  }, {
    id: "personalization",
    label: "外观设置",
    route: "/personalization",
    windowTitle: "外观设置",
    availability: "ready",
    defaultWindowState: "normal",
  });
  assert.deepEqual(
    applications.filter((app) => app.id !== "personalization").map((app) => app.id),
    [
      "crawl", "tasks", "proxy", "vault", "review", "policy", "diagnostics",
      "gallery", "schedule", "export",
    ],
  );
  assert.equal(
    applications.indexOf(personalization),
    applications.findIndex((app) => app.id === "diagnostics") + 1,
  );
  for (const hook of [
    "mount", "activate", "beforeLeave", "beforeWindowHide", "deactivate", "unmount",
  ]) {
    assert.equal(typeof personalizationApplication[hook], "function", hook);
  }
});

test("轮询按资源键去重且活动请求不重叠，停止时中止", async () => {
  const { manager, timers } = createFakePolling();
  let calls = 0;
  let activeSignal;
  let release;
  const handle = manager.start({
    key: "resource.one",
    scope: "app:test",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    task(signal) {
      calls += 1;
      activeSignal = signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const duplicate = manager.start({
    key: "resource.one",
    scope: "other",
    intervalMs: 2_000,
    immediate: true,
    critical: false,
    task: async () => { calls += 100; },
  });
  assert.equal(duplicate, handle);
  assert.equal(timers.jobs.size, 1);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 1);
  const firstTrigger = manager.trigger("resource.one");
  const secondTrigger = manager.trigger("resource.one");
  assert.equal(firstTrigger, secondTrigger);
  assert.equal(calls, 1);
  handle.stop();
  assert.equal(activeSignal.aborted, true);
  release();
  await flushPromises();
  assert.equal(manager.getSummary().length, 0);
  manager.destroy();
});

test("轮询失败保持固定间隔，诊断摘要不包含原始异常", async () => {
  const { manager, timers, errors } = createFakePolling();
  manager.start({
    key: "resource.failure",
    scope: "shell",
    intervalMs: 2_000,
    immediate: true,
    critical: false,
    task: async () => {
      const error = new Error("secret response body");
      error.code = "fixture_error";
      error.status = 503;
      throw error;
    },
  });
  timers.runNext();
  await flushPromises();
  assert.deepEqual(timers.delays(), [2_000]);
  assert.deepEqual(errors, [{
    key: "resource.failure",
    scope: "shell",
    code: "fixture_error",
    status: 503,
  }]);
  const diagnostic = manager.getSummary()[0];
  assert.equal(diagnostic.errorCode, "fixture_error");
  assert.equal(JSON.stringify(diagnostic).includes("secret response body"), false);
  manager.destroy();
});

test("页面隐藏暂停并中止非关键轮询，恢复后只安排一次立即执行", async () => {
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({ visibility });
  let calls = 0;
  let aborted = false;
  manager.start({
    key: "resource.visibility",
    scope: "shell",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "immediate",
    task(signal) {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  timers.runNext();
  await flushPromises();
  visibility.set("hidden");
  assert.equal(aborted, true);
  assert.equal(timers.jobs.size, 0);
  await flushPromises();
  visibility.set("visible");
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 2);
  manager.stopScope("shell");
  assert.equal(manager.getSummary().length, 0);
  manager.destroy();
});

test("关键轮询隐藏时继续，destroy 清理定时器和可见性监听", async () => {
  const visibility = new FakeVisibility("hidden");
  const { manager, timers } = createFakePolling({ visibility });
  let calls = 0;
  manager.start({
    key: "resource.critical",
    scope: "global",
    intervalMs: 500,
    immediate: true,
    critical: true,
    task: async () => { calls += 1; },
  });
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [500]);
  manager.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

test("轮询倍率与既有基础 interval 常量保持固定", () => {
  assert.equal(UNFOCUSED_POLL_MULTIPLIER, 4);
  assert.equal(TASK_POLL_INTERVAL_MS, 1_500);
  assert.equal(REVIEW_POLL_INTERVAL_MS, 1_500);
  assert.equal(DIAGNOSTICS_POLL_INTERVAL_MS, 20_000);
  assert.equal(SHELL_POLL_INTERVAL_MS, 30_000);
  assert.equal(SHELL_POLL_SCOPE, "shell");
});

test("store 聚焦适配器只投影窗口 scope 与 open/minimized/closed 状态", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("crawl", "normal"),
        windowRecord("tasks", "minimized"),
      ],
    }),
    reportError: () => {},
  });
  const source = createStorePollingFocusSource(store);

  assert.equal(source.getFocusedScope(), "app:crawl");
  assert.equal(source.getScopeState("app:crawl"), POLLING_SCOPE_STATES.OPEN);
  assert.equal(source.getScopeState("app:tasks"), POLLING_SCOPE_STATES.MINIMIZED);
  assert.equal(source.getScopeState("app:review"), POLLING_SCOPE_STATES.CLOSED);
  assert.equal(source.getScopeState("shell"), POLLING_SCOPE_STATES.UNMANAGED);
  const initial = source.getSnapshot();
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.windows), true);
  assert.equal(Object.isFrozen(initial.windows[0]), true);
  assert.deepEqual(initial, {
    focusedScope: "app:crawl",
    windows: [
      { scope: "app:crawl", state: "open" },
      { scope: "app:tasks", state: "minimized" },
    ],
  });
  assert.equal(JSON.stringify(initial).includes("rect"), false);

  const notifications = [];
  const unsubscribe = source.subscribe((snapshot) => notifications.push(snapshot));
  store.dispatch(actionCreators.shellSummaryUpdated(shellSnapshot()));
  assert.equal(notifications.length, 0, "无关业务状态不得触发聚焦重排");
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(notifications.length, 1);
  assert.equal(notifications.at(-1).focusedScope, "app:review");
  store.dispatch(actionCreators.windowStateChanged("review", "minimized"));
  assert.equal(notifications.length, 2);
  assert.equal(notifications.at(-1).focusedScope, "app:crawl");
  store.dispatch(actionCreators.windowClosed("review"));
  assert.equal(notifications.length, 3);
  assert.equal(source.getScopeState("app:review"), POLLING_SCOPE_STATES.CLOSED);
  unsubscribe();
  store.dispatch(actionCreators.windowOpened("policy"));
  assert.equal(notifications.length, 3);
});

test("未提供 focusSource 时 app scope 保持原速向后兼容", () => {
  const { manager, timers } = createFakePolling();
  manager.start({
    key: "compat.application",
    scope: "app:tasks",
    intervalMs: 1_200,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  assert.deepEqual(timers.delays(), [1_200]);
  assert.equal(manager.getSummary()[0].effectiveIntervalMs, 1_200);
  manager.destroy();
});

test("聚焦窗口原速、opened-unfocused 四倍且 shell 30 秒不被重排", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("review"), windowRecord("tasks")],
    }),
    reportError: () => {},
  });
  const focusSource = createStorePollingFocusSource(store);
  const { manager, timers } = createFakePolling({ focusSource });
  const calls = { tasks: 0, review: 0, shell: 0 };
  for (const [key, scope, intervalMs] of [
    ["rate.tasks", "app:tasks", TASK_POLL_INTERVAL_MS],
    ["rate.review", "app:review", REVIEW_POLL_INTERVAL_MS],
    ["rate.shell", SHELL_POLL_SCOPE, SHELL_POLL_INTERVAL_MS],
  ]) {
    manager.start({
      key,
      scope,
      intervalMs,
      immediate: false,
      critical: false,
      resume: "immediate",
      task: async () => { calls[key.slice(5)] += 1; },
    });
  }

  const initial = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(initial.get("rate.tasks").effectiveIntervalMs, 1_500);
  assert.equal(initial.get("rate.review").effectiveIntervalMs, 6_000);
  assert.equal(initial.get("rate.shell").effectiveIntervalMs, 30_000);
  assert.deepEqual(timers.delays(), [1_500, 6_000, 30_000]);

  timers.advanceBy(1_000);
  const shellDeadline = initial.get("rate.shell").nextRunAt;
  store.dispatch(actionCreators.windowFocused("review"));
  const switched = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(switched.get("rate.tasks").effectiveIntervalMs, 6_000);
  assert.equal(switched.get("rate.review").effectiveIntervalMs, 1_500);
  assert.equal(switched.get("rate.shell").effectiveIntervalMs, 30_000);
  assert.equal(switched.get("rate.shell").nextRunAt, shellDeadline);
  assert.deepEqual(timers.delays(), [0, 6_000, 29_000]);

  timers.runNext();
  await flushPromises();
  assert.deepEqual(calls, { tasks: 0, review: 1, shell: 0 });
  assert.deepEqual(timers.delays(), [1_500, 6_000, 29_000]);
  manager.destroy();
});

test("minimized 与 closed 窗口挂起既存 entry 并中止活动请求", async () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("tasks")] }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let activeSignal = null;
  let release = null;
  manager.start({
    key: "lifecycle.tasks",
    scope: "app:tasks",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    alwaysFocusRate: true,
    task(signal) {
      activeSignal = signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  timers.runNext();
  await flushPromises();
  assert.equal(activeSignal.aborted, false);

  store.dispatch(actionCreators.windowStateChanged("tasks", "minimized"));
  assert.equal(activeSignal.aborted, true);
  assert.equal(timers.jobs.size, 0);
  assert.equal(manager.getSummary()[0].state, "paused");
  assert.equal(manager.getSummary()[0].effectiveIntervalMs, null);

  manager.start({
    key: "lifecycle.closed",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: false,
    critical: false,
    alwaysFocusRate: true,
    task: async () => {},
  });
  const closed = manager.getSummary().find((entry) => entry.key === "lifecycle.closed");
  assert.equal(closed.state, "paused");
  assert.equal(closed.effectiveIntervalMs, null);
  assert.equal(timers.jobs.size, 0);

  store.dispatch(actionCreators.windowClosed("tasks"));
  release();
  await flushPromises();
  assert.equal(manager.getSummary().every((entry) => entry.state === "paused"), true);
  assert.equal(timers.jobs.size, 0);
  manager.destroy();
});

test("alwaysFocusRate 仅绕过未聚焦降频，页面 hidden 仍优先挂起全部非关键 entry", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("vault"),
        windowRecord("review"),
        windowRecord("tasks"),
      ],
    }),
    reportError: () => {},
  });
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({
    visibility,
    focusSource: createStorePollingFocusSource(store),
  });
  manager.start({
    key: "authorization.vault",
    scope: "app:vault",
    intervalMs: 800,
    immediate: false,
    critical: false,
    alwaysFocusRate: true,
    task: async () => {},
  });
  manager.start({
    key: "authorization.review",
    scope: "app:review",
    intervalMs: 800,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  manager.start({
    key: "authorization.shell",
    scope: SHELL_POLL_SCOPE,
    intervalMs: SHELL_POLL_INTERVAL_MS,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  const visible = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(visible.get("authorization.vault").effectiveIntervalMs, 800);
  assert.equal(visible.get("authorization.vault").alwaysFocusRate, true);
  assert.equal(visible.get("authorization.review").effectiveIntervalMs, 3_200);
  assert.equal(visible.get("authorization.shell").effectiveIntervalMs, 30_000);

  visibility.set("hidden");
  assert.equal(manager.getSummary().every((entry) => entry.state === "paused"), true);
  assert.equal(manager.getSummary().every((entry) => entry.effectiveIntervalMs === null), true);
  assert.equal(timers.jobs.size, 0);
  visibility.set("visible");
  assert.deepEqual(timers.delays(), [0, 0, 0]);
  manager.destroy();
});

test("opened-unfocused 恢复聚焦时 interval 策略等待基础周期", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("review"), windowRecord("tasks")],
    }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let calls = 0;
  manager.start({
    key: "resume.interval",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: false,
    critical: false,
    resume: "interval",
    task: async () => { calls += 1; },
  });
  assert.deepEqual(timers.delays(), [4_000]);
  timers.advanceBy(500);
  store.dispatch(actionCreators.windowFocused("review"));
  assert.deepEqual(timers.delays(), [1_000]);
  timers.advanceBy(999);
  assert.equal(calls, 0);
  timers.advanceBy(1);
  await flushPromises();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [1_000]);
  manager.destroy();
});

test("活动请求切回聚焦保持单飞并分别沿用 immediate 与 interval 恢复策略", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("tasks"),
        windowRecord("review"),
        windowRecord("diagnostics"),
      ],
    }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let immediateCalls = 0;
  let intervalCalls = 0;
  let immediateActive = 0;
  let intervalActive = 0;
  let maxImmediateActive = 0;
  let maxIntervalActive = 0;
  let releaseImmediate;
  let releaseInterval;

  manager.start({
    key: "active.immediate",
    scope: "app:tasks",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "immediate",
    task() {
      immediateCalls += 1;
      immediateActive += 1;
      maxImmediateActive = Math.max(maxImmediateActive, immediateActive);
      if (immediateCalls === 1) {
        return new Promise((resolve) => {
          releaseImmediate = () => {
            immediateActive -= 1;
            resolve();
          };
        });
      }
      immediateActive -= 1;
      return Promise.resolve();
    },
  });
  manager.start({
    key: "active.interval",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "interval",
    task() {
      intervalCalls += 1;
      intervalActive += 1;
      maxIntervalActive = Math.max(maxIntervalActive, intervalActive);
      if (intervalCalls === 1) {
        return new Promise((resolve) => {
          releaseInterval = () => {
            intervalActive -= 1;
            resolve();
          };
        });
      }
      intervalActive -= 1;
      return Promise.resolve();
    },
  });

  timers.advanceBy(0);
  await flushPromises();
  assert.deepEqual([immediateCalls, intervalCalls], [1, 1]);
  store.dispatch(actionCreators.windowFocused("tasks"));
  assert.equal(timers.jobs.size, 0, "活动请求恢复时不得并发创建 timer");
  const firstTrigger = manager.trigger("active.immediate");
  assert.equal(manager.trigger("active.immediate"), firstTrigger);
  assert.equal(immediateCalls, 1);

  releaseImmediate();
  await flushPromises();
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(immediateCalls, 2);
  assert.deepEqual(timers.delays(), [1_000]);

  store.dispatch(actionCreators.windowFocused("review"));
  assert.deepEqual(timers.delays(), [4_000]);
  releaseInterval();
  await flushPromises();
  assert.deepEqual(timers.delays(), [1_000, 4_000]);
  timers.advanceBy(999);
  assert.equal(intervalCalls, 1);
  timers.advanceBy(1);
  await flushPromises();
  assert.equal(intervalCalls, 2);
  assert.equal(maxImmediateActive, 1);
  assert.equal(maxIntervalActive, 1);
  manager.destroy();
});

test("反复切焦 50 次保持每 entry 一个 timer 且不增长状态源监听器", () => {
  const focusSource = new FakeFocusSource({
    focusedScope: "app:tasks",
    scopeStates: {
      "app:tasks": POLLING_SCOPE_STATES.OPEN,
      "app:review": POLLING_SCOPE_STATES.OPEN,
    },
  });
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({ visibility, focusSource });
  for (const [key, scope, intervalMs] of [
    ["cardinality.tasks", "app:tasks", 1_000],
    ["cardinality.review", "app:review", 1_000],
    ["cardinality.shell", SHELL_POLL_SCOPE, SHELL_POLL_INTERVAL_MS],
  ]) {
    manager.start({
      key,
      scope,
      intervalMs,
      immediate: false,
      critical: false,
      resume: "interval",
      task: async () => {},
    });
  }
  const shell = manager.getSummary().find((entry) => entry.key === "cardinality.shell");
  const shellTimerId = [...timers.jobs.entries()]
    .find(([, job]) => job.due === shell.nextRunAt)?.[0];
  assert.equal(timers.jobs.size, 3);
  assert.equal(focusSource.listeners.size, 1);
  assert.equal(visibility.listeners.size, 1);

  for (let index = 0; index < 50; index += 1) {
    focusSource.update({
      focusedScope: index % 2 === 0 ? "app:review" : "app:tasks",
    });
    assert.equal(timers.jobs.size, 3, `第 ${index + 1} 次切焦`);
    assert.equal(focusSource.listeners.size, 1);
    assert.equal(visibility.listeners.size, 1);
  }
  assert.equal(timers.jobs.has(shellTimerId), true, "shell timer 不得被切焦替换");
  assert.equal(
    manager.getSummary().find((entry) => entry.key === "cardinality.shell").nextRunAt,
    shell.nextRunAt,
  );

  manager.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(focusSource.listeners.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

function installPersonalizationDom() {
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
      this.inert = false;
      this.listeners = new Map();
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
      for (const child of this.children) {
        if (child instanceof TestElement) child.parentElement = null;
      }
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
    matches(selector) {
      return selector.split(",").some((part) => {
        const token = part.trim();
        const match = token.match(/^\[data-([a-z0-9-]+)(?:="([^"]+)")?\]$/);
        if (!match) return false;
        const key = match[1].replace(/-([a-z])/g, (_whole, letter) => letter.toUpperCase());
        if (!Object.prototype.hasOwnProperty.call(this.dataset, key)) return false;
        return match[2] === undefined || this.dataset[key] === match[2];
      });
    }
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, target = this, details = {}) {
      const event = {
        type,
        target,
        key: details.key,
        returnValue: undefined,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
      return event;
    }
    focus() { globalThis.document.activeElement = this; }
    scrollBy(options) {
      this.lastScrollBy = options;
      this.scrollLeft += Number(options?.left || 0);
    }
    click() {}
  }
  class TestButton extends TestElement {}
  class TestForm extends TestElement {}

  const globalListeners = new Map();
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
  install("addEventListener", (type, listener) => {
    if (!globalListeners.has(type)) globalListeners.set(type, new Set());
    globalListeners.get(type).add(listener);
  });
  install("removeEventListener", (type, listener) => globalListeners.get(type)?.delete(listener));

  const root = new TestElement("main");
  return {
    root,
    TestElement,
    descendants(element) {
      return [element, ...(element.children || []).flatMap((child) => (
        child instanceof TestElement ? this.descendants(child) : []
      ))];
    },
    emitGlobal(type) {
      const event = { returnValue: undefined, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of [...(globalListeners.get(type) || [])]) listener(event);
      return event;
    },
    listenerCount(type) { return globalListeners.get(type)?.size ?? 0; },
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function personalizationState(overrides = {}) {
  const committed = projectPersonalizationPreferences({
    ...PERSONALIZATION_DEFAULTS,
    ...(overrides.committed || {}),
  });
  const draft = projectPersonalizationPreferences({
    ...committed,
    ...(overrides.draft || {}),
  });
  const systemReduced = overrides.systemReduced === true;
  return {
    committed,
    draft,
    dirty: !personalizationPreferencesEqual(committed, draft),
    busy: overrides.busy === true,
    motion: {
      userMode: draft.animations,
      systemReduced,
      effective: draft.animations === "on" && !systemReduced,
      limitedBySystem: draft.animations === "on" && systemReduced,
    },
  };
}

function cleanupIndexedDbFixture(mode = "success") {
  const calls = {
    open: [],
    contains: [],
    transactions: [],
    objectStores: [],
    deletes: [],
    reads: 0,
    closes: 0,
  };
  const database = {
    objectStoreNames: {
      contains(name) {
        calls.contains.push(name);
        return mode !== "no-store" && mode !== "upgrade-no-store";
      },
    },
    transaction(name, access) {
      calls.transactions.push([name, access]);
      if (mode === "transaction-error") throw new Error("transaction denied");
      const transaction = {
        objectStore(storeName) {
          calls.objectStores.push(storeName);
          return {
            get() {
              calls.reads += 1;
              throw new Error("cleanup must not read");
            },
            delete(key) {
              calls.deletes.push(key);
              const request = { error: new Error("delete failed") };
              queueMicrotask(() => {
                if (mode === "delete-error") {
                  request.onerror?.({ target: request });
                  transaction.onerror?.({ target: transaction });
                } else {
                  transaction.oncomplete?.({ target: transaction });
                }
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
  const indexedDB = {
    open(...args) {
      calls.open.push(args);
      if (mode === "open-throw") throw new Error("open failed");
      const request = { result: database, error: new Error("open failed") };
      queueMicrotask(() => {
        if (mode === "blocked-late-success") {
          request.onblocked?.({ target: request });
          queueMicrotask(() => request.onsuccess?.({ target: request }));
        } else if (mode === "open-error") {
          request.onerror?.({ target: request });
        } else {
          if (mode === "upgrade-no-store") request.onupgradeneeded?.({ target: request });
          request.onsuccess?.({ target: request });
        }
      });
      return request;
    },
  };
  return { calls, indexedDB };
}

test("个性化模型只保留场景与动效，严格投影覆盖六场景", () => {
  assert.deepEqual(BUILT_IN_WALLPAPER_COLOR_IDS, [
    "graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper",
  ]);
  assert.deepEqual(PERSONALIZATION_PREFERENCE_KEYS, ["animations", "wallpaperColor"]);
  assert.deepEqual(Object.keys(PERSONALIZATION_OPTIONS), ["animations", "wallpaperColor"]);
  assert.deepEqual(PERSONALIZATION_DEFAULTS, { animations: "on", wallpaperColor: "graphite" });
  assert.equal(Object.isFrozen(PERSONALIZATION_DEFAULTS), true);
  assert.equal(Object.isFrozen(PERSONALIZATION_OPTIONS.animations), true);
  assert.equal(Object.isFrozen(BUILT_IN_WALLPAPER_COLOR_IDS), true);

  for (const animations of PERSONALIZATION_OPTIONS.animations) {
    for (const wallpaperColor of BUILT_IN_WALLPAPER_COLOR_IDS) {
      const projected = projectPersonalizationPreferences({ animations, wallpaperColor });
      assert.deepEqual(projected, { animations, wallpaperColor });
      assert.equal(Object.isFrozen(projected), true);
      assert.equal(isValidPersonalizationPreferences(projected), true);
    }
  }
  for (const invalid of [
    { animations: "system", wallpaperColor: "graphite" },
    { animations: "on", wallpaperColor: "#20242A" },
    { animations: "on", wallpaperColor: "unknown" },
    { animations: "on", wallpaperColor: { id: "forest" } },
    { animations: "on", wallpaperColor: "forest", unknown: true },
    { animations: "on", wallpaperColor: "forest", themeAccent: "#FFFFFF" },
  ]) assert.throws(() => projectPersonalizationPreferences(invalid), TypeError);
  assert.equal(isValidPersonalizationPreferences([]), false);
});

test("个性化旧记录迁移保留合法值，custom、损坏与危险对象安全回退", () => {
  for (const wallpaperColor of BUILT_IN_WALLPAPER_COLOR_IDS) {
    assert.deepEqual(normalizePersonalizationPreferences({
      animations: "off",
      wallpaperColor,
      wallpaperFit: "tile",
      windowOpacity: "soft",
      themeAccent: "#FFFFFF",
    }), { animations: "off", wallpaperColor });
  }
  assert.deepEqual(normalizePersonalizationPreferences({
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "forest",
  }), { animations: "off", wallpaperColor: "graphite" });
  assert.deepEqual(normalizePersonalizationPreferences({
    animations: "off",
    wallpaperColor: "unknown",
  }), { animations: "off", wallpaperColor: "graphite" });
  assert.deepEqual(normalizePersonalizationPreferences(null), PERSONALIZATION_DEFAULTS);
  assert.deepEqual(normalizePersonalizationPreferences(new Date()), PERSONALIZATION_DEFAULTS);

  let getterReads = 0;
  const accessor = Object.create(null);
  Object.defineProperty(accessor, "animations", {
    enumerable: true,
    get() { getterReads += 1; return "off"; },
  });
  Object.defineProperty(accessor, "wallpaperColor", {
    enumerable: true,
    get() { getterReads += 1; return "forest"; },
  });
  assert.deepEqual(normalizePersonalizationPreferences(accessor), PERSONALIZATION_DEFAULTS);
  assert.throws(() => projectPersonalizationPreferences(accessor), TypeError);
  assert.equal(getterReads, 0);

  const dangerous = JSON.parse('{"animations":"off","wallpaperColor":"forest","__proto__":{"polluted":true}}');
  assert.deepEqual(normalizePersonalizationPreferences(dangerous), PERSONALIZATION_DEFAULTS);
  assert.throws(() => projectPersonalizationPreferences(dangerous), TypeError);
  assert.equal({}.polluted, undefined);

  const copied = copyPersonalizationPreferences({ animations: "off", wallpaperColor: "forest" });
  copied.wallpaperColor = "slate";
  assert.equal(personalizationPreferencesEqual(copied, { animations: "off", wallpaperColor: "forest" }), false);
  assert.equal(personalizationPreferencesEqual({}, PERSONALIZATION_DEFAULTS), true);
  const restored = restoreDefaultPersonalizationPreferences();
  assert.deepEqual(restored, PERSONALIZATION_DEFAULTS);
  assert.notEqual(restored, PERSONALIZATION_DEFAULTS);
});

test("个性化只读预览拒绝污染状态并固定深色夜航事实", () => {
  for (const choice of PERSONALIZATION_SCENE_CHOICES) {
    const preview = derivePersonalizationPreview(personalizationState({
      draft: { wallpaperColor: choice.id, animations: "off" },
    }));
    assert.equal(Object.isFrozen(preview), true);
    assert.equal(preview.scene.id, choice.id);
    assert.equal(preview.scene.label, choice.label);
    assert.equal(preview.appearance.tone, "dark");
    assert.equal(preview.motion.statusId, "off");
    assert.equal(preview.status.id, "dirty");
  }
  const limited = derivePersonalizationPreview(personalizationState({ systemReduced: true }));
  assert.equal(limited.motion.statusId, "system-limited");
  assert.match(limited.motion.message, /减少动态效果/);
  assert.throws(() => derivePersonalizationPreview({
    ...personalizationState(),
    secret: "do-not-leak",
  }), TypeError);
  const accessor = personalizationState();
  Object.defineProperty(accessor, "motion", { get() { throw new Error("secret"); } });
  assert.throws(() => derivePersonalizationPreview(accessor), TypeError);
  assert.throws(() => derivePersonalizationPreview({
    ...personalizationState(),
    dirty: true,
  }), TypeError);
});

test("Personalization 视图仅有场景、动效、只读预览与应用动作", () => {
  const dom = installPersonalizationDom();
  let view;
  try {
    view = createPersonalizationView({
      root: dom.root,
      app: { label: "外观设置", windowTitle: "DESKTOP.CPL" },
    });
    const all = dom.descendants(dom.root);
    assert.equal(view.elements.form.children.length, 1);
    assert.equal(view.elements.form.children[0], view.elements.workspace);
    assert.equal(view.elements.workspaceTrack.children.length, 3);
    assert.deepEqual(
      view.elements.workspaceTrack.children.map((column) => column.children[0].children[1].textContent),
      ["场景", "动效", "应用"],
    );
    assert.equal(Object.keys(view.elements.sceneInputs).length, 6);
    assert.equal(Object.keys(view.elements.motionInputs).length, 2);
    assert.equal(all.filter((element) => element.type === "color" || element.type === "file").length, 0);
    assert.equal(all.filter((element) => element.tagName === "FORM").length, 1);
    assert.equal(all.filter((element) => element.getAttribute("aria-live") === "polite").length >= 5, true);

    const state = personalizationState({
      draft: { wallpaperColor: "forest", animations: "off" },
    });
    view.renderState(state);
    assert.equal(view.elements.previewDesktop.dataset.personalizationScene, "forest");
    assert.equal(view.elements.previewDesktop.dataset.personalizationMotion, "off");
    assert.match(view.elements.previewSceneFact.textContent, /深林/);
    assert.match(view.elements.previewToneFact.textContent, /深色夜航玻璃/);
    assert.equal(view.elements.applyButton.disabled, false);
    assert.equal(view.elements.cancelButton.disabled, false);
    assert.deepEqual(view.readDraft(state.draft), state.draft);

    view.setBusy(true);
    assert.equal(view.elements.applyButton.disabled, true);
    assert.equal(Object.values(view.elements.sceneInputs).every((input) => input.disabled), true);
    view.setBusy(false);
    view.setStatus("success", "已保存");
    assert.equal(view.elements.status.dataset.personalizationStatus, "success");
    assert.throws(() => view.setStatus("warning", "invalid"), TypeError);
    assert.equal(view.scrollWorkspace(1), true);
    assert.equal(view.elements.workspace.lastScrollBy.left > 0, true);
    assert.equal(view.scrollWorkspace(-1), true);
    assert.equal(view.scrollWorkspace(0), false);
  } finally {
    view?.destroy();
    dom.restore();
  }
});

test("Personalization controller 保持实时预览、Apply/Cancel/reset 与单飞离开保护", async () => {
  const dom = installPersonalizationDom();
  const storageFixture = createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS);
  const wallpaper = { classList: new FakeClassList() };
  const motionListeners = new Set();
  let motionMode = "on";
  const motion = {
    getState: () => ({ userMode: motionMode, systemReduced: false, effective: motionMode === "on", limitedBySystem: false }),
    previewUserMode(mode) { motionMode = mode; },
    subscribe(listener) { motionListeners.add(listener); return () => motionListeners.delete(listener); },
  };
  const runtime = createPersonalizationRuntime({
    wallpaper,
    storage: storageFixture.service,
    motion,
  });
  let dialogCalls = 0;
  let resolveDialog = null;
  const dialogs = {
    open() {
      dialogCalls += 1;
      return new Promise((resolve) => { resolveDialog = resolve; });
    },
    destroyCalls: 0,
    destroy() { this.destroyCalls += 1; },
  };
  let mounted = false;
  try {
    personalizationApplication.mount({
      root: dom.root,
      app: { label: "外观设置", windowTitle: "DESKTOP.CPL" },
      dialogs,
      personalization: runtime,
    });
    mounted = true;
    personalizationApplication.activate();
    assert.equal(dom.root.hidden, false);
    assert.equal(dom.listenerCount("beforeunload"), 1);

    const sceneInputs = dom.descendants(dom.root).filter((element) => (
      Object.prototype.hasOwnProperty.call(element.dataset, "personalizationScene")
    ));
    const graphite = sceneInputs.find((input) => input.dataset.personalizationScene === "graphite");
    const forest = sceneInputs.find((input) => input.dataset.personalizationScene === "forest");
    graphite.checked = false;
    forest.checked = true;
    dom.root.emit("change", forest);
    assert.equal(runtime.getState().draft.wallpaperColor, "forest");
    assert.equal(runtime.getState().dirty, true);
    assert.equal(wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.forest), true);
    assert.equal(dom.emitGlobal("beforeunload").defaultPrevented, true);

    const leave = personalizationApplication.beforeLeave();
    const duplicate = personalizationApplication.beforeWindowHide(null, "minimized");
    assert.equal(leave, duplicate);
    assert.equal(dialogCalls, 1);
    resolveDialog("cancel");
    assert.equal(await leave, false);
    assert.equal(runtime.getState().dirty, true);

    const form = dom.descendants(dom.root).find((element) => element instanceof HTMLFormElement);
    dom.root.emit("submit", form);
    await flushPromises();
    assert.equal(storageFixture.writes.length, 1);
    assert.deepEqual(storageFixture.current(), { animations: "on", wallpaperColor: "forest" });
    assert.equal(runtime.getState().dirty, false);

    const reset = dom.descendants(dom.root).find((element) => element.dataset.personalizationAction === "reset");
    dom.root.emit("click", reset);
    assert.equal(runtime.getState().draft.wallpaperColor, "graphite");
    assert.equal(runtime.getState().dirty, true);
    const cancel = dom.descendants(dom.root).find((element) => element.dataset.personalizationAction === "cancel");
    dom.root.emit("click", cancel);
    assert.equal(runtime.getState().draft.wallpaperColor, "forest");
    assert.equal(runtime.getState().dirty, false);

    graphite.checked = true;
    forest.checked = false;
    dom.root.emit("change", graphite);
    const confirmed = personalizationApplication.beforeLeave();
    resolveDialog("confirm");
    assert.equal(await confirmed, true);
    assert.equal(runtime.getState().dirty, false);
    assert.equal(runtime.getState().draft.wallpaperColor, "forest");

    personalizationApplication.deactivate();
    assert.equal(dom.root.hidden, true);
    assert.equal(dom.root.inert, true);
    personalizationApplication.activate();
    assert.equal(dom.root.hidden, false);
  } finally {
    if (mounted) personalizationApplication.unmount();
    runtime.destroy();
    assert.equal(motionListeners.size, 0);
    assert.equal(dom.listenerCount("beforeunload"), 0);
    dom.restore();
  }
});

test("旧壁纸清理 seam 只删除已知 record，覆盖成功与全部非阻断失败", async () => {
  assert.deepEqual(WALLPAPER_STORAGE_SCHEMA, {
    databaseName: "imageweave-ui",
    storeName: "wallpapers",
    customKey: "custom",
  });
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: null }), false);
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: {} }), false);

  const success = cleanupIndexedDbFixture("success");
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: success.indexedDB }), true);
  assert.deepEqual(success.calls.open, [["imageweave-ui"]]);
  assert.deepEqual(success.calls.transactions, [["wallpapers", "readwrite"]]);
  assert.deepEqual(success.calls.deletes, ["custom"]);
  assert.equal(success.calls.reads, 0);
  assert.equal(success.calls.closes, 1);

  for (const mode of ["no-store", "upgrade-no-store"]) {
    const noStore = cleanupIndexedDbFixture(mode);
    assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: noStore.indexedDB }), true, mode);
    assert.deepEqual(noStore.calls.transactions, [], mode);
    assert.equal(noStore.calls.closes, 1, mode);
  }

  for (const mode of ["open-throw", "open-error", "transaction-error", "delete-error"]) {
    const fixture = cleanupIndexedDbFixture(mode);
    assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: fixture.indexedDB }), false, mode);
    assert.equal(fixture.calls.reads, 0, mode);
    if (mode === "transaction-error" || mode === "delete-error") {
      assert.equal(fixture.calls.closes, 1, mode);
    }
  }

  const blocked = cleanupIndexedDbFixture("blocked-late-success");
  assert.equal(await cleanupLegacyCustomWallpaper({ indexedDB: blocked.indexedDB }), false);
  await flushPromises();
  assert.equal(blocked.calls.closes, 1, "a connection arriving after blocked resolution is still closed");
  assert.equal(blocked.calls.reads, 0);
});

test("Storage v2 位置偏好 facade、service shape 与 key 保持严格", () => {
  assert.deepEqual(STORAGE_KEYS, {
    currentApp: "imageweave.ui:current-app",
    activeBatch: "imageweave.ui:active-batch",
    windowLayout: "imageweave.window-layout.v1",
    windowPlacements: "imageweave.window-placements.v2",
    uiPreferences: "imageweave.ui:ui-preferences",
  });
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.deepEqual(Object.keys(storage), [
    "readCurrentApp", "writeCurrentApp", "clearCurrentApp",
    "readActiveBatchId", "writeActiveBatchId", "clearActiveBatchId",
    "readWindowPlacements", "readWindowPlacement", "writeWindowPlacements",
    "writeWindowPlacementsFromStack", "readWindowLayout", "writeWindowLayout",
    "readUiPreferences", "writeUiPreferences", "writePersonalizationPreferences",
  ]);
  const stack = [windowRecord("crawl", "normal", windowRect())];
  assert.equal(storage.writeWindowLayout(stack), true);
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.windowPlacements)), {
    placements: [{ appId: "crawl", rect: windowRect(), maximized: false }],
  });
  assert.deepEqual(storage.readWindowPlacement("crawl"), {
    rect: windowRect(), maximized: false,
  });
  assert.deepEqual(createDefaultWindowLayout({ width: 800, height: 600 }), []);
  assert.deepEqual(
    clampWindowRect(windowRect({ x: 9_999, y: -9_999 }), { width: 800, height: 600 }),
    { x: 768, y: -448, w: 720, h: 480 },
  );
});

test("Storage v1/v2 纯序列化、迁移与 persistence 作用域", () => {
  assert.deepEqual(parseStorageObject('{"safe":true}'), { safe: true });
  assert.equal(parseStorageObject("x".repeat(4097)), null);
  const placements = [
    { appId: "crawl", rect: windowRect({ x: 10 }), maximized: false },
    { appId: "review", rect: windowRect({ x: 20 }), maximized: true },
  ];
  const serialized = serializeWindowPlacements(placements);
  assert.deepEqual(deserializeWindowPlacements(serialized, { width: 1280, height: 720 }), placements);
  assert.deepEqual(migrateLegacyWindowLayout(JSON.stringify({ windows: [
    windowRecord("review", "maximized", windowRect({ x: 20 })),
    windowRecord("crawl", "minimized", windowRect({ x: 30 })),
  ] }), { width: 1280, height: 720 }), [
    { appId: "crawl", rect: windowRect({ x: 30 }), maximized: false },
    { appId: "review", rect: windowRect({ x: 20 }), maximized: true },
  ]);

  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const persistence = createStoragePersistenceAdapter({ localStorage: local, sessionStorage: session });
  assert.equal(persistence.writeSession(STORAGE_KEYS.currentApp, "crawl"), true);
  assert.equal(persistence.writeLocal(STORAGE_KEYS.windowPlacements, serialized), true);
  assert.equal(persistence.removeLocal(STORAGE_KEYS.windowPlacements), true);
  assert.throws(() => persistence.readLocal(STORAGE_KEYS.currentApp), TypeError);
  assert.throws(() => persistence.writeSession(STORAGE_KEYS.windowLayout, "{}"), TypeError);
  const service = createStorageServiceFromAdapter(persistence);
  assert.equal(service.readCurrentApp(), "crawl");
  assert.equal(service.writeActiveBatchId("batch:1"), true);
  assert.equal(service.readActiveBatchId(), "batch:1");
});

test("Storage 位置偏好拒绝危险键、访问器、重复和未知 app", () => {
  const local = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: new MemoryStorage() });
  local.values.set(STORAGE_KEYS.windowPlacements, '{"placements":[],"__proto__":{}}');
  assert.deepEqual(storage.readWindowPlacements({ width: 800, height: 600 }), []);
  assert.equal({}.storagePolluted, undefined);
  const accessor = { appId: "crawl", maximized: false };
  let getterCalled = false;
  Object.defineProperty(accessor, "rect", {
    enumerable: true,
    get() { getterCalled = true; return windowRect(); },
  });
  assert.throws(() => storage.writeWindowPlacements([accessor]), TypeError);
  assert.equal(getterCalled, false);
  assert.throws(() => storage.writeWindowPlacements([
    { appId: "unknown", rect: windowRect(), maximized: false },
  ]), TypeError);
  assert.throws(() => storage.writeWindowPlacements([
    { appId: "crawl", rect: windowRect(), maximized: false },
    { appId: "crawl", rect: windowRect(), maximized: true },
  ]), TypeError);
});

test("Storage 只写固定 session/local 命名空间", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.equal(storage.writeCurrentApp("review"), true);
  assert.equal(storage.writeActiveBatchId("batch-123"), true);
  assert.equal(storage.writeWindowLayout([windowRecord("review")]), true);
  assert.equal(storage.writeUiPreferences({ animations: "off", wallpaperColor: "slate" }), true);
  assert.deepEqual([...session.values.keys()].sort(), [
    STORAGE_KEYS.activeBatch, STORAGE_KEYS.currentApp,
  ].sort());
  assert.deepEqual([...local.values.keys()].sort(), [
    STORAGE_KEYS.uiPreferences, STORAGE_KEYS.windowPlacements,
  ].sort());
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), {
    animations: "off", wallpaperColor: "slate",
  });
  assert.equal(storage.readCurrentApp(), "review");
  assert.equal(storage.readActiveBatchId(), "batch-123");
});

test("Storage 迁移六场景、旧动效和 custom，并永久丢弃退役字段", () => {
  for (const wallpaperColor of BUILT_IN_WALLPAPER_COLOR_IDS) {
    const legacy = {
      animations: "off",
      wallpaperColor,
      wallpaperKind: "color",
      wallpaperFit: "contain",
      wallpaperPosition: "bottom-right",
      wallpaperMaskTone: "light",
      wallpaperMaskStrength: 75,
      wallpaperBlur: "medium",
      windowOpacity: "soft",
      themeAccent: "#FFFFFF",
      themeSurface: "#101010",
      taskbarDensity: "compact",
    };
    assert.deepEqual(deserializeUiPreferences(JSON.stringify(legacy)), {
      animations: "off", wallpaperColor,
    });
  }
  assert.deepEqual(deserializeUiPreferences(JSON.stringify({
    animations: "off", wallpaperKind: "custom", wallpaperColor: "forest",
  })), { animations: "off", wallpaperColor: "graphite" });
  assert.deepEqual(deserializeUiPreferences('{"animations":"system","wallpaperColor":"slate"}'), {
    animations: "on", wallpaperColor: "slate",
  });
  assert.deepEqual(deserializeUiPreferences('{"animations":"reduced","wallpaperColor":"slate"}'), {
    animations: "off", wallpaperColor: "slate",
  });
  assert.deepEqual(deserializeUiPreferences("{broken"), PERSONALIZATION_DEFAULTS);

  const local = new MemoryStorage();
  local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify({
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "warm-paper",
    taskbarDensity: "compact",
    image: "private",
  }));
  const service = createStorageService({ localStorage: local, sessionStorage: new MemoryStorage() });
  assert.deepEqual(service.readUiPreferences(), { animations: "off", wallpaperColor: "graphite" });
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), {
    animations: "off", wallpaperColor: "graphite",
  });

  let getterReads = 0;
  const accessor = { wallpaperColor: "forest" };
  Object.defineProperty(accessor, "animations", {
    enumerable: true,
    get() { getterReads += 1; return "off"; },
  });
  assert.deepEqual(sanitizeUiPreferences(accessor), {
    animations: "on", wallpaperColor: "forest",
  });
  assert.equal(getterReads, 0);
});

test("Storage 新写入严格只有 animations 与 wallpaperColor", () => {
  const safe = { animations: "off", wallpaperColor: "plum-gray" };
  assert.deepEqual(projectUiPreferences(safe), safe);
  assert.deepEqual(JSON.parse(serializeUiPreferences(safe)), safe);
  assert.deepEqual(JSON.parse(serializePersonalizationPreferences(
    safe,
    JSON.stringify({
      ...safe,
      wallpaperKind: "custom",
      themeAccent: "#FFFFFF",
      taskbarDensity: "compact",
    }),
  )), safe);

  for (const unsafe of [
    { ...safe, wallpaperKind: "color" },
    { ...safe, themeAccent: "#FFFFFF" },
    { ...safe, windowOpacity: "soft" },
    { ...safe, taskbarDensity: "compact" },
    { ...safe, wallpaperColor: "https://example.invalid/private.png" },
    { ...safe, image: new Uint8Array([1, 2, 3]) },
    [],
    new Date(),
  ]) {
    assert.throws(() => serializeUiPreferences(unsafe), TypeError);
  }

  let getterReads = 0;
  const accessor = { wallpaperColor: "forest" };
  Object.defineProperty(accessor, "animations", {
    enumerable: true,
    get() { getterReads += 1; return "off"; },
  });
  assert.throws(() => projectUiPreferences(accessor), TypeError);
  assert.equal(getterReads, 0);

  const dangerous = JSON.parse('{"animations":"off","wallpaperColor":"forest","constructor":{}}');
  assert.throws(() => projectUiPreferences(dangerous), TypeError);
  const withSymbol = { ...safe };
  Object.defineProperty(withSymbol, Symbol("secret"), { value: true, enumerable: true });
  assert.throws(() => projectUiPreferences(withSymbol), TypeError);

  const local = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: new MemoryStorage() });
  assert.equal(storage.writePersonalizationPreferences(safe), true);
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), safe);
  assert.throws(() => storage.writeUiPreferences({ ...safe, unknown: true }), TypeError);
});

test("Storage 兼容不可用或损坏的浏览器存储并自愈偏好 JSON", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  session.values.set(STORAGE_KEYS.currentApp, "invalid-app");
  session.values.set(STORAGE_KEYS.activeBatch, "bad/path");
  local.values.set(STORAGE_KEYS.windowLayout, "not-json");
  local.values.set(STORAGE_KEYS.uiPreferences, "{broken-json");
  assert.equal(storage.readCurrentApp(), null);
  assert.equal(storage.readActiveBatchId(), null);
  assert.deepEqual(
    storage.readWindowLayout({ width: 800, height: 600 }),
    [],
  );
  assert.deepEqual(storage.readUiPreferences(), PERSONALIZATION_DEFAULTS);
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    PERSONALIZATION_DEFAULTS,
  );

  const unavailable = createStorageService({
    localStorage: new MemoryStorage({ throws: true }),
    sessionStorage: new MemoryStorage({ throws: true }),
  });
  assert.equal(unavailable.readCurrentApp(), null);
  assert.equal(unavailable.writeCurrentApp("crawl"), false);
  assert.deepEqual(
    unavailable.readWindowLayout({ width: 800, height: 600 }),
    [],
  );
  assert.equal(unavailable.writeWindowLayout([windowRecord("crawl")]), false);
  assert.deepEqual(unavailable.readUiPreferences(), PERSONALIZATION_DEFAULTS);
  assert.equal(unavailable.writeUiPreferences(PERSONALIZATION_DEFAULTS), false);
});

test("动效控制器落实系统覆盖且只保留场景与动效偏好", () => {
  const retainedPreferences = {
    animations: "on",
    wallpaperColor: "plum-gray",
  };
  const local = new MemoryStorage();
  local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify(retainedPreferences));
  const storage = createStorageService({
    localStorage: local,
    sessionStorage: new MemoryStorage(),
  });
  const root = new FakeRootElement();
  const mediaQuery = new FakeMediaQueryList(true);
  let requestedQuery = "";
  const controller = createMotionController({
    root,
    storage,
    matchMedia(query) {
      requestedQuery = query;
      return mediaQuery;
    },
  });

  assert.equal(requestedQuery, MOTION_MEDIA_QUERY);
  assert.deepEqual(controller.getState(), {
    userMode: "on",
    systemReduced: true,
    effective: false,
    limitedBySystem: true,
  });
  assert.equal(root.getAttribute("data-motion"), "on");
  assert.equal(root.getAttribute("data-motion-effective"), "off");
  assert.equal(root.getAttribute("data-motion-limited"), "true");

  const observed = [];
  const unsubscribe = controller.subscribe((state) => observed.push(state));
  assert.equal(controller.setUserMode("off"), true);
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), {
    animations: "off",
    wallpaperColor: "plum-gray",
  });
  mediaQuery.setMatches(false);
  assert.equal(controller.getState().effective, false);
  assert.equal(controller.setUserMode("on"), true);
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), retainedPreferences);
  assert.equal(controller.getState().effective, true);
  mediaQuery.setMatches(true);
  assert.equal(controller.getState().limitedBySystem, true);
  assert.equal(observed.length, 4);
  assert.throws(() => controller.setUserMode("system"), TypeError);
  assert.throws(() => controller.subscribe(null), TypeError);

  unsubscribe();
  controller.destroy();
  assert.equal(mediaQuery.listeners.size, 0);
});

test("动效控制器初始化失败时使用安全默认值且不阻断调用方", () => {
  let controller;
  assert.doesNotThrow(() => {
    controller = createMotionController({
      root: { setAttribute() { throw new Error("root unavailable"); } },
      storage: {
        readUiPreferences() { throw new Error("storage unavailable"); },
        writeUiPreferences() { throw new Error("storage unavailable"); },
      },
      matchMedia() { throw new Error("media query unavailable"); },
    });
  });
  assert.deepEqual(controller.getState(), {
    userMode: "on",
    systemReduced: false,
    effective: true,
    limitedBySystem: false,
  });
  assert.equal(controller.setUserMode("off"), false);
  assert.doesNotThrow(() => controller.destroy());
});

test("个性化运行时只映射六场景与 motion，实时预览和取消不写存储", async () => {
  const preferenceStorage = createPersonalizationStorageFixture({
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "forest",
    themeAccent: "#FFFFFF",
  });
  const wallpaper = { classList: new FakeClassList(["unrelated-class"]) };
  let motionMode = "off";
  const motionListeners = new Set();
  const motion = {
    previewCalls: [],
    getState() {
      return { userMode: motionMode, systemReduced: false, effective: motionMode === "on", limitedBySystem: false };
    },
    previewUserMode(mode) {
      this.previewCalls.push(mode);
      motionMode = mode;
    },
    subscribe(listener) { motionListeners.add(listener); return () => motionListeners.delete(listener); },
  };
  const runtime = createPersonalizationRuntime({
    wallpaper,
    storage: preferenceStorage.service,
    motion,
  });
  assert.deepEqual(await runtime.ready(), runtime.getState());
  assert.deepEqual(runtime.getState().committed, {
    animations: "off",
    wallpaperColor: "graphite",
  });
  assert.deepEqual(Object.keys(runtime.getState()), ["committed", "draft", "dirty", "busy", "motion"]);
  assert.equal(wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.graphite), true);
  assert.equal(wallpaper.classList.contains("unrelated-class"), true);
  assert.equal(preferenceStorage.writes.length, 0);

  let published = 0;
  const unsubscribe = runtime.subscribe(() => { published += 1; });
  const noisyUnsubscribe = runtime.subscribe(() => { throw new Error("detached view"); });
  for (const wallpaperColor of BUILT_IN_WALLPAPER_COLOR_IDS) {
    const state = runtime.preview({ animations: "on", wallpaperColor });
    assert.equal(state.draft.wallpaperColor, wallpaperColor);
    assert.equal(state.draft.animations, "on");
    assert.equal(wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES[wallpaperColor]), true);
    assert.equal(Object.entries(WALLPAPER_COLOR_CLASSES).every(([id, className]) => (
      wallpaper.classList.contains(className) === (id === wallpaperColor)
    )), true);
  }
  const beforeNoop = published;
  runtime.preview(runtime.getState().draft);
  assert.equal(published, beforeNoop);
  assert.equal(preferenceStorage.writes.length, 0);
  const priorDraft = runtime.getState().draft;
  assert.throws(() => runtime.preview({ animations: "on", wallpaperColor: "unknown" }), TypeError);
  assert.deepEqual(runtime.getState().draft, priorDraft);

  const cancelled = runtime.cancel();
  assert.deepEqual(cancelled.draft, cancelled.committed);
  assert.equal(cancelled.dirty, false);
  assert.equal(wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.graphite), true);
  assert.equal(motionMode, "off");
  assert.equal(preferenceStorage.writes.length, 0);

  unsubscribe();
  noisyUnsubscribe();
  runtime.destroy();
  assert.equal(motionListeners.size, 0);
  assert.throws(() => runtime.preview(PERSONALIZATION_DEFAULTS), /销毁/);
  assert.throws(() => runtime.subscribe(() => {}), /销毁/);
  assert.doesNotThrow(() => runtime.destroy());
});

test("个性化 Apply 单飞且一次只保存新白名单，失败与取消恢复基线", async () => {
  const preferenceStorage = createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS);
  const wallpaper = { classList: new FakeClassList() };
  const runtime = createPersonalizationRuntime({ wallpaper, storage: preferenceStorage.service });
  runtime.preview({ animations: "off", wallpaperColor: "forest" });
  const firstCommit = runtime.commit();
  assert.equal(runtime.getState().busy, true);
  const duplicateCommit = runtime.commit();
  assert.throws(
    () => runtime.preview({ animations: "on", wallpaperColor: "slate" }),
    /保存/,
  );
  const duplicate = await duplicateCommit;
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "busy");
  const committed = await firstCommit;
  assert.equal(committed.ok, true);
  assert.equal(committed.code, "saved");
  assert.deepEqual(preferenceStorage.writes, [{ animations: "off", wallpaperColor: "forest" }]);
  assert.deepEqual(preferenceStorage.current(), { animations: "off", wallpaperColor: "forest" });
  assert.equal(runtime.getState().dirty, false);
  assert.equal((await runtime.commit()).code, "unchanged");

  preferenceStorage.setWritesAllowed(false);
  runtime.preview({ animations: "on", wallpaperColor: "slate" });
  const failed = await runtime.commit();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "preference_storage_unavailable");
  assert.deepEqual(failed.state.committed, { animations: "off", wallpaperColor: "forest" });
  assert.deepEqual(failed.state.draft, { animations: "on", wallpaperColor: "slate" });
  assert.equal(failed.state.dirty, true);
  assert.deepEqual(runtime.cancel().draft, { animations: "off", wallpaperColor: "forest" });
  assert.equal(wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.forest), true);
  runtime.destroy();

  const delayedStorage = createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS);
  const delayed = createPersonalizationRuntime({ storage: delayedStorage.service });
  delayed.preview({ animations: "off", wallpaperColor: "plum-gray" });
  const pending = delayed.commit();
  delayed.destroy();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, "cancelled");
  assert.equal(delayedStorage.writes.length, 0);
});

test("个性化运行时对损坏适配器与系统 reduced-motion 变化保持安全", () => {
  const listeners = new Set();
  let systemReduced = true;
  let mode = "on";
  const motion = {
    getState() { return { userMode: mode, systemReduced }; },
    previewUserMode(next) { mode = next; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const wallpaper = {
    classList: {
      toggle() { throw new Error("detached wallpaper"); },
    },
  };
  const runtime = createPersonalizationRuntime({
    wallpaper,
    storage: {
      readUiPreferences() { throw new Error("storage unavailable"); },
      writePersonalizationPreferences() { throw new Error("storage unavailable"); },
    },
    motion,
  });
  assert.deepEqual(runtime.getState().committed, PERSONALIZATION_DEFAULTS);
  assert.deepEqual(runtime.getState().motion, {
    userMode: "on",
    systemReduced: true,
    effective: false,
    limitedBySystem: true,
  });
  let published = 0;
  runtime.subscribe(() => { published += 1; });
  systemReduced = false;
  for (const listener of [...listeners]) listener();
  assert.equal(runtime.getState().motion.effective, true);
  assert.equal(published, 1);
  runtime.preview({ animations: "off", wallpaperColor: "slate" });
  assert.equal(runtime.getState().motion.effective, false);
  runtime.destroy();
  assert.equal(listeners.size, 0);

  let subscriptionFailureRuntime;
  assert.doesNotThrow(() => {
    subscriptionFailureRuntime = createPersonalizationRuntime({
      motion: {
        previewUserMode() {},
        subscribe() { throw new Error("subscription unavailable"); },
      },
    });
  });
  assert.deepEqual(subscriptionFailureRuntime.getState().committed, PERSONALIZATION_DEFAULTS);
  subscriptionFailureRuntime.destroy();
});

test("状态映射始终返回图标、文本和非颜色状态类别", () => {
  assert.equal(normalizeStatus("ok"), "ready");
  assert.equal(normalizeStatus("optional_warning"), "warning");
  assert.equal(normalizeStatus("placeholder"), "disabled");
  assert.equal(normalizeStatus("unexpected"), null);
  assert.deepEqual(resolveStatusPresentation("error", "连接失败"), {
    status: "error",
    icon: "!",
    label: "连接失败",
  });
  assert.throws(() => resolveStatusPresentation("unknown"), Error);
});

test("共享状态、空状态与错误视图保留图标文本、ARIA 和销毁生命周期", () => {
  const fixture = installWindowManagerDomFixture();
  try {
    assert.throws(
      () => updateStatusBadge({}, "ready", "已就绪"),
      /状态徽标元素无效/,
    );

    const badge = createStatusBadge("ready", "同步完成", { compact: true });
    assert.equal(badge.className, "status-badge status-badge--compact");
    assert.equal(badge.dataset.status, "ready");
    assert.equal(badge.getAttribute("aria-label"), "同步完成");
    assert.equal(badge.children.length, 2);
    assert.equal(badge.children[0].getAttribute("aria-hidden"), "true");
    assert.equal(badge.children[0].textContent, "✓");
    assert.equal(badge.children[1].textContent, "同步完成");

    const icon = badge.children[0];
    const label = badge.children[1];
    assert.equal(updateStatusBadge(badge, "running", "同步中", {
      title: "同步任务正在运行",
    }), badge);
    assert.equal(badge.dataset.status, "running");
    assert.equal(badge.getAttribute("aria-label"), "同步中");
    assert.equal(badge.title, "同步任务正在运行");
    assert.equal(badge.children[0], icon);
    assert.equal(badge.children[1], label);
    assert.equal(icon.textContent, "▶");
    assert.equal(label.textContent, "同步中");

    const empty = createEmptyState({
      status: "error",
      label: "加载失败",
      title: "没有可显示的事实",
      message: "请检查服务状态后重试。",
    });
    assert.equal(empty.className, "empty-state");
    assert.equal(empty.getAttribute("role"), "alert");
    assert.equal(empty.children.length, 3);
    assert.equal(empty.children[0].dataset.status, "error");
    assert.equal(empty.children[0].children[0].textContent, "!");
    assert.equal(empty.children[1].textContent, "没有可显示的事实");
    assert.equal(empty.children[2].textContent, "请检查服务状态后重试。");

    let actions = 0;
    const rendered = createErrorView({
      code: "backend_fixture",
      message: "请求失败",
      requestId: "request-42",
    }, {
      nextStep: "打开诊断查看运行状态。",
      statusLabel: "读取失败",
      actionLabel: "打开诊断",
      onAction() { actions += 1; },
    });
    fixture.documentObject.documentElement.append(rendered.element);
    assert.equal(rendered.element.className, "error-view");
    assert.equal(rendered.element.getAttribute("role"), "alert");
    assert.equal(rendered.element.children[0].dataset.status, "error");
    assert.equal(rendered.element.children[0].children[0].textContent, "!");
    assert.equal(rendered.element.children[1].textContent, "请求失败");
    assert.equal(rendered.element.children[2].children[1].textContent, "request-42");
    assert.equal(rendered.element.children[3].textContent, "打开诊断查看运行状态。");
    const action = rendered.element.children[4];
    assert.equal(action.className, "route-button");
    action.emit("click");
    assert.equal(actions, 1);
    rendered.destroy();
    assert.equal(rendered.element.parentNode, null);
    action.emit("click");
    assert.equal(actions, 1, "destroy removes the action listener");

    const passive = createErrorView({ code: "network_error" });
    assert.equal(passive.element.children.length, 3);
    passive.destroy();
  } finally {
    fixture.restore();
  }
});

test("任务栏摘要只保留健康、代理和去重的脱敏投影", () => {
  const health = sanitizeHealthPayload({
    ok: true,
    components: {
      process: { status: "ok", raw: "ignored" },
      database: { status: "ok", path: "/private/database" },
    },
    raw: { ignored: true },
  });
  assert.deepEqual(health, { ok: true, process: "ok", database: "ok" });
  const readiness = sanitizeReadinessPayload({
    ready: true,
    components: {
      project_proxy: {
        status: "ok",
        running: true,
        healthy: 4,
        source_count: 8,
        details: { raw: "ignored" },
      },
      dedup: { status: "error", reason: "ignored" },
    },
  });
  assert.deepEqual(readiness, {
    ready: true,
    proxy: { status: "ok", running: true, healthy: 4, sourceCount: 8 },
    dedup: { status: "error" },
  });

  const snapshot = buildShellSnapshot({
    healthOutcome: { connected: true, data: { ok: true, components: {
      process: { status: "ok" }, database: { status: "ok" },
    } } },
    readinessOutcome: { connected: true, data: { ready: false, components: {
      project_proxy: { status: "ok", running: true, healthy: 4, source_count: 8 },
      dedup: { status: "error" },
    } } },
    checkedAt: 456,
  });
  assert.deepEqual(snapshot.summary, {
    api: { status: "warning", label: "服务未就绪" },
    proxy: { status: "running", label: "可用代理 4" },
    dedup: { status: "error", label: "去重异常" },
  });
  assert.equal(JSON.stringify(snapshot).includes("/private"), false);

  const offline = buildShellSnapshot({
    healthOutcome: { connected: false, data: null, error: {
      status: 0, code: "network_error", requestId: "",
    } },
    readinessOutcome: { connected: false, data: null, error: {
      status: 0, code: "network_error", requestId: "",
    } },
    checkedAt: 789,
  });
  assert.equal(offline.apiConnected, false);
  assert.deepEqual(
    Object.values(offline.summary).map((item) => item.status),
    ["error", "error", "error"],
  );
});

test("通用错误视图模型隐藏地址、敏感片段和原始 details", () => {
  const model = toSafeErrorViewModel({
    code: "backend_fixture",
    message: "访问 https://example.invalid/private?token=abc 失败 token=abc，日志 /home/private/raw.log",
    requestId: "request-123",
    details: { raw: "never-render" },
  });
  assert.equal(model.message.includes("example.invalid"), false);
  assert.equal(model.message.includes("token=abc"), false);
  assert.equal(model.message.includes("/home/private"), false);
  assert.equal(model.requestId, "request-123");
  assert.equal(JSON.stringify(model).includes("never-render"), false);
});

const CONFIGURED_REVISION = "a".repeat(64);
const ACTIVE_REVISION = "b".repeat(64);
const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const INLINE_NODE_ID = `node_${"d".repeat(64)}`;
const PROXY_FIXTURE_SECRET = "fixture-super-secret-value";

function rawProxyStatus(overrides = {}) {
  return {
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    auto_start: false,
    running: true,
    total: 1,
    healthy: 1,
    retry_eligible: 1,
    leases: 0,
    last_error: "",
    configured_revision: CONFIGURED_REVISION,
    active_revision: ACTIVE_REVISION,
    reload_required: true,
    transport_core: {
      enabled: true,
      running: true,
      listeners: 1,
      last_error: "",
      binary: `/private/${PROXY_FIXTURE_SECRET}`,
    },
    sources: {
      subscriptions: 1,
      source_nodes: 1,
      pool_nodes: 1,
      core_candidates: 0,
      core_nodes: 0,
      skipped_nodes: 0,
      scheme_counts: { http: 1 },
      warnings: [],
      subscription_url: `https://provider.invalid/${PROXY_FIXTURE_SECRET}`,
    },
    nodes: [{
      id: "0123456789abcdefabcd",
      name: "JP\u0000 NODE",
      protocol: "http",
      endpoint: "http://***@proxy.fixture.invalid:8080",
      tags: ["jp", "http", "bad tag", "jp"],
      healthy: true,
      retry_eligible: true,
      ref_count: 0,
      success_count: 8,
      fail_count: 2,
      last_latency_ms: 42.25,
      cooldown_until: 0,
      last_error: `访问 https://private.invalid/${PROXY_FIXTURE_SECRET} token=${PROXY_FIXTURE_SECRET}`,
      raw_endpoint: `http://user:${PROXY_FIXTURE_SECRET}@private.invalid:8080`,
    }],
    request_body: { secret: PROXY_FIXTURE_SECRET },
    ...overrides,
  };
}

function rawProxySources(overrides = {}) {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: CONFIGURED_REVISION,
    active_revision: ACTIVE_REVISION,
    reload_required: true,
    subscriptions: [{
      id: SUBSCRIPTION_ID,
      source: "runtime",
      scheme: "https",
      host: "provider.fixture.invalid",
      port: 8443,
      display_url: `https://provider.fixture.invalid/private/${PROXY_FIXTURE_SECRET}`,
      credentials_redacted: true,
      sensitive_parts_redacted: true,
      url: `https://user:${PROXY_FIXTURE_SECRET}@provider.fixture.invalid/private`,
    }],
    node_file: {
      configured: true,
      source: "runtime",
      display_path: `/home/private/${PROXY_FIXTURE_SECRET}/nodes.yaml`,
      path: `/home/private/${PROXY_FIXTURE_SECRET}/nodes.yaml`,
    },
    inline_nodes: [{
      id: INLINE_NODE_ID,
      source: "runtime",
      scheme: "vless",
      name: "JP-01",
      host: "proxy.fixture.invalid",
      port: 443,
      requires_transport_core: true,
      display_endpoint: `vless://${PROXY_FIXTURE_SECRET}@proxy.fixture.invalid:443?token=bad`,
      node: `vless://${PROXY_FIXTURE_SECRET}@proxy.fixture.invalid:443`,
    }],
    counts: { subscriptions: 1, node_file: 1, inline_nodes: 1, total: 3 },
    unknown_secret: PROXY_FIXTURE_SECRET,
    ...overrides,
  };
}

function controlStatus(overrides = {}) {
  return {
    enabled: true,
    running: false,
    leases: 0,
    reload_required: true,
    ...overrides,
  };
}

test("代理运行状态 sanitizer 只保留脱敏白名单并防御控制字符和危险字段", () => {
  const sanitized = sanitizeProxyStatus(rawProxyStatus());
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "active_revision",
    "auto_start",
    "configured_revision",
    "enabled",
    "engine",
    "healthy",
    "last_error",
    "leases",
    "managed_by_backend",
    "node_rows_received",
    "nodes",
    "nodes_truncated",
    "reload_required",
    "retry_eligible",
    "running",
    "sources",
    "total",
    "transport_core",
  ].sort());
  assert.equal(sanitized.nodes.length, 1);
  assert.equal(sanitized.nodes[0].name, "JP NODE");
  assert.deepEqual(sanitized.nodes[0].tags, ["jp", "http"]);
  assert.equal(sanitized.nodes[0].endpoint, "http://***@proxy.fixture.invalid:8080");
  assert.equal(sanitized.nodes[0].last_error.includes("private.invalid"), false);
  assert.equal("binary" in sanitized.transport_core, false);
  assert.equal("subscription_url" in sanitized.sources, false);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(PROXY_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("raw_endpoint"), false);

  const overlong = sanitizeProxyStatus(rawProxyStatus({
    last_error: `日志位于 /home/private/${PROXY_FIXTURE_SECRET}/core.log`,
    nodes: [{ ...rawProxyStatus().nodes[0], name: `LONG\u0007${"x".repeat(500)}` }],
  }));
  assert(overlong.nodes[0].name.length <= 80);
  assert.equal(overlong.nodes[0].name.includes("\u0007"), false);
  assert.equal(overlong.last_error.includes("/home/private"), false);
  assert.equal(overlong.last_error.includes(PROXY_FIXTURE_SECRET), false);
  assert.throws(() => sanitizeProxyStatus(null), TypeError);
});

test("代理源 sanitizer 丢弃原文、绝对路径、危险 display 和无效条目", () => {
  const raw = rawProxySources({
    subscriptions: [
      ...rawProxySources().subscriptions,
      { id: "bad-id", display_url: `https://bad/${PROXY_FIXTURE_SECRET}` },
    ],
    inline_nodes: [
      ...rawProxySources().inline_nodes,
      { id: "node_bad", node: PROXY_FIXTURE_SECRET },
    ],
  });
  const sanitized = sanitizeProxySources(raw);
  assert.equal(sanitized.subscriptions.length, 1);
  assert.equal(sanitized.inline_nodes.length, 1);
  assert.equal(sanitized.subscriptions[0].display_url, "https://provider.fixture.invalid:8443/…");
  assert.equal(sanitized.inline_nodes[0].display_endpoint, "vless://***@proxy.fixture.invalid:443#JP-01");
  assert.equal(sanitized.node_file.display_path, "路径已隐藏");
  assert.deepEqual(Object.keys(sanitized.subscriptions[0]).sort(), [
    "credentials_redacted", "display_url", "host", "id", "port", "scheme",
    "sensitive_parts_redacted", "source",
  ].sort());
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(PROXY_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("unknown_secret"), false);
  assert.equal(serialized.includes("/home/private"), false);
  assert.throws(() => sanitizeProxySources([]), TypeError);
});

test("代理 Store action 二次投影、克隆并保持 status/source selector 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let statusNotifications = 0;
  let sourceNotifications = 0;
  store.subscribe(selectors.proxyStatus, () => { statusNotifications += 1; });
  store.subscribe(selectors.proxySources, () => { sourceNotifications += 1; });

  const statusPayload = rawProxyStatus();
  store.dispatch(actionCreators.proxyStatusReceived(statusPayload));
  assert.equal(statusNotifications, 1);
  assert.equal(sourceNotifications, 0);
  statusPayload.nodes[0].name = PROXY_FIXTURE_SECRET;
  assert.equal(store.getState().proxy.status.nodes[0].name, "JP NODE");
  assert(Object.isFrozen(store.getState().proxy.status.nodes[0]));

  const sourcePayload = rawProxySources();
  store.dispatch(actionCreators.proxySourcesReceived(sourcePayload));
  assert.equal(statusNotifications, 1);
  assert.equal(sourceNotifications, 1);
  sourcePayload.subscriptions[0].host = PROXY_FIXTURE_SECRET;
  const stored = JSON.stringify(store.getState().proxy);
  assert.equal(stored.includes(PROXY_FIXTURE_SECRET), false);

  const directDispatch = createStore({ reportError: () => {} });
  directDispatch.dispatch({ type: "proxy/statusReceived", payload: rawProxyStatus() });
  directDispatch.dispatch({ type: "proxy/sourcesReceived", payload: rawProxySources() });
  assert.equal(directDispatch.getState().proxy.status.engine, "native");
  assert.equal(directDispatch.getState().proxy.sources.source, "runtime");
  assert.throws(() => store.dispatch(actionCreators.proxyStatusReceived(null)), TypeError);
  assert.throws(() => store.dispatch(actionCreators.proxySourcesReceived(null)), TypeError);
});

test("代理运行按钮矩阵覆盖停用、运行、租约、等待重载和 busy", () => {
  const unloaded = deriveProxyControls(null);
  assert.equal(unloaded.start.disabled, true);
  assert.equal(unloaded.refresh.disabled, false);

  const disabled = deriveProxyControls(controlStatus({ enabled: false }));
  assert.equal(disabled.start.disabled, true);
  assert.equal(disabled.reload.disabled, true);

  const stopped = deriveProxyControls(controlStatus());
  assert.equal(stopped.start.disabled, false);
  assert.equal(stopped.stop.disabled, true);
  assert.equal(stopped.reload.disabled, false);
  assert.equal(stopped.probe.disabled, true);

  const running = deriveProxyControls(controlStatus({ running: true, reload_required: false }));
  assert.equal(running.start.disabled, true);
  assert.equal(running.stop.disabled, false);
  assert.equal(running.reload.disabled, true);
  assert.match(running.reload.reason, /无需重新加载/);
  assert.equal(running.probe.disabled, false);

  const leased = deriveProxyControls(controlStatus({ running: true, leases: 3 }));
  assert.equal(leased.stop.disabled, true);
  assert.equal(leased.reload.disabled, true);
  assert.match(leased.stop.reason, /3 项正在使用代理/);
  assert.equal(leased.probe.disabled, false);

  const busy = deriveProxyControls(controlStatus({ running: true }), { busy: "probe" });
  assert.equal(Object.values(busy).every((item) => item.disabled), true);
  assert.equal(busy.probe.label, "正在检测…");
});

test("批量节点逐行构造 payload，formatter 不读取原始秘密字段", () => {
  assert.deepEqual(
    splitInlineNodeInput("  http://127.0.0.1:1#a  \r\n\n socks5://127.0.0.1:2#b \n"),
    ["http://127.0.0.1:1#a", "socks5://127.0.0.1:2#b"],
  );
  assert.throws(() => splitInlineNodeInput(null), TypeError);

  const sources = sanitizeProxySources(rawProxySources());
  const subscription = formatSubscriptionSource({
    ...sources.subscriptions[0],
    raw_url: PROXY_FIXTURE_SECRET,
  });
  const inline = formatInlineNodeSource({
    ...sources.inline_nodes[0],
    raw_node: PROXY_FIXTURE_SECRET,
  });
  const node = formatRuntimeNode({
    ...sanitizeProxyStatus(rawProxyStatus()).nodes[0],
    raw_endpoint: PROXY_FIXTURE_SECRET,
  }, 0);
  assert.equal(JSON.stringify({ subscription, inline, node }).includes(PROXY_FIXTURE_SECRET), false);
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, CONFIGURED_REVISION).relation, "已生效");
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, ACTIVE_REVISION).relation, "有更新");
});

test("409、422、413 与安全 index/reason 映射不回显 details 原文", () => {
  const conflict = proxyErrorGuidance({ code: "proxy_conflict", status: 409 });
  assert.match(conflict.nextStep, /正在使用代理的任务结束/);
  const invalid = proxyErrorGuidance({
    code: "invalid_proxy_inline_node",
    status: 422,
    details: { index: 2, reason: "unsupported_or_empty", raw: PROXY_FIXTURE_SECRET },
  });
  assert.match(invalid.detail, /第 3 行/);
  assert.match(invalid.detail, /unsupported_or_empty/);
  assert.equal(invalid.detail.includes(PROXY_FIXTURE_SECRET), false);
  assert.match(proxyErrorGuidance({ status: 413 }).nextStep, /减少/);
  assert.equal(
    safeProxyErrorDetail({ details: { index: 9999, reason: `bad ${PROXY_FIXTURE_SECRET}` } }),
    "",
  );
});

test("PROXY 应用暴露完整生命周期且端点白名单固定", () => {
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof proxyApplication[hook], "function");
  }
  assert.deepEqual(Object.values(PROXY_ENDPOINTS).sort(), [
    "/api/v1/proxy/probe",
    "/api/v1/proxy/reload",
    "/api/v1/proxy/sources",
    "/api/v1/proxy/sources/inline-nodes",
    "/api/v1/proxy/sources/node-file",
    "/api/v1/proxy/sources/override",
    "/api/v1/proxy/sources/subscriptions",
    "/api/v1/proxy/start",
    "/api/v1/proxy/status",
    "/api/v1/proxy/stop",
  ].sort());
});

const VAULT_FIXTURE_SECRET = "vault-fixture-cookie-token-password-7f3c1a";
const VAULT_SESSION_ID = "e".repeat(32);

function rawVaultSite(site, overrides = {}) {
  const definitions = {
    danbooru: {
      label: "Danbooru",
      method: "anonymous",
      state: "ready",
      authorized: true,
      actions: [],
    },
    twitter: {
      label: "X / Twitter",
      method: "managed_browser",
      state: "authorized",
      authorized: true,
      actions: ["managed_browser_login", "clear", `token=${VAULT_FIXTURE_SECRET}`],
      browser: "project_chrome",
      profile: "shared",
      updated_at: 1_700_000_000,
      cookies: {
        present: true,
        valid: true,
        cookie_count: 2,
        required_present: ["auth_token", "ct0"],
        raw_cookie: VAULT_FIXTURE_SECRET,
        updated_at: 1_700_000_000,
      },
      invalid_reason: `Cookie ${VAULT_FIXTURE_SECRET} in /home/private/cookies.txt`,
      login: null,
    },
    pixiv: {
      label: "Pixiv",
      method: "oauth",
      state: "required",
      authorized: false,
      actions: ["oauth", "clear"],
      browser: "project_chrome",
      profile: "shared",
      updated_at: null,
      oauth: null,
    },
    exhentai: {
      label: "EH",
      method: "managed_browser",
      state: "required",
      authorized: false,
      actions: ["managed_browser_login", "clear"],
      cookies: {
        present: false,
        valid: false,
        cookie_count: 0,
        missing: ["ipb_member_id", "ipb_pass_hash"],
      },
      login: null,
    },
    pawchive: {
      label: "Pawchive",
      method: "anonymous",
      state: "ready",
      authorized: true,
      actions: [],
    },
  };
  return {
    site,
    summary: `https://user:${VAULT_FIXTURE_SECRET}@private.invalid/path?token=${VAULT_FIXTURE_SECRET}`,
    authorization: `Bearer ${VAULT_FIXTURE_SECRET}`,
    ...definitions[site],
    ...overrides,
  };
}

function rawVaultSnapshot(overrides = {}) {
  return {
    items: [
      rawVaultSite("danbooru"),
      rawVaultSite("twitter"),
      rawVaultSite("pixiv"),
      rawVaultSite("exhentai"),
      rawVaultSite("pawchive"),
      {
        site: "unknown",
        method: "token",
        password: VAULT_FIXTURE_SECRET,
      },
    ],
    browser_profile: {
      shared: true,
      present: true,
      running: false,
      resetting: false,
      path: `/home/private/${VAULT_FIXTURE_SECRET}`,
      sites: ["twitter", "pixiv", "exhentai"],
    },
    authorization_proxy: {
      proxy_url: "http://***@proxy.fixture.invalid:7890",
      source: "runtime",
      config_proxy_url: `http://user:${VAULT_FIXTURE_SECRET}@config.invalid:7890`,
      browser_proxy_url: `http://user:${VAULT_FIXTURE_SECRET}@browser.invalid:7890`,
      credentials_redacted: true,
      browser_running: false,
      restart_pending: false,
      updated_at: 1_700_000_100,
      password: VAULT_FIXTURE_SECRET,
    },
    managed: true,
    secrets_exposed: false,
    response_profile: "vault",
    raw_request: { token: VAULT_FIXTURE_SECRET },
    ...overrides,
  };
}

function vaultSnapshotWithActivePixiv() {
  const raw = rawVaultSnapshot();
  raw.items[2] = rawVaultSite("pixiv", {
    state: "authorizing",
    oauth: {
      session_id: VAULT_SESSION_ID,
      state: "awaiting_login",
      created_at: 1_700_000_000,
      expires_at: 1_700_000_600,
      authorization_url: `https://app-api.pixiv.net/web/v1/login?state=${VAULT_FIXTURE_SECRET}`,
      message: `token=${VAULT_FIXTURE_SECRET}`,
      error: `/home/private/${VAULT_FIXTURE_SECRET}`,
    },
  });
  return raw;
}

function mutableVaultSnapshot(sanitized) {
  return {
    bySite: new Map(sanitized.bySite),
    browserProfile: sanitized.browserProfile,
    authorizationProxy: sanitized.authorizationProxy,
  };
}

test("VAULT sanitizer 严格丢弃 Cookie、Token、路径、完整 URL 与未知目标", () => {
  const sanitized = sanitizeVaultStatus(vaultSnapshotWithActivePixiv());
  assert.deepEqual([...sanitized.bySite.keys()], [
    "danbooru", "twitter", "pixiv", "exhentai", "pawchive",
  ]);
  assert.equal(sanitized.bySite.get("twitter").cookieCount, 2);
  assert.equal(sanitized.bySite.get("pixiv").session.active, true);
  assert.equal(sanitized.authorizationProxy.displayEndpoint, "HTTP · proxy.fixture.invalid:7890");
  assert.deepEqual(Object.keys(sanitized.authorizationProxy).sort(), [
    "browserRunning", "configured", "credentialsRedacted", "direct", "displayEndpoint",
    "restartPending", "scheme", "source", "updatedAt", "valid",
  ].sort());
  const serialized = JSON.stringify({
    sites: [...sanitized.bySite.values()],
    profile: sanitized.browserProfile,
    proxy: sanitized.authorizationProxy,
  });
  for (const forbidden of [
    VAULT_FIXTURE_SECRET,
    "authorization_url",
    "raw_cookie",
    "invalid_reason",
    "/home/private",
    "Bearer ",
    "?token=",
    "config_proxy_url",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.throws(
    () => sanitizeVaultStatus(rawVaultSnapshot({ secrets_exposed: true })),
    TypeError,
  );
  assert.throws(() => sanitizeVaultStatus([]), TypeError);
});

test("VAULT sanitizer 防御控制字符、超长值、错误枚举和伪装代理凭据", () => {
  const raw = rawVaultSnapshot();
  raw.items[1] = rawVaultSite("twitter", {
    method: "password",
    state: `authorized\u0000${VAULT_FIXTURE_SECRET}`,
    label: VAULT_FIXTURE_SECRET.repeat(20),
  });
  raw.authorization_proxy.proxy_url = `https://user:${VAULT_FIXTURE_SECRET}@proxy.invalid:443`;
  const sanitized = sanitizeVaultStatus(raw);
  assert.equal(sanitized.bySite.has("twitter"), false);
  assert.equal(sanitized.authorizationProxy.valid, false);
  assert.equal(sanitized.authorizationProxy.configured, false);
  assert.equal(JSON.stringify(sanitized.authorizationProxy).includes(VAULT_FIXTURE_SECRET), false);

  const fallback = sanitizeVaultSiteStatus(rawVaultSite("exhentai", {
    state: "remote_verified",
    updated_at: Number.POSITIVE_INFINITY,
    cookies: { present: true, valid: false, cookie_count: 999_999_999 },
    login: { session_id: VAULT_FIXTURE_SECRET, state: "awaiting_login" },
  }));
  assert.equal(fallback.state, "required");
  assert.equal(fallback.cookieCount, 100_000);
  assert.equal(fallback.updatedAt, null);
  assert.equal(fallback.session.active, false);
});

test("VAULT Store action 只接收安全投影并保持 selector 与其他 slice 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let sitesNotifications = 0;
  let profileNotifications = 0;
  let proxyNotifications = 0;
  store.subscribe(selectors.authSites, () => { sitesNotifications += 1; });
  store.subscribe(selectors.authBrowserProfile, () => { profileNotifications += 1; });
  store.subscribe(selectors.authAuthorizationProxy, () => { proxyNotifications += 1; });

  const raw = rawVaultSnapshot();
  store.dispatch(actionCreators.authStatusReceived(raw));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [1, 1, 1],
  );
  raw.items[1].cookies.raw_cookie = "mutated-secret";
  const stored = store.getState().auth;
  assert.equal(JSON.stringify([...stored.bySite.values()]).includes(VAULT_FIXTURE_SECRET), false);
  assert.throws(() => stored.bySite.set("other", {}), TypeError);

  store.dispatch(actionCreators.shellSummaryUpdated(shellSnapshot()));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [1, 1, 1],
  );
  store.dispatch(actionCreators.authSiteStatusReceived(rawVaultSite("twitter", {
    state: "required",
    authorized: false,
    cookies: { present: false, valid: false, cookie_count: 0 },
  })));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [2, 1, 1],
  );
  assert.throws(
    () => store.dispatch({ type: "auth/statusReceived", payload: rawVaultSnapshot() }),
    TypeError,
  );
});

test("授权代理 payload builder 只产生当前字段并严格拒绝路径、query、控制字符和超长输入", () => {
  assert.deepEqual(buildAuthorizationProxyPayload(""), { proxy_url: "" });
  const secretProxy = `https://user:${VAULT_FIXTURE_SECRET}@proxy.fixture.invalid:8443`;
  const payload = buildAuthorizationProxyPayload(secretProxy);
  assert.deepEqual(Object.keys(payload), ["proxy_url"]);
  assert.equal(payload.proxy_url, secretProxy);
  assert.equal("old_secret" in payload, false);

  for (const invalid of [
    "/home/private/proxy.txt",
    "file:///home/private/proxy.txt",
    `https://proxy.invalid:443/path?token=${VAULT_FIXTURE_SECRET}`,
    `https://proxy.invalid:443#${VAULT_FIXTURE_SECRET}`,
    "http://proxy.invalid",
    "socks5://user:pass@proxy.invalid:1080",
    `http://proxy.invalid:8080\n${VAULT_FIXTURE_SECRET}`,
    `http://${"a".repeat(301)}:8080`,
  ]) {
    assert.equal(validateAuthorizationProxyInput(invalid).valid, false, invalid.slice(0, 60));
    assert.throws(() => buildAuthorizationProxyPayload(invalid), TypeError);
  }
  const validation = validateAuthorizationProxyInput(secretProxy);
  assert.deepEqual(validation, { valid: true, mode: "proxy", error: "" });
  assert.equal(JSON.stringify(validation).includes(VAULT_FIXTURE_SECRET), false);
  assert.throws(() => buildAuthorizationProxyPayload({ proxy_url: secretProxy }), TypeError);
});

test("VAULT 按钮矩阵覆盖未加载、公开目标、活动会话、配置材料与 busy", () => {
  const loaded = mutableVaultSnapshot(sanitizeVaultStatus(rawVaultSnapshot()));
  let controls = deriveVaultControls(loaded, { proxyInputValid: true });
  assert.equal(controls.sites.danbooru.showAuthorize, false);
  assert.equal(controls.sites.twitter.authorize.disabled, false);
  assert.equal(controls.sites.twitter.clear.disabled, false);
  assert.equal(controls.sites.twitter.showClear, true);
  assert.equal(controls.sites.exhentai.showClear, false);
  assert.equal(controls.profileClear.disabled, false);
  assert.equal(controls.proxySave.disabled, false);
  assert.equal(controls.proxyReset.disabled, false);

  controls = deriveVaultControls(loaded, { proxyInputValid: false });
  assert.equal(controls.proxySave.disabled, true);
  assert.match(controls.proxySave.reason, /修正/);

  const active = mutableVaultSnapshot(sanitizeVaultStatus(vaultSnapshotWithActivePixiv()));
  controls = deriveVaultControls(active);
  assert.equal(controls.sites.pixiv.showCancel, true);
  assert.equal(controls.sites.pixiv.cancel.disabled, false);
  assert.equal(controls.sites.twitter.authorize.disabled, true);
  assert.match(controls.sites.twitter.authorize.reason, /Pixiv/);
  assert.equal(controls.profileClear.disabled, true);

  controls = deriveVaultControls(active, { busy: "cancel:pixiv" });
  assert.equal(controls.sites.pixiv.cancel.label, "正在关闭…");
  assert.equal(controls.refresh.disabled, true);
  assert.equal(controls.proxySave.disabled, true);
});

test("VAULT 请求世代门阻止旧读取覆盖新读取、写后状态与新生命周期", () => {
  const gate = createVaultRequestGate();
  let visible = "初始状态";
  const apply = (ticket, value) => {
    if (gate.isReadCurrent(ticket)) visible = value;
  };

  const firstStatus = gate.beginRead("status");
  const session = gate.beginRead("session");
  assert.equal(gate.isReadCurrent(firstStatus), true);
  assert.equal(gate.isReadCurrent(session), true);

  const newestStatus = gate.beginRead("status");
  apply(newestStatus, "较新读取");
  apply(firstStatus, "过期读取");
  assert.equal(visible, "较新读取");
  assert.equal(gate.isReadCurrent(session), true, "独立会话通道不应被状态读取误伤");

  const preWrite = gate.beginRead("status");
  gate.beginWrite();
  apply(preWrite, "写前旧读取");
  assert.equal(visible, "较新读取");
  const postWrite = gate.beginRead("status");
  apply(postWrite, "写后读取");
  assert.equal(visible, "写后读取");

  gate.advanceLifecycle();
  apply(postWrite, "旧生命周期读取");
  assert.equal(visible, "写后读取");
  assert.equal(Object.isFrozen(postWrite), true);
  assert.throws(() => gate.beginRead("credentials"), /未知授权请求通道/);
});

test("VAULT formatter 与错误模型不采用绝对路径、URL 凭据、原始 details 或秘密文本", () => {
  const sanitized = sanitizeVaultStatus(vaultSnapshotWithActivePixiv());
  const site = formatVaultSite({
    ...sanitized.bySite.get("twitter"),
    summary: VAULT_FIXTURE_SECRET,
    path: `/home/${VAULT_FIXTURE_SECRET}`,
  });
  const proxy = formatAuthorizationProxy({
    ...sanitized.authorizationProxy,
    raw_url: `https://user:${VAULT_FIXTURE_SECRET}@private.invalid:443/path`,
  });
  const error = vaultErrorGuidance({
    code: "pixiv_oauth_exchange_failed",
    status: 409,
    message: `token=${VAULT_FIXTURE_SECRET}`,
    requestId: "vault-request-123",
    details: { path: `/home/${VAULT_FIXTURE_SECRET}`, cookie: VAULT_FIXTURE_SECRET },
  });
  const serialized = JSON.stringify({ site, proxy, error });
  assert.equal(serialized.includes(VAULT_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("/home/"), false);
  assert.equal(serialized.includes("user:"), false);
  assert.equal(error.requestId, "vault-request-123");
  assert.match(error.nextStep, /重新授权/);
  assert.equal(vaultErrorGuidance({ status: 413 }).code, "request_failed");
  assert.match(vaultErrorGuidance({ status: 413 }).title, /请求过大/);
  assert.match(vaultErrorGuidance({ code: "network_error" }).nextStep, /刷新授权状态/);
});

test("VAULT 会话引用仅保留受控目标与 opaque id，不携带完整授权 URL", () => {
  const raw = vaultSnapshotWithActivePixiv();
  const reference = extractVaultSessionFromSnapshot(raw);
  assert.deepEqual(reference, {
    site: "pixiv",
    kind: "oauth",
    sessionId: VAULT_SESSION_ID,
  });
  assert.equal(JSON.stringify(reference).includes(VAULT_FIXTURE_SECRET), false);
  raw.items[2].oauth.session_id = `../${VAULT_FIXTURE_SECRET}`;
  assert.equal(extractVaultSessionFromSnapshot(raw), null);
});

test("VAULT 应用暴露完整生命周期、固定 auth 端点与单一授权轮询资源", () => {
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof vaultApplication[hook], "function");
  }
  assert.deepEqual(Object.values(VAULT_ENDPOINTS).sort(), [
    "/api/v1/auth",
    "/api/v1/auth/browser-profile",
    "/api/v1/auth/pixiv/oauth/session",
    "/api/v1/auth/pixiv/oauth/start",
    "/api/v1/auth/proxy",
  ].sort());
});

const POLICY_FIXTURE_SECRET = "policy-fixture-cookie-token-password-83b1";

function rawPolicy(overrides = {}) {
  return {
    max_concurrency: 20,
    retry_limit: 2,
    backoff_base_seconds: 2,
    proxy_mode: "prefer",
    ...overrides,
  };
}

const POLICY_SOURCE_DEFINITIONS = [
  ["danbooru", "Danbooru", "anonymous"],
  ["twitter", "X / Twitter", "managed_browser"],
  ["pixiv", "Pixiv", "oauth"],
  ["exhentai", "EH", "managed_browser_for_private_content"],
  ["pawchive", "Pawchive", "anonymous"],
];

function rawPolicySnapshot(overrides = {}) {
  const policy = rawPolicy();
  return {
    response_profile: "policy",
    secrets_exposed: false,
    effect_scope: "new_requests_and_tasks",
    concurrency_protection: "none",
    default_source: "startup_snapshot",
    persistence: "sqlite_atomic",
    default: { editable: true, reason: "", policy },
    items: POLICY_SOURCE_DEFINITIONS.map(([site, label, authorization]) => ({
      site,
      label,
      supported: true,
      authorization,
      selection_mode: "per_request",
      availability: "not_probed",
      inherited: true,
      has_override: false,
      editable: true,
      reason: "",
      updated_at: null,
      policy: { ...policy },
    })),
    unknown_override_count: 0,
    ...overrides,
  };
}

function serializedPolicySnapshot(snapshot) {
  return JSON.stringify({
    defaultPolicy: snapshot.defaultPolicy,
    sites: [...snapshot.bySite.values()],
    effectScope: snapshot.effectScope,
    unknownOverrideCount: snapshot.unknownOverrideCount,
  });
}

test("POLICY sanitizer 只采用四字段、固定五站并丢弃未知或危险响应", () => {
  const raw = rawPolicySnapshot();
  raw.unknown_secret = POLICY_FIXTURE_SECRET;
  raw.default.policy.request_body = { token: POLICY_FIXTURE_SECRET };
  raw.items.push({
    site: "unknown",
    label: POLICY_FIXTURE_SECRET,
    policy: { path: `/home/${POLICY_FIXTURE_SECRET}` },
  });
  raw.items[1].policy = rawPolicy({
    extra_args: [`token=${POLICY_FIXTURE_SECRET}`],
  });
  const sanitized = sanitizePolicyResponse(raw);
  assert.deepEqual([...sanitized.bySite.keys()], [
    "danbooru", "twitter", "pixiv", "exhentai", "pawchive",
  ]);
  assert.equal(sanitized.defaultPolicy, null);
  assert.equal(sanitized.bySite.get("twitter").editable, false);
  assert.equal(sanitized.bySite.get("twitter").policy, null);
  assert.equal(sanitized.unknownOverrideCount, 1);
  const serialized = serializedPolicySnapshot(sanitized);
  for (const forbidden of [
    POLICY_FIXTURE_SECRET,
    "unknown_secret",
    "request_body",
    "extra_args",
    "/home/",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const polluted = JSON.parse(JSON.stringify(rawPolicySnapshot()).replace(
    '"response_profile":"policy"',
    `"__proto__":{"polluted":"${POLICY_FIXTURE_SECRET}"},"response_profile":"policy"`,
  ));
  assert.throws(() => sanitizePolicyResponse(polluted), TypeError);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => sanitizePolicyResponse(rawPolicySnapshot({ secrets_exposed: true })),
    TypeError,
  );
});

test("POLICY source 枚举固定，缺失或能力不匹配来源变为只读且不猜测", () => {
  const raw = rawPolicySnapshot();
  raw.items = raw.items.filter((item) => item.site !== "pawchive");
  raw.items.find((item) => item.site === "pixiv").authorization = "password";
  const sanitized = sanitizePolicyResponse(raw);
  assert.equal(sanitized.bySite.size, 5);
  assert.equal(sanitized.bySite.get("pawchive").editable, false);
  assert.equal(sanitized.bySite.get("pawchive").reason, "missing_source");
  assert.equal(sanitized.bySite.get("pixiv").editable, false);
  assert.equal(sanitized.bySite.get("pixiv").reason, "missing_source");
  assert.equal(sanitized.unknownOverrideCount, 1);
  assert.equal(
    formatPolicySource(sanitized.bySite.get("exhentai")).policyState,
    "使用默认设置",
  );
  assert.equal(
    formatPolicySource(sanitized.bySite.get("pixiv")).badge.label,
    "暂时无法设置",
  );
});

test("POLICY payload builder 只包含四个可设置字段并覆盖安全范围", () => {
  const draft = policyConfigToDraft(rawPolicy());
  Object.assign(draft, {
    max_concurrency: "128",
    retry_limit: "0",
    backoff_base_seconds: "0",
    proxy_mode: "required",
  });
  const payload = buildPolicyPayload(draft);
  assert.deepEqual(Object.keys(payload), [
    "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode",
  ]);
  assert.deepEqual(payload, {
    max_concurrency: 128,
    retry_limit: 0,
    backoff_base_seconds: 0,
    proxy_mode: "required",
  });

  for (const [changes, field, reason] of [
    [{ max_concurrency: "129" }, "max_concurrency", "out_of_range"],
    [{ retry_limit: "1.5" }, "retry_limit", "not_integer"],
    [{ backoff_base_seconds: "3600.1" }, "backoff_base_seconds", "out_of_range"],
    [{ proxy_mode: "auto" }, "proxy_mode", "invalid_enum"],
    [{ probe_url: `https://${POLICY_FIXTURE_SECRET}.invalid/` }, "policy", "unknown_field"],
  ]) {
    const validation = validatePolicyDraft({ ...draft, ...changes });
    assert.equal(validation.valid, false);
    assert.equal(validation.field, field);
    assert.equal(validation.reason, reason);
    assert.equal(validation.payload, null);
  }
});

test("POLICY dirty 比较只看规范化四字段且不受键顺序影响", () => {
  const current = rawPolicy();
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  assert.equal(policyConfigsEqual(current, reordered), true);
  const draft = policyConfigToDraft(current);
  assert.equal(isPolicyDirty(current, draft), false);
  draft.backoff_base_seconds = "2.5";
  assert.equal(isPolicyDirty(current, draft), true);
  draft.backoff_base_seconds = "not-a-number";
  assert.equal(isPolicyDirty(current, draft), true);
});

test("POLICY 保存、恢复、busy 与只读按钮矩阵准确", () => {
  const item = sanitizePolicyResponse(rawPolicySnapshot()).bySite.get("pixiv");
  let controls = derivePolicyControls(item, { dirty: false, valid: true });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, true);
  assert.deepEqual(Object.keys(controls), ["save", "reset", "siteSelect"]);

  controls = derivePolicyControls({ ...item, hasOverride: true, inherited: false }, {
    dirty: true,
    valid: true,
  });
  assert.equal(controls.save.disabled, false);
  assert.equal(controls.reset.disabled, false);
  assert.equal(controls.save.label, "保存设置");
  assert.equal(controls.reset.label, "恢复默认设置");

  controls = derivePolicyControls(item, { dirty: true, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, false, "未保存草稿可恢复默认设置");
  assert.match(controls.save.reason, /修正/);
  controls = derivePolicyControls(item, { dirty: true, valid: true, busy: "save" });
  assert.equal(Object.values(controls).every((control) => control.disabled), true);
  assert.equal(controls.save.label, "正在保存…");

  const readOnly = {
    ...item,
    editable: false,
    policy: null,
    reason: "unsafe_stored_policy",
    hasOverride: true,
    inherited: false,
  };
  controls = derivePolicyControls(readOnly, { dirty: false, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, false);
});

test("POLICY 安全错误映射只采用四字段、原因与 request id 白名单", () => {
  const error = {
    code: "invalid_policy",
    status: 422,
    requestId: "policy-request-123",
    message: `token=${POLICY_FIXTURE_SECRET}`,
    details: {
      field: "backoff_base_seconds",
      reason: "less_than_equal",
      raw: `/home/${POLICY_FIXTURE_SECRET}`,
    },
  };
  const guidance = policyErrorGuidance(error);
  assert.equal(guidance.requestId, "policy-request-123");
  assert.match(guidance.detail, /首次重试等待/);
  assert.match(guidance.detail, /超过允许范围/);
  assert.equal(JSON.stringify(guidance).includes(POLICY_FIXTURE_SECRET), false);
  assert.equal(safePolicyErrorDetail({ details: { field: "secret", raw: POLICY_FIXTURE_SECRET } }), "");
  assert.match(policyErrorGuidance({ status: 413 }).title, /太大/);
  assert.equal(policyErrorGuidance({ status: 409 }).conflict, true);
  assert.match(policyErrorGuidance({ code: "network_error" }).nextStep, /服务正在运行/);
});

test("POLICY Store action 二次投影、不可变且与 auth/proxy selector 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let policyNotifications = 0;
  let authNotifications = 0;
  let proxyNotifications = 0;
  store.subscribe(selectors.policyConfig, () => { policyNotifications += 1; });
  store.subscribe(selectors.authSites, () => { authNotifications += 1; });
  store.subscribe(selectors.proxyStatus, () => { proxyNotifications += 1; });

  const raw = rawPolicySnapshot();
  store.dispatch(actionCreators.policyConfigReceived(raw));
  assert.deepEqual([policyNotifications, authNotifications, proxyNotifications], [1, 0, 0]);
  raw.items[0].policy.max_concurrency = 99;
  const stored = store.getState().policy.config;
  assert.equal(stored.bySite.get("danbooru").policy.max_concurrency, 20);
  assert.equal(serializedPolicySnapshot(stored).includes(POLICY_FIXTURE_SECRET), false);
  assert.throws(() => stored.bySite.set("unknown", {}), TypeError);
  assert.throws(() => {
    stored.bySite.get("pixiv").policy.max_concurrency = 99;
  }, TypeError);

  store.dispatch(actionCreators.shellSummaryUpdated(shellSnapshot()));
  assert.deepEqual([policyNotifications, authNotifications, proxyNotifications], [1, 0, 0]);
  assert.throws(
    () => store.dispatch({ type: "policy/configReceived", payload: rawPolicySnapshot() }),
    TypeError,
  );
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(
    () => store.dispatch({ type: "policy/configReceived", payload: dangerous }),
    /危险对象键/,
  );
  assert.equal({}.polluted, undefined);
});

test("POLICY 请求世代门阻止旧 GET 覆盖保存后状态与新生命周期", () => {
  const gate = createPolicyRequestGate();
  let visible = "初始";
  const apply = (ticket, value) => {
    if (gate.isReadCurrent(ticket)) visible = value;
  };
  const first = gate.beginRead();
  const second = gate.beginRead();
  apply(second, "较新读取");
  apply(first, "过期读取");
  assert.equal(visible, "较新读取");
  const beforeWrite = gate.beginRead();
  gate.beginWrite();
  apply(beforeWrite, "写前读取");
  assert.equal(visible, "较新读取");
  const afterWrite = gate.beginRead();
  apply(afterWrite, "写后权威读取");
  gate.advanceLifecycle();
  apply(afterWrite, "旧生命周期读取");
  assert.equal(visible, "写后权威读取");
});

test("POLICY 应用保留离开确认生命周期、单一端点且没有轮询资源", () => {
  for (const hook of [
    "mount", "activate", "beforeLeave", "beforeWindowHide", "deactivate", "unmount",
  ]) {
    assert.equal(typeof policyApplication[hook], "function");
  }
  assert.deepEqual(POLICY_ENDPOINTS, {
    policies: "/api/v1/sites/policies",
  });
});

const WORKFLOW_SECRET = "workflow-token-cookie-secret-991425f1c4";

function rawSearchWorkflow() {
  return {
    keyword: "不应进入 Store 的查询",
    sources: [{
      site: "exhentai",
      status: "succeeded",
      evidence_count: 1,
      attempts: 1,
      auth: { state: "required", authorized: false, cookie: WORKFLOW_SECRET },
      addresses: [{
        id: "3079340",
        label: "安全画廊标题",
        address_type: "gallery",
        url: `https://e-hentai.org/g/3079340/${WORKFLOW_SECRET}/`,
        confidence: "site_search",
        thumbnail_url: "https://ehgt.org/w/cover.webp",
        metadata: {
          gallery_token: WORKFLOW_SECRET,
          tags: ["artist:fixture", "language:chinese"],
        },
      }],
      weak_evidence: [],
      tag_facets: [{
        namespace: "artist",
        label: "画师",
        gallery_count: 1,
        tags: [{ tag: "artist:fixture", count: 1 }],
      }],
      request_payload: { token: WORKFLOW_SECRET },
    }],
    related_profiles: [],
    raw: WORKFLOW_SECRET,
  };
}

test("CRAWL 来源错误消息按纯文本投影、限长并兼容缺失消息", () => {
  const malicious = '<img src=x onerror="globalThis.compromised=true">';
  const projected = projectCrawlSearchResponse({
    sources: [{
      site: "exhentai",
      status: "failed",
      attempts: 2,
      error: { code: "discovery_failed", message: malicious },
      addresses: [],
    }],
  });
  const source = projected.snapshot.sources[0];
  assert.equal(source.errorCode, "discovery_failed");
  assert.equal(source.errorMessage, malicious);

  const long = projectCrawlSearchResponse({
    sources: [{
      site: "pixiv",
      status: "failed",
      error: { code: "extractor_error", message: "x".repeat(900) },
      addresses: [],
    }],
  }).snapshot.sources[0];
  assert.equal(long.errorMessage.length, 500);

  const compatible = projectCrawlSearchResponse({
    sources: [{
      site: "twitter",
      status: "failed",
      error: { code: "authentication" },
      addresses: [],
    }],
  }).snapshot.sources[0];
  assert.equal(compatible.errorMessage, "");

  const previousDocument = globalThis.document;
  let innerHtmlWrites = 0;
  globalThis.document = {
    createElement(tagName) {
      return {
        tagName,
        className: "",
        dataset: {},
        value: "",
        _textContent: "",
        set textContent(value) { this._textContent = String(value); },
        get textContent() { return this._textContent; },
        set innerHTML(_value) { innerHtmlWrites += 1; },
        setAttribute() {},
        append() {},
      };
    },
  };
  try {
    const warning = createSourceErrorWarning(source);
    assert.equal(warning.textContent.includes(malicious), true);
    assert.equal(innerHtmlWrites, 0);
    assert.equal(
      createSourceErrorWarning(compatible).textContent,
      "来源搜索失败（authentication）。请检查授权或代理后重试。",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("CRAWL happy path 保持真实顺序与幂等提交，同时秘密地址只留在局部映射", () => {
  const projected = projectCrawlSearchResponse(rawSearchWorkflow());
  assert.equal(projected.snapshot.sources.length, 1);
  assert.equal(projected.snapshot.addressCount, 1);
  assert.equal(JSON.stringify(projected.snapshot).includes(WORKFLOW_SECRET), false);
  const candidate = projected.snapshot.sources[0].addresses[0];
  assert.match(candidate.displayEndpoint, /访问令牌已隐藏/);
  assert.equal(projected.operations.get(candidate.key).url.includes(WORKFLOW_SECRET), true);

  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.crawlSearchReceived(rawSearchWorkflow()));
  store.dispatch(actionCreators.crawlCandidateSelectionChanged(candidate.key, true));
  assert.equal(JSON.stringify(store.getState().crawl).includes(WORKFLOW_SECRET), false);
  const payload = buildCrawlPayload({
    snapshot: store.getState().crawl,
    operations: projected.operations,
    concurrency: 20,
    maxTasks: 10000,
    proxyMode: "required",
    ehDownload: { image_mode: "original", gp_policy: "stop" },
  });
  assert.deepEqual(Object.keys(payload), ["sources", "concurrency", "max_tasks", "proxy_mode"]);
  assert.equal(payload.sources[0].site, "exhentai");
  assert.equal(payload.sources[0].addresses[0].url.includes(WORKFLOW_SECRET), true);
  assert.deepEqual(payload.sources[0].eh_download, { image_mode: "original", gp_policy: "stop" });

  assert.deepEqual(buildSearchPayload({
    keyword: "fixture",
    sites: ["pixiv", "danbooru"],
    limit: 20,
    proxyMode: "prefer",
    sourceOptions: { pixiv: { proxy_mode: "direct" } },
  }), {
    keyword: "fixture",
    sites: ["danbooru", "pixiv"],
    limit: 20,
    proxy_mode: "prefer",
    source_options: { pixiv: { proxy_mode: "direct" } },
  });
  assert.equal(parseEhTag("a:Fixture").key, "artist:fixture");
  assert.equal(candidateMatchesEhFilter(candidate, new Map([["artist:fixture", "include"]])), true);
  assert.equal(candidateMatchesEhFilter(candidate, new Map([["language:english", "include"]])), false);
  assert.deepEqual(sanitizeAutocompleteResponse({
    items: [{ value: "fixture", label: "Fixture", category: "artist", token: WORKFLOW_SECRET }],
  }), [{ value: "fixture", label: "Fixture", category: "artist", antecedent: "", postCount: 0 }]);
  assert.deepEqual(CRAWL_ENDPOINTS, {
    search: "/api/v1/search",
    autocomplete: "/api/v1/search/autocomplete",
    crawls: "/api/v1/crawls",
  });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof crawlApplication[hook], "function");
  }
});

function rawBatchWorkflow() {
  return {
    id: "batch-123",
    status: "running",
    output_dir: `/home/private/${WORKFLOW_SECRET}`,
    concurrency: 20,
    max_tasks: 10000,
    task_count: 2,
    succeeded_task_count: 1,
    failed_task_count: 0,
    cancelled_task_count: 0,
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      addresses: [{
        id: "address-1",
        address_order: 0,
        label: "画师作品",
        url: `https://example.invalid/?token=${WORKFLOW_SECRET}`,
        status: "running",
        planned_task_count: 2,
        succeeded_task_count: 1,
      }],
    }],
    current: { address_id: "address-1", site: "pixiv", status: "running" },
    review: null,
  };
}

test("TASKMGR happy path 安全投影任务并识别恢复入口", () => {
  const batch = sanitizeBatchDetail(rawBatchWorkflow());
  const page = sanitizeTaskPage({ items: [{
    id: "task-1",
    site: "pixiv",
    status: "failed",
    source_order: 0,
    address_order: 0,
    sequence_no: 1,
    attempt_count: 1,
    max_attempts: 3,
    url: `https://private.invalid/?token=${WORKFLOW_SECRET}`,
    output_dir: `/home/private/${WORKFLOW_SECRET}`,
    cookies_file: `/home/private/${WORKFLOW_SECRET}.txt`,
    error_class: "authentication",
    error_message: WORKFLOW_SECRET,
  }] }, batch.id);
  assert.equal(JSON.stringify({ batch, page }).includes(WORKFLOW_SECRET), false);
  assert.equal(shouldPollBatch(batch), true);
  assert.deepEqual(batchProgress(batch), { terminal: 1, total: 2, percent: 50 });
  assert.deepEqual(taskRecoveryTargets(page.tasks), { authSites: ["pixiv"], proxyIssue: false });
  assert.deepEqual(sanitizeRecentBatches({ items: [rawBatchWorkflow()] })[0].id, "batch-123");
  assert.deepEqual(TASKS_ENDPOINTS, { crawls: "/api/v1/crawls" });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof tasksApplication[hook], "function");
  }
});

function rawReviewWorkflow() {
  return {
    batch_id: "batch-123",
    status: "ready",
    total_image_count: 2,
    total_group_count: 1,
    duplicate_group_count: 1,
    selected_image_count: 2,
    decided_group_count: 0,
    groups: {
      total: 1,
      offset: 0,
      limit: 1,
      items: [{
        id: "group-1",
        ordinal: 1,
        kind: "duplicate",
        decided: false,
        match_levels: ["L2"],
        images: [
          {
            id: "image-1",
            ordinal: 1,
            relative_path: `private/${WORKFLOW_SECRET}.jpg`,
            url: `/api/private?token=${WORKFLOW_SECRET}`,
            readable: true,
            recommended: true,
            selected: true,
            metadata: { w: 100, h: 100, format: "JPEG", size: 1024 },
          },
          {
            id: "image-2",
            ordinal: 2,
            relative_path: `/home/private/${WORKFLOW_SECRET}.jpg`,
            readable: true,
            recommended: false,
            selected: true,
            metadata: { w: 80, h: 80, format: "PNG", size: 512 },
          },
        ],
      }],
    },
    analysis_log_path: `/home/private/${WORKFLOW_SECRET}.log`,
    error: `private error ${WORKFLOW_SECRET}`,
    details: { traceback: `/home/private/${WORKFLOW_SECRET}.trace` },
  };
}

test("REVIEW deck 自动推进只在全量数组中前进并识别完成边缘", () => {
  assert.deepEqual(deckAdvanceTarget({
    focusedIndex: 3, groupCount: 16,
  }), { type: "group", index: 4 });
  assert.deepEqual(deckAdvanceTarget({
    focusedIndex: 15, groupCount: 16,
  }), { type: "complete" });
  assert.deepEqual(deckAdvanceTarget({
    focusedIndex: 0, groupCount: 1,
  }), { type: "complete" });
  assert.deepEqual(deckAdvanceTarget({
    focusedIndex: 0, groupCount: 0,
  }), { type: "complete" });
});

test("REVIEW 完成态由权威总组数区分筛选结束与整批完成", () => {
  const filtered = reviewCompletionPresentation({
    totalGroupCount: 261,
    decidedGroupCount: 53,
    totalImageCount: 455,
    selectedImageCount: 247,
    automaticRejectedImageCount: 8,
  }, "duplicate");
  assert.equal(filtered.batchComplete, false);
  assert.equal(filtered.title, "当前筛选已过一遍");
  assert.match(filtered.message, /重复组.*仍有 208 组未确认.*切换顶部筛选/);
  assert.doesNotMatch(filtered.operationMessage, /本批次已完成/);

  const complete = reviewCompletionPresentation({
    totalGroupCount: 261,
    decidedGroupCount: 261,
    totalImageCount: 455,
    selectedImageCount: 247,
    automaticRejectedImageCount: 8,
  }, "");
  assert.equal(complete.batchComplete, true);
  assert.equal(complete.title, "本批次已全部过一遍");
  assert.match(complete.message, /自动移除 8 张.*最终保留 247 张.*预计移出 208 张/);
  assert.match(complete.operationMessage, /本批次已完成复核/);
  assert.throws(() => reviewCompletionPresentation(null, "duplicate"), TypeError);
  assert.throws(() => reviewCompletionPresentation({}, "unsafe"), TypeError);
});

test("REVIEW deck 快捷键按可编辑性、图片与镜片可用性解析", () => {
  const browseImages = { editable: false, hasImages: true, loupeAvailable: false };
  for (const [key, command] of [
    ["ArrowLeft", "focus-previous-image"],
    ["ArrowUp", "focus-previous-image"],
    ["ArrowRight", "focus-next-image"],
    ["ArrowDown", "focus-next-image"],
  ]) {
    assert.equal(resolveDeckCommand(key, browseImages), command, key);
    assert.equal(resolveDeckCommand(key, { ...browseImages, editable: true }), command, key);
  }
  assert.equal(resolveDeckCommand("ArrowLeft", { hasImages: false }), null);
  assert.equal(resolveDeckCommand("Backspace"), "previous-group");
  assert.equal(resolveDeckCommand("Backspace", browseImages), "previous-group");
  assert.equal(resolveDeckCommand(" ", { editable: true, hasImages: true }), "toggle-active-image");
  assert.equal(resolveDeckCommand(" ", { editable: false, hasImages: true }), null);
  assert.equal(resolveDeckCommand("Enter", { editable: true, hasImages: true }), "accept-advance");
  assert.equal(resolveDeckCommand("Enter", { editable: false, readOnly: false, hasImages: true }), null);
  assert.equal(
    resolveDeckCommand("Enter", { editable: false, readOnly: true, hasImages: true }),
    "browse-next-group",
  );
  for (const key of ["x", "X"]) {
    assert.equal(resolveDeckCommand(key, { editable: true, loupeAvailable: true }), "toggle-loupe");
    assert.equal(resolveDeckCommand(key, { editable: false, loupeAvailable: true }), "toggle-loupe");
    assert.equal(resolveDeckCommand(key, { editable: true, loupeAvailable: false }), null);
  }
  for (const key of [
    "1", "a", "A", "R", "h", "l", "Home", "End",
    "PageUp", "PageDown", "i", "s", "p", "P", "Escape",
  ]) {
    assert.equal(resolveDeckCommand(key, {
      editable: true,
      hasImages: true,
      loupeAvailable: true,
    }), null, key);
  }
});

test("REVIEW deck 底部只有两按钮和三行提示，镜片按钮独立声明 X", () => {
  const viewSource = readFileSync(
    new URL("../gdl_backend/webui/js/components/review-view.js", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(
    new URL("../gdl_backend/webui/js/apps/review.js", import.meta.url),
    "utf8",
  );
  const cssSource = readFileSync(
    new URL("../gdl_backend/webui/styles/apps/review.css", import.meta.url),
    "utf8",
  );
  const commandStart = viewSource.indexOf("const commandHost =");
  const commandEnd = viewSource.indexOf("const deckLiveHost =", commandStart);
  const commandSource = viewSource.slice(commandStart, commandEnd);
  assert.ok(commandStart >= 0 && commandEnd > commandStart);
  assert.equal((commandSource.match(/button\(/g) || []).length, 2);
  assert.equal((commandSource.match(/button\("prev-group"/g) || []).length, 1);
  assert.equal((commandSource.match(/button\("next-group"/g) || []).length, 1);
  assert.equal((viewSource.match(/button\("prev-group"/g) || []).length, 1);
  assert.equal((viewSource.match(/button\("next-group"/g) || []).length, 1);
  assert.match(commandSource, /className: "review-shortcut-hints"/);
  assert.equal((commandSource.match(/createElement\("span"/g) || []).length, 3);
  for (const hint of [
    "方向键  移动选中",
    "Space  切换保留",
    "Enter  采纳并前进",
  ]) {
    assert.equal(commandSource.split(`text: "${hint}"`).length - 1, 1, hint);
  }
  assert.doesNotMatch(commandSource, /<kbd|className:\s*"review-deck-command"|放大镜|keyShortcuts:\s*"x"/);
  assert.match(commandSource, /title: "快捷键 Backspace：返回上一组"/);
  assert.match(commandSource, /keyShortcuts: "Backspace"/);
  assert.match(viewSource, /"aria-keyshortcuts": keyShortcuts \|\| null/);
  assert.match(viewSource, /loupeToggleButton\.setAttribute\("aria-keyshortcuts", "x"\)/);
  assert.match(viewSource, /title: "快捷键 X：开启或关闭同步放大镜"/);
  assert.doesNotMatch(`${viewSource}\n${cssSource}`, /镜片 · 同步 · 锐利|review-loupe-label/);

  for (const fingerprint of [
    'className: "review-image-active-marker"',
    'text: "当前选中"',
    '"aria-current": String(image.id === activeImageId)',
    'card.setAttribute("aria-current", String(active))',
  ]) {
    assert.equal(viewSource.includes(fingerprint), true, fingerprint);
  }
  assert.match(cssSource, /\.review-image-card\[data-active="true"\] \{[\s\S]*?border-color: var\(--imageweave-accent\);[\s\S]*?opacity: 1;[\s\S]*?outline: var\(--imageweave-focus-width\) solid var\(--imageweave-focus-ring\)/);
  assert.match(cssSource, /\.review-image-card\[data-active="true"\] \.review-image-active-marker \{\s*display: block;/);
  assert.match(cssSource, /\.review-image-active-marker \{[\s\S]*?border-color: var\(--imageweave-accent\);[\s\S]*?color: var\(--imageweave-accent-highlight\);[\s\S]*?background: var\(--imageweave-glass-surface-input\);/);

  for (const fingerprint of [
    'command === "previous-group"',
    'command === "focus-previous-image"',
    'command === "focus-next-image"',
    'command === "toggle-active-image"',
    'command === "accept-advance"',
    'command === "browse-next-group"',
    'command === "toggle-loupe"',
    "view.setActiveImage(nextImage.id, { focus: true })",
    "toggleImage(group.id, imageId, { focus: true })",
    "view.toggleLoupe()",
    'readOnly: review.summary.status !== "ready"',
    'command === "browse-next-group") return navigateGroup(1)',
    "放大镜已启动；在图片内移动鼠标即可同步检查。",
    "放大镜已关闭；倍率会保留到下次启动。",
    'event.target.closest("input, select, textarea, button, a[href], [contenteditable]")',
  ]) {
    assert.equal(appSource.includes(fingerprint), true, fingerprint);
  }
  assert.equal(appSource.includes("card.click()"), false);
  assert.match(viewSource, /dataset: \{ reviewEnterHint: "" \}/);
  assert.match(viewSource, /review\.summary\.status !== "ready"[\s\S]*?\? "Enter  下一组"[\s\S]*?: "Enter  采纳并前进"/);

  for (const retired of [
    "toggle-inspector", "review-deck-inspector", "review-metrics", "review-metric",
    "review-image-fact", "filter-all", "filter-none", "filter-recommended",
    "group-all", "group-none", "group-recommended", "jump-backward", "jump-forward",
    "first-group", "last-group", "deckJumpTarget", "属性 / 指标",
  ]) {
    assert.equal(`${viewSource}\n${appSource}`.includes(retired), false, retired);
  }
  for (const retired of [
    "touchGesture", "TOUCH_DRAG_THRESHOLD", "pointerdown", "pointerup", "pointercancel",
  ]) {
    assert.equal(viewSource.includes(retired), false, retired);
  }
});

test("REVIEW 当前组图片移动线性 clamp 且不循环或切组", () => {
  assert.deepEqual(deckImageStepTarget(-1, {
    activeIndex: 1, imageCount: 4,
  }), { type: "image", index: 0 });
  assert.deepEqual(deckImageStepTarget(1, {
    activeIndex: 1, imageCount: 4,
  }), { type: "image", index: 2 });
  assert.deepEqual(deckImageStepTarget(-1, {
    activeIndex: 0, imageCount: 4,
  }), { type: "image", index: 0 });
  assert.deepEqual(deckImageStepTarget(1, {
    activeIndex: 3, imageCount: 4,
  }), { type: "image", index: 3 });
  assert.deepEqual(deckImageStepTarget(1, {
    activeIndex: -1, imageCount: 0,
  }), { type: "empty" });
  assert.throws(() => deckImageStepTarget(0, {
    activeIndex: 1, imageCount: 4,
  }), TypeError);
  assert.throws(() => deckImageStepTarget(1, {
    activeIndex: 4, imageCount: 4,
  }), TypeError);
});

test("REVIEW deck 单步导航始终在全量数组内 clamp", () => {
  const position = { focusedIndex: 12, groupCount: 24 };
  assert.deepEqual([
    deckStepTarget(-1, position),
    deckStepTarget(1, position),
  ], [{ type: "group", index: 11 }, { type: "group", index: 13 }]);
  assert.deepEqual(deckStepTarget(-1, {
    focusedIndex: 0, groupCount: 24,
  }), { type: "edge" });
  assert.deepEqual(deckStepTarget(1, {
    focusedIndex: 23, groupCount: 24,
  }), { type: "edge" });
  assert.throws(() => deckStepTarget(0, position), TypeError);
});

test("REVIEW 组确认只对全量快照已知组置脏且不改选择", () => {
  const page = sanitizeReviewPage(rawReviewWorkflow(), {
    batchId: "batch-123", filter: "", requestedOffset: 0,
  });
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.reviewWorkspaceReceived(page));
  const beforeUnknown = store.getState();
  store.dispatch(actionCreators.reviewGroupConfirmed("group-missing"));
  assert.equal(store.getState(), beforeUnknown);
  store.dispatch(actionCreators.reviewGroupConfirmed("group-1"));
  assert.deepEqual({
    dirty: store.getState().review.dirty,
    dirtyGroupIds: store.getState().review.dirtyGroupIds,
    selected: store.getState().review.groups[0].images.map((image) => image.selected),
    decided: store.getState().review.groups[0].decided,
  }, {
    dirty: true,
    dirtyGroupIds: ["group-1"],
    selected: [true, true],
    decided: false,
  });

  const emptyStore = createStore({ reportError: () => {} });
  const emptyBefore = emptyStore.getState();
  emptyStore.dispatch(actionCreators.reviewGroupConfirmed("group-1"));
  assert.equal(emptyStore.getState(), emptyBefore);
});

test("REVIEW 全量投影、单组 payload、安全字段与保存清空", () => {
  const raw = rawReviewWorkflow();
  const secondImage = {
    ...raw.groups.items[0].images[0],
    id: "image-3",
    ordinal: 1,
  };
  const secondGroup = {
    ...raw.groups.items[0],
    id: "group-2",
    ordinal: 2,
    kind: "single",
    images: [secondImage],
  };
  const page = sanitizeReviewPage({
    ...raw,
    total_image_count: 3,
    total_group_count: 2,
    groups: {
      items: [...raw.groups.items, secondGroup],
      total: 2,
      offset: 0,
      limit: 2,
    },
  }, {
    batchId: "batch-123", filter: "", requestedOffset: 0,
  });
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes(WORKFLOW_SECRET), false);
  assert.equal(serialized.includes("relative_path"), false);
  assert.equal(serialized.includes('"url"'), false);
  for (const retiredMetric of ["matchLevels", "format", "bytes", "jpegQuality", "sharpness", "noiseSigma", "metrics"]) {
    assert.equal(serialized.includes(`"${retiredMetric}"`), false, retiredMetric);
  }
  assert.deepEqual(page.dirtyGroupIds, []);
  assert.equal(page.limit, 2);
  assert.throws(() => buildReviewDecisionPayload(page), TypeError);

  const changed = updateReviewImageSelection(page, "group-1", "image-2", false);
  assert.deepEqual(changed.dirtyGroupIds, ["group-1"]);
  assert.equal(changed.dirty, true);
  assert.deepEqual(buildReviewDecisionPayload(changed), {
    groups: [{ group_id: "group-1", selected_image_ids: ["image-1"] }],
  });

  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.reviewWorkspaceReceived(changed));
  store.dispatch(actionCreators.reviewPageSaved({
    ...raw,
    selected_image_count: 2,
    decided_group_count: 1,
  }));
  assert.deepEqual(store.getState().review.dirtyGroupIds, []);
  assert.equal(store.getState().review.dirty, false);
  assert.deepEqual(
    store.getState().review.groups.map((group) => group.decided),
    [true, false],
  );

  assert.equal(reviewImageUrl("batch-123", "image-1"), "/api/v1/crawls/batch-123/review/images/image-1");
  assert.deepEqual(REVIEW_ENDPOINTS, { crawls: "/api/v1/crawls" });
  for (const hook of ["mount", "activate", "beforeLeave", "deactivate", "unmount"]) {
    assert.equal(typeof reviewApplication[hook], "function");
  }
});

test("REVIEW 全量投影拒绝超限、非零 offset、筛选错配与危险脏 ID", () => {
  const group = rawReviewWorkflow().groups.items[0];
  const groups = Array.from({ length: REVIEW_GROUP_LIMIT }, (_, index) => ({
    ...group,
    id: `group-${index + 1}`,
    ordinal: index + 1,
    images: [],
  }));
  const raw = {
    ...rawReviewWorkflow(),
    total_group_count: groups.length,
    groups: { items: groups, total: groups.length, offset: 0, limit: groups.length },
  };
  const projected = sanitizeReviewPage(raw, { batchId: "batch-123" });
  assert.equal(projected.groups.length, REVIEW_GROUP_LIMIT);

  const overflow = {
    ...raw,
    total_group_count: REVIEW_GROUP_LIMIT + 1,
    groups: {
      items: [...groups, { ...group, id: "group-overflow", ordinal: REVIEW_GROUP_LIMIT + 1, images: [] }],
      total: REVIEW_GROUP_LIMIT + 1,
      offset: 0,
      limit: REVIEW_GROUP_LIMIT + 1,
    },
  };
  assert.throws(() => sanitizeReviewPage(overflow, { batchId: "batch-123" }), TypeError);
  assert.throws(() => sanitizeReviewPage({
    ...rawReviewWorkflow(),
    groups: { ...rawReviewWorkflow().groups, offset: 8 },
  }, { batchId: "batch-123" }), TypeError);
  assert.throws(() => sanitizeReviewPage(rawReviewWorkflow(), {
    batchId: "batch-123", filter: "single",
  }), TypeError);

  const dirty = updateReviewImageSelection(
    sanitizeReviewPage(rawReviewWorkflow(), { batchId: "batch-123" }),
    "group-1",
    "image-2",
    false,
  );
  for (const dirtyGroupIds of [["group-missing"], ["group-1", "group-1"]]) {
    assert.throws(() => validateReviewState({ ...dirty, dirtyGroupIds }), TypeError);
    assert.throws(() => buildReviewDecisionPayload({ ...dirty, dirtyGroupIds }), TypeError);
  }
});

test("REVIEW 空组保持只读且不会生成不可提交的脏决策", () => {
  const raw = rawReviewWorkflow();
  const empty = sanitizeReviewPage({
    ...raw,
    total_image_count: 0,
    groups: {
      ...raw.groups,
      items: [{ ...raw.groups.items[0], images: [] }],
    },
  }, { batchId: "batch-123" });

  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.reviewWorkspaceReceived(empty));
  store.dispatch(actionCreators.reviewGroupConfirmed("group-1"));
  assert.equal(store.getState().review.dirty, false);
  assert.deepEqual(store.getState().review.dirtyGroupIds, []);
});

test("REVIEW 控制器使用 all=true、串行 50 组 PUT 与权威重读", () => {
  const source = readFileSync(
    new URL("../gdl_backend/webui/js/apps/review.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /\?all=true/);
  assert.match(source, /for \(const chunk of captured\)/);
  assert.match(source, /await api\.put\(reviewPath\(batchId, "\/decisions"\), chunk/);
  assert.match(source, /const loaded = await readPage\(/);
  assert.match(source, /完整草稿与待提交组已保留/);
  assert.doesNotMatch(source, /api\.put\([^\n]*captured/);
});

test("REVIEW 决策按 50 组分批且不产生空块", () => {
  const groups = Array.from({ length: REVIEW_DECISION_BATCH_LIMIT * 2 + 1 }, (_, index) => ({
    group_id: `group-${index + 1}`,
    selected_image_ids: [],
  }));
  assert.deepEqual(
    splitReviewDecisionPayload({ groups }).map((chunk) => chunk.groups.length),
    [REVIEW_DECISION_BATCH_LIMIT, REVIEW_DECISION_BATCH_LIMIT, 1],
  );
  assert.throws(() => splitReviewDecisionPayload({ groups: [] }), TypeError);
});

test("REVIEW LOUPE 基础数值函数严格有限、规范化并冻结结果", () => {
  assert.equal(loupeClamp(-4, 0, 1), 0);
  assert.equal(loupeClamp(4, 0, 1), 1);
  assert.equal(loupeClamp(0.4, 0, 1), 0.4);
  assert.throws(() => loupeClamp(Number.NaN, 0, 1), TypeError);
  assert.throws(() => loupeClamp(0, Number.NEGATIVE_INFINITY, 1), TypeError);
  assert.throws(() => loupeClamp(0, 1, 0), RangeError);

  const source = [3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2];
  assert.equal(loupeMedian(source), 2);
  assert.deepEqual(source, [3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2]);
  assert.equal(loupeMedian([4, 1, 2, 3]), 3); // 沿用 demo 的上中位数
  assert.equal(loupeMedian([Number.NaN, Number.NEGATIVE_INFINITY]), null);
  assert.throws(() => loupeMedian(null), TypeError);

  const normalized = normalizeImageDimensions({
    width: 1984,
    height: 2806,
    readable: true,
    recommended: true,
    ignored: "不会进入结果",
  });
  assert.deepEqual(normalized, {
    width: 1984,
    height: 2806,
    readable: true,
    recommended: true,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalizeImageDimensions({ metadata: { w: 1448, h: 2048 } }).width, 1448);
  for (const bad of [
    { width: 0, height: 1 },
    { width: -1, height: 1 },
    { width: Number.NaN, height: 1 },
    { width: 1, height: Number.POSITIVE_INFINITY },
    { width: "1984", height: 2806 },
    { width: 1, height: 1, readable: 1 },
    null,
  ]) {
    assert.equal(normalizeImageDimensions(bad), null);
  }
});

test("REVIEW LOUPE 参考图优先推荐并安全回退", () => {
  const images = [
    { width: 100, height: 200, readable: false, recommended: true },
    { width: 1984, height: 2806, readable: true, recommended: false },
    { width: 1448, height: 2048, readable: true, recommended: true },
    { width: 800, height: 1200, readable: false, recommended: false },
  ];
  const recommended = selectReferenceImage(images);
  assert.deepEqual(recommended, {
    available: true,
    index: 2,
    image: { width: 1448, height: 2048, readable: true, recommended: true },
  });
  assert.equal(Object.isFrozen(recommended), true);
  assert.equal(Object.isFrozen(recommended.image), true);

  const fallback = selectReferenceImage(images.map((image) => ({
    ...image,
    recommended: false,
  })));
  assert.equal(fallback.index, 1);
  assert.equal(fallback.image.width, 1984);

  const unavailable = selectReferenceImage([
    { width: 100, height: 200, readable: false },
    { width: Number.NaN, height: 20, readable: true },
    { width: 0, height: 20, readable: true },
  ]);
  assert.deepEqual(unavailable, { available: false, index: -1, image: null });
  assert.equal(Object.isFrozen(unavailable), true);
});

test("REVIEW LOUPE 自适应布局覆盖纵图、横图、混合图与任意数量", () => {
  const vertical = (count) => Array.from({ length: count }, () => ({
    width: 1984,
    height: 2806,
    readable: true,
  }));
  const desktop = (images) => calculateReviewLayout(images, 1200, 800, 12, 160);
  for (const count of [1, 2, 3, 4]) {
    const layout = desktop(vertical(count));
    assert.equal(layout.ratio, 1984 / 2806);
    assert.equal(layout.columns >= 1 && layout.columns <= count, true);
    assert.equal(layout.rows, Math.ceil(count / layout.columns));
    assert.equal(layout.readable, true);
    assert.equal(Object.isFrozen(layout), true);
    for (const key of ["tileWidth", "tileHeight", "ratio"]) {
      assert.equal(Number.isFinite(layout[key]) && layout[key] > 0, true);
    }
  }

  for (const count of [2, 3, 4]) {
    const horizontal = desktop(Array.from({ length: count }, (_, index) => ({
      width: index ? 3000 : 4000,
      height: index ? 800 : 1000,
      readable: true,
    })));
    assert.equal(horizontal.ratio, 2.6); // 中位宽高比被规格上限钳制
    assert.equal(horizontal.readable, true);

    const mixedPool = [
      { width: 1984, height: 2806, readable: true },
      { width: 4000, height: 1000, readable: true },
      { width: 1448, height: 2048, readable: true },
      { width: 3200, height: 1800, readable: true },
    ];
    const mixed = desktop(mixedPool.slice(0, count));
    assert.equal(mixed.columns >= 1 && mixed.columns <= count, true);
    assert.equal(mixed.rows, Math.ceil(count / mixed.columns));
    assert.equal(mixed.readable, true);
    assert.equal(mixed.ratio >= 0.38 && mixed.ratio <= 2.6, true);
  }

  const stableMixed = desktop([
    { width: 1984, height: 2806, readable: true },
    { width: 4000, height: 1000, readable: true },
    { width: 1448, height: 2048, readable: true },
  ]);
  assert.equal(stableMixed.ratio, (1984 / 2806)); // 三项中位数稳定取中间比例

  const many = vertical(9);
  const first = calculateReviewLayout(many, 1400, 900, 12, 160);
  const second = calculateReviewLayout(many, 1400, 900, 12, 160);
  assert.deepEqual(first, second);
  assert.equal(first.columns <= 9, true);
  assert.equal(first.rows, Math.ceil(9 / first.columns));

  const narrow = calculateReviewLayout(vertical(2), 360, 240, 12, 112);
  assert.equal(narrow.readable, true);
  const tiny = calculateReviewLayout(vertical(4), 100, 70, 12, 160);
  assert.equal(tiny.readable, false);
  assert.equal(tiny.columns >= 1 && tiny.columns <= 4, true);
  assert.equal(Number.isFinite(tiny.tileWidth) && tiny.tileWidth > 0, true);

  const unreadable = calculateReviewLayout([
    { width: 1000, height: 1000, readable: false },
    { width: 900, height: 1200, readable: false },
  ], 1000, 700, 12, 160);
  assert.equal(unreadable.readable, false);
  assert.equal(unreadable.ratio, 1);
  assert.equal(calculateReviewLayout([], 1000, 700, 12, 160).readable, false);
});

test("REVIEW LOUPE contain 内容矩形与指针坐标忽略留白和容器偏移", () => {
  const horizontal = getContainContentRect(
    { width: 400, height: 200, readable: true },
    { left: 10, top: 20, width: 500, height: 300 },
  );
  assert.deepEqual(horizontal, { left: 10, top: 45, width: 500, height: 250 });
  const vertical = containContentRect(
    { width: 200, height: 400, readable: true },
    { left: 10, top: 20, width: 500, height: 300 },
  );
  assert.deepEqual(vertical, { left: 185, top: 20, width: 150, height: 300 });

  assert.deepEqual(
    normalizePointerCoordinates({ x: 260, y: 170 }, horizontal),
    { u: 0.5, v: 0.5 },
  );
  assert.deepEqual(
    normalizePointerCoordinates({ x: -100, y: 1000 }, horizontal),
    { u: 0, v: 1 },
  );
  assert.deepEqual(
    normalizePointerCoordinates({ x: 510, y: 45 }, horizontal),
    { u: 1, v: 0 },
  );
  assert.equal(getContainContentRect({ width: 0, height: 100 }, {
    left: 0, top: 0, width: 100, height: 100,
  }), null);
  assert.throws(() => normalizePointerCoordinates({ x: Number.NaN, y: 1 }, horizontal), TypeError);
});

test("REVIEW LOUPE 同步 crop 覆盖真实尺寸、倍率、边缘与低分辨率目标", () => {
  const referenceA = { width: 1984, height: 2806, readable: true, recommended: true };
  const targetA = { width: 1448, height: 2048, readable: true, recommended: false };
  const referenceB = { width: 2480, height: 3508, readable: true, recommended: true };
  const targetB = { width: 848, height: 1199, readable: true, recommended: false };
  const outputWidth = 200;
  const outputHeight = 100;

  for (const [target, reference] of [[targetA, referenceA], [targetB, referenceB]]) {
    for (const magnification of [0.25, 0.5, 1.0]) {
      for (const [u, v] of [
        [0.5, 0.5],
        [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5],
        [0, 0], [1, 0], [1, 1], [0, 1],
      ]) {
        const crop = calculateSynchronizedCrop(
          target,
          reference,
          outputWidth,
          outputHeight,
          magnification,
          u,
          v,
        );
        assert.equal(Object.isFrozen(crop), true);
        for (const value of Object.values(crop)) {
          assert.equal(Number.isFinite(value), true);
        }
        assert.equal(crop.sourceWidth > 0 && crop.sourceHeight > 0, true);
        assert.equal(crop.x >= 0 && crop.y >= 0, true);
        assert.equal(crop.x + crop.sourceWidth <= target.width + 1e-9, true);
        assert.equal(crop.y + crop.sourceHeight <= target.height + 1e-9, true);
        assert.equal(crop.sourceWidth / crop.sourceHeight, outputWidth / outputHeight);
        if (u === 0) assert.equal(crop.x, 0);
        if (u === 1) assert.equal(crop.x + crop.sourceWidth, target.width);
        if (v === 0) assert.equal(crop.y, 0);
        if (v === 1) assert.equal(crop.y + crop.sourceHeight, target.height);
      }
    }
  }

  const expectedHeight = REFERENCE_PIXEL_HEIGHT * targetA.height / referenceA.height / 0.5;
  const realPairCrop = calculateSynchronizedCrop(
    targetA,
    referenceA,
    160,
    160,
    0.5,
    0.5,
    0.5,
  );
  assert.equal(realPairCrop.sourceHeight, expectedHeight);
  assert.equal(realPairCrop.sourceWidth, expectedHeight);

  const fallback = calculateSynchronizedCrop({
    targetImage: targetA,
    images: [
      { ...referenceA, readable: false },
      { ...referenceB, recommended: true },
      { ...targetA, recommended: false },
    ],
    outputWidth: 160,
    outputHeight: 160,
    magnification: 1,
    u: 0.5,
    v: 0.5,
  });
  assert.equal(fallback.sourceHeight, 160 * targetA.height / referenceB.height);

  const tinyTarget = calculateSynchronizedCrop({
    targetImage: { width: 100, height: 100, readable: true },
    referenceImage: { width: 200, height: 200, readable: true },
    outputWidth: 400,
    outputHeight: 100,
    magnification: 0.25,
    u: 0.5,
    v: 0.5,
  });
  assert.equal(tinyTarget.sourceWidth <= 100, true);
  assert.equal(tinyTarget.sourceHeight <= 100, true);
  assert.equal(tinyTarget.sourceWidth / tinyTarget.sourceHeight, 4);
  assert.equal(tinyTarget.x, 0);
  assert.equal(tinyTarget.y, (100 - tinyTarget.sourceHeight) / 2);
  assert.equal(tinyTarget.y >= 0 && tinyTarget.y + tinyTarget.sourceHeight <= 100, true);

  assert.throws(() => calculateSynchronizedCrop(undefined, referenceA, 100, 100), TypeError);
  assert.equal(calculateSynchronizedCrop(
    { width: 100, height: 100, readable: false },
    referenceA,
    100,
    100,
    0.5,
    0.5,
    0.5,
  ), null);
  assert.equal(calculateSynchronizedCrop({
    targetImage: targetA,
    images: [{ width: 10, height: 10, readable: false }],
    outputWidth: 100,
    outputHeight: 100,
    magnification: 0.5,
    u: 0.5,
    v: 0.5,
  }), null);
});

test("REVIEW LOUPE 倍率指数滚轮、上下限与稳定标签", () => {
  assert.equal(DEFAULT_MAGNIFICATION, 0.5);
  assert.equal(MIN_MAGNIFICATION, 0.25);
  assert.equal(MAX_MAGNIFICATION, 1.0);
  assert.equal(updateMagnification(0.5, -100), 0.59);
  assert.equal(updateMagnification(0.5, 100), 0.42372881355932207);
  let zoom = DEFAULT_MAGNIFICATION;
  for (let index = 0; index < 200; index += 1) zoom = updateMagnification(zoom, -1000);
  assert.equal(zoom, 1.0);
  assert.equal(formatMagnification(zoom), "1:1");
  for (let index = 0; index < 400; index += 1) zoom = updateMagnification(zoom, 1000);
  assert.equal(zoom, 0.25);
  assert.equal(formatMagnification(0.25), "0.25x");
  assert.equal(formatMagnification(0.5), "0.50x");
  assert.equal(formatMagnification(1), "1:1");
  assert.equal(updateMagnification({ magnification: 0.5, delta: -100 }), 0.59);
  assert.ok(Math.abs(updateMagnification(0.5, -1, { deltaMode: 1 }) - 0.5134180412656631) < 1e-12);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => updateMagnification(0.5, value), TypeError);
    assert.throws(() => updateMagnification(value, -1), TypeError);
    assert.throws(() => formatMagnification(value), TypeError);
  }
  assert.throws(() => updateMagnification(0, -1), RangeError);
  assert.throws(() => updateMagnification(0.5, -1, { deltaMode: 4 }), TypeError);
});

test("REVIEW LOUPE 源码保持纯内核且不含浏览器、网络或持久化依赖", () => {
  const source = readFileSync(
    new URL("../gdl_backend/webui/js/core/review-loupe.js", import.meta.url),
    "utf8",
  );
  for (const forbidden of ["document", "window", "localStorage", "sessionStorage", "fetch"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("getContext"), false);
  assert.equal(source.includes("requestAnimationFrame"), false);
});
test("DIAG happy path 只保留能力、组件和计数白名单", () => {
  const config = {
    response_profile: "diagnostics",
    secrets_exposed: false,
    server: { loopback_only: true, cors_enabled: false, private_targets_enabled: false },
    gallery: { managed_auth_cache: true },
    proxy: { enabled: true, auto_start: false, transport_core_enabled: true },
    scheduler: { max_concurrent_tasks: 20 },
    dedup: { enabled: true, configured_device: "cpu", sscd_enabled: true, dino_enabled: false },
    path: `/home/private/${WORKFLOW_SECRET}`,
  };
  const scheduler = {
    response_profile: "diagnostics",
    secrets_exposed: false,
    tasks: { running: true, active: 2, max_concurrent: 20, active_site_count: 1, sites: { secret: WORKFLOW_SECRET } },
    ordered_crawls: { running: true, active_batches: 1, execution_order: "source_then_address", address_parallelism: "media_tasks" },
  };
  assert.equal(sanitizeDiagnosticsConfig(config).configuredDevice, "cpu");
  assert.equal(sanitizeDiagnosticsScheduler(scheduler).activeTasks, 2);
  const snapshot = buildDiagnosticsSnapshot({
    health: { connected: true, data: { ok: true, components: { process: { status: "ok" }, database: { status: "ok" } } } },
    readiness: { connected: true, data: { ready: true, components: {
      process: { status: "ok", summary: WORKFLOW_SECRET },
      database: { status: "ok", path: `/home/private/${WORKFLOW_SECRET}` },
      torch: { status: "ok", version: "2.0+cpu", configured_device: "cpu", actual_device: "cpu", cuda_available: false },
      scheduler: { status: "ok", details: { active: 2, max_concurrent: 20, raw: WORKFLOW_SECRET } },
    } } },
    config: { connected: true, data: config },
    scheduler: { connected: true, data: scheduler },
    checkedAt: 123,
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(WORKFLOW_SECRET), false);
  assert.equal(serialized.includes("/home/private"), false);
  assert.equal(diagnosticsCopyText(snapshot).includes(WORKFLOW_SECRET), false);
  assert.deepEqual(DIAGNOSTICS_ENDPOINTS, {
    health: "/healthz",
    readiness: "/readyz",
    config: "/api/v1/config?view=diagnostics",
    scheduler: "/api/v1/scheduler/status?view=diagnostics",
  });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof diagnosticsApplication[hook], "function");
  }
});
