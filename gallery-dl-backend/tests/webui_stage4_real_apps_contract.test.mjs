import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";
import proxyApplication, {
  createProxyController,
  PROXY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/proxy.js";
import * as vaultApplicationModule from "../gdl_backend/webui/js/apps/vault.js";
import tasksApplication, {
  createTasksController,
  taskBatchPath,
  TASKS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/tasks.js";
import {
  createBatchRequestGate,
  deriveTasksWorkspacePresentation,
  filterRecentBatches,
  formatTaskBytes,
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  shouldPollBatch,
  TASK_POLL_INTERVAL_MS,
  taskErrorCategory,
  taskErrorGuidance,
  taskFileFacts,
  taskRecoveryTargets,
  TERMINAL_BATCH_STATUSES,
  validateBatchId,
} from "../gdl_backend/webui/js/core/tasks-model.js";
import {
  createTasksView,
  taskResultText,
} from "../gdl_backend/webui/js/components/tasks-view.js";
import {
  createProxyRequestGate,
  deriveProxyControls,
  deriveProxyWorkspacePresentation,
  formatRevisionPair,
  PROXY_STATUS_POLL_INTERVAL_MS,
  proxyErrorGuidance,
  sanitizeProxySources,
  sanitizeProxyStatus,
  validateInlineNodeInput,
  validateNodeFileInput,
  validateSubscriptionInput,
} from "../gdl_backend/webui/js/core/proxy-model.js";
import * as vaultModelModule from "../gdl_backend/webui/js/core/vault-model.js";
import * as policyApplicationModule from "../gdl_backend/webui/js/apps/policy.js";
import * as policyModelModule from "../gdl_backend/webui/js/core/policy-model.js";

const SECRET = "stage4-task-cookie-token-secret-314159";
const TASKS_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/tasks.js", import.meta.url),
  "utf8",
);
const TASKS_MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/tasks-model.js", import.meta.url),
  "utf8",
);
const TASKS_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/tasks-view.js", import.meta.url),
  "utf8",
);
const TASKS_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/tasks.css", import.meta.url),
  "utf8",
);
const PROXY_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/proxy.js", import.meta.url),
  "utf8",
);
const PROXY_MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/proxy-model.js", import.meta.url),
  "utf8",
);
const PROXY_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/proxy-view.js", import.meta.url),
  "utf8",
);
const PROXY_DOM_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/proxy-dom.js", import.meta.url),
  "utf8",
);
const PROXY_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/proxy.css", import.meta.url),
  "utf8",
);
const CONTROLS_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/controls.css", import.meta.url),
  "utf8",
);
const VAULT_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/vault.js", import.meta.url),
  "utf8",
);
const VAULT_MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/vault-model.js", import.meta.url),
  "utf8",
);
const VAULT_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/vault-view.js", import.meta.url),
  "utf8",
);
const VAULT_DOM_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/vault-dom.js", import.meta.url),
  "utf8",
);
const VAULT_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/vault.css", import.meta.url),
  "utf8",
);

const PROXY_SECRET = "stage4-proxy-cookie-token-password-secret-271828";
const PROXY_CONFIGURED_REVISION = "a".repeat(64);
const PROXY_ACTIVE_REVISION = "b".repeat(64);
const PROXY_SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const PROXY_INLINE_ID = `node_${"d".repeat(64)}`;
const VAULT_SECRET = "stage4-vault-cookie-token-password-secret-161803";
const VAULT_SESSION_ID = "e".repeat(32);
const VAULT_SECOND_SESSION_ID = "f".repeat(32);
const vaultApplication = vaultApplicationModule.default;
const { createVaultController, VAULT_ENDPOINTS } = vaultApplicationModule;
const {
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  deriveVaultWorkspacePresentation,
  extractVaultSessionReference,
  sanitizeVaultStatus,
  validateAuthorizationProxyInput,
  VAULT_SITE_IDS,
} = vaultModelModule;

function rawProxyStatus(overrides = {}) {
  return {
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    auto_start: false,
    running: false,
    total: 1,
    healthy: 0,
    retry_eligible: 1,
    leases: 0,
    last_error: "",
    configured_revision: PROXY_CONFIGURED_REVISION,
    active_revision: PROXY_ACTIVE_REVISION,
    reload_required: true,
    transport_core: { enabled: true, running: false, listeners: 0, last_error: "" },
    sources: {
      subscriptions: 1,
      source_nodes: 1,
      pool_nodes: 1,
      core_candidates: 0,
      core_nodes: 0,
      skipped_nodes: 0,
      scheme_counts: { http: 1 },
      warnings: [],
    },
    nodes: [{
      id: "proxy-stage4-node",
      name: "JP node",
      protocol: "http",
      endpoint: "http://***@proxy.fixture.invalid:8080",
      tags: ["jp"],
      healthy: false,
      retry_eligible: true,
      ref_count: 0,
      success_count: 2,
      fail_count: 1,
      last_latency_ms: 50,
      cooldown_until: 0,
      last_error: `token=${PROXY_SECRET} https://private.invalid/secret`,
      raw: PROXY_SECRET,
    }],
    secret: PROXY_SECRET,
    ...overrides,
  };
}

function rawProxySources(overrides = {}) {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: PROXY_CONFIGURED_REVISION,
    active_revision: PROXY_ACTIVE_REVISION,
    reload_required: true,
    subscriptions: [{
      id: PROXY_SUBSCRIPTION_ID,
      source: "runtime",
      scheme: "https",
      host: "provider.fixture.invalid",
      port: 443,
      display_url: `https://provider.fixture.invalid/private/${PROXY_SECRET}`,
      credentials_redacted: true,
      sensitive_parts_redacted: true,
      url: `https://user:${PROXY_SECRET}@provider.fixture.invalid/private`,
    }],
    node_file: {
      configured: true,
      source: "runtime",
      display_path: `/private/${PROXY_SECRET}/nodes.yaml`,
      path: `/private/${PROXY_SECRET}/nodes.yaml`,
    },
    inline_nodes: [{
      id: PROXY_INLINE_ID,
      source: "runtime",
      scheme: "vless",
      name: "JP-01",
      host: "proxy.fixture.invalid",
      port: 443,
      requires_transport_core: true,
      display_endpoint: `vless://${PROXY_SECRET}@proxy.fixture.invalid:443`,
      node: `vless://${PROXY_SECRET}@proxy.fixture.invalid:443`,
    }],
    counts: { subscriptions: 1, node_file: 1, inline_nodes: 1, total: 3 },
    secret: PROXY_SECRET,
    ...overrides,
  };
}

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
      updated_at: 1_700_000_000,
      actions: ["managed_browser_login", "clear", `token=${VAULT_SECRET}`],
      cookies: {
        present: true,
        valid: true,
        cookie_count: 2,
        updated_at: 1_700_000_000,
        raw_cookie: VAULT_SECRET,
      },
      login: null,
    },
    pixiv: {
      label: "Pixiv",
      method: "oauth",
      state: "required",
      authorized: false,
      updated_at: null,
      actions: ["oauth", "clear"],
      oauth: null,
    },
    exhentai: {
      label: "EH",
      method: "managed_browser",
      state: "required",
      authorized: false,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: false, valid: false, cookie_count: 0 },
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
    summary: `Bearer ${VAULT_SECRET} at https://private.invalid/${VAULT_SECRET}`,
    ...definitions[site],
    ...overrides,
  };
}

function rawVaultSnapshot(overrides = {}) {
  return {
    items: VAULT_SITE_IDS.map((site) => rawVaultSite(site)),
    browser_profile: {
      shared: true,
      present: true,
      running: false,
      resetting: false,
      path: `/private/${VAULT_SECRET}`,
    },
    authorization_proxy: {
      proxy_url: "https://***@login-proxy.fixture.invalid:8443",
      source: "runtime",
      credentials_redacted: true,
      browser_running: false,
      restart_pending: false,
      updated_at: 1_700_000_100,
      raw_proxy_url: `https://user:${VAULT_SECRET}@private.invalid:8443`,
    },
    managed: true,
    secrets_exposed: false,
    response_profile: "vault",
    raw: VAULT_SECRET,
    ...overrides,
  };
}

function vaultSnapshotWithActive(site = "pixiv", sessionId = VAULT_SESSION_ID) {
  const snapshot = rawVaultSnapshot();
  const index = VAULT_SITE_IDS.indexOf(site);
  const method = site === "pixiv" ? "oauth" : "login";
  snapshot.items[index] = rawVaultSite(site, {
    state: "authorizing",
    [method]: {
      session_id: sessionId,
      state: "awaiting_login",
      created_at: 1_700_000_000,
      expires_at: 1_700_000_600,
      authorization_url: `https://private.invalid/?token=${VAULT_SECRET}`,
      raw: VAULT_SECRET,
    },
  });
  snapshot.browser_profile.running = true;
  return snapshot;
}

function rawBatch(overrides = {}) {
  return {
    id: "batch-stage4",
    status: "running",
    output_dir: `/private/${SECRET}`,
    concurrency: 12,
    max_tasks: 500,
    task_count: 4,
    succeeded_task_count: 1,
    failed_task_count: 1,
    cancelled_task_count: 0,
    pre_dedup_skipped_count: 2,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_030,
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      addresses: [{
        id: "address-stage4",
        address_order: 0,
        label: "画师作品",
        address_type: "account",
        status: "running",
        planned_task_count: 4,
        succeeded_task_count: 1,
        failed_task_count: 1,
        cancelled_task_count: 0,
        pre_dedup_skipped_count: 2,
        probed_proxy_count: 3,
        healthy_proxy_count: 2,
        url: `https://private.invalid/?token=${SECRET}`,
        planning_error: `planning ${SECRET}`,
      }],
    }],
    current: {
      address_id: "address-stage4",
      source_order: 0,
      address_order: 0,
      site: "pixiv",
      status: "running",
      url: `https://private.invalid/current?token=${SECRET}`,
    },
    review: null,
    resumable: false,
    ...overrides,
  };
}

function rawTask(overrides = {}) {
  return {
    id: "task-stage4",
    crawl_address_id: "address-stage4",
    site: "pixiv",
    status: "failed",
    source_order: 0,
    address_order: 0,
    sequence_no: 2,
    attempt_count: 1,
    max_attempts: 3,
    artifact_count: 2,
    artifact_bytes: 5_242_880,
    last_error_class: "credentials_unavailable",
    last_error: `cookie=${SECRET}`,
    url: `https://private.invalid/media?token=${SECRET}`,
    output_dir: `/private/${SECRET}`,
    cookies_file: `/private/${SECRET}.txt`,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class TestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  append(child) {
    child.parentNode = this;
  }

  closest(selector) {
    let current = this;
    while (current instanceof TestElement) {
      const match = /^\[data-tasks-action(?:="([^"]+)")?\]$/.exec(selector);
      if (match && current.dataset.tasksAction !== undefined &&
          (match[1] === undefined || current.dataset.tasksAction === match[1])) return current;
      current = current.parentNode;
    }
    return null;
  }

  emit(type, target = this) {
    const event = { type, target, preventDefault() {} };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

class TestButton extends TestElement {
  constructor(action = "") {
    super("button");
    if (action) this.dataset.tasksAction = action;
  }
}

class ProxyTestElement extends TestElement {
  constructor(tagName = "div") {
    super(tagName);
    this.value = "";
    this.validationMessage = "";
    this.elements = new Map();
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setCustomValidity(message) {
    this.validationMessage = String(message);
  }

  querySelector(selector) {
    return this.elements.get(selector) || null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-proxy-secret]") {
      return [...this.elements.values()].filter((element) => element.hasAttribute?.("data-proxy-secret"));
    }
    if (selector === ".proxy-replace-form") return [];
    return [];
  }

  closest(selector) {
    let current = this;
    while (current instanceof ProxyTestElement) {
      if (selector === "[data-proxy-action]" && current.dataset.proxyAction !== undefined) return current;
      if (selector === "[data-source-id]" && current.dataset.sourceId !== undefined) return current;
      if (selector === "form" && current instanceof ProxyTestForm) return current;
      if (selector === ".proxy-source-card" && current.dataset.sourceId !== undefined) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class ProxyTestButton extends ProxyTestElement {
  constructor(action = "") {
    super("button");
    if (action) this.dataset.proxyAction = action;
  }
}

class ProxyTestInput extends ProxyTestElement {
  constructor(value = "") {
    super("input");
    this.value = value;
    this.setAttribute("data-proxy-secret", "");
  }
}

class ProxyTestTextArea extends ProxyTestInput {
  constructor(value = "") {
    super(value);
    this.tagName = "TEXTAREA";
  }
}

class ProxyTestForm extends ProxyTestElement {
  constructor(kind, input, sourceId = "") {
    super("form");
    this.dataset.proxyForm = kind;
    if (sourceId) this.dataset.sourceId = sourceId;
    this.input = input;
    input.parentNode = this;
    this.elements.set("[data-proxy-secret]", input);
  }
}

class VaultTestElement extends TestElement {
  constructor(tagName = "div") {
    super(tagName);
    this.value = "";
    this.type = tagName === "input" ? "text" : "";
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  closest(selector) {
    let current = this;
    while (current instanceof VaultTestElement) {
      if (selector === "[data-vault-action]" && current.dataset.vaultAction !== undefined) return current;
      if (selector === "form" && current instanceof VaultTestForm) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class VaultTestButton extends VaultTestElement {
  constructor(action = "") {
    super("button");
    if (action) this.dataset.vaultAction = action;
  }
}

class VaultTestInput extends VaultTestElement {
  constructor(value = "") {
    super("input");
    this.value = value;
    this.type = "text";
  }
}

class VaultTestForm extends VaultTestElement {
  constructor(input) {
    super("form");
    this.input = input;
    input.parentNode = this;
  }
}

function installControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", TestElement);
  install("HTMLElement", TestElement);
  install("HTMLButtonElement", TestButton);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function installProxyControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", ProxyTestElement);
  install("HTMLElement", ProxyTestElement);
  install("HTMLButtonElement", ProxyTestButton);
  install("HTMLInputElement", ProxyTestInput);
  install("HTMLTextAreaElement", ProxyTestTextArea);
  install("HTMLFormElement", ProxyTestForm);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function installVaultControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", VaultTestElement);
  install("HTMLElement", VaultTestElement);
  install("HTMLButtonElement", VaultTestButton);
  install("HTMLInputElement", VaultTestInput);
  install("HTMLFormElement", VaultTestForm);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function createPollingHarness() {
  const entries = new Map();
  const starts = [];
  const stops = [];
  return {
    entries,
    starts,
    stops,
    start(options) {
      starts.push(options);
      entries.set(options.key, options);
    },
    stop(key) {
      stops.push(key);
      entries.delete(key);
    },
  };
}

function controllerHarness({
  activeBatchId = "batch-stage4",
  apiGet,
  apiPost,
  dialogChoice = "confirm",
} = {}) {
  const root = new TestElement("main");
  const store = createStore({ reportError: () => {} });
  if (activeBatchId) store.dispatch(actionCreators.activeBatchIdChanged(activeBatchId));
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      return apiGet ? apiGet(url, options) : Promise.resolve({ items: [] });
    },
    post(url, payload, options) {
      calls.push(["post", url, payload, options]);
      return apiPost ? apiPost(url, payload, options) : Promise.resolve({});
    },
  };
  const polling = createPollingHarness();
  const actionLog = [];
  const actions = {
    setActiveBatchId(batchId) {
      actionLog.push(["active", batchId]);
      store.dispatch(actionCreators.activeBatchIdChanged(batchId));
    },
    navigateToApp(appId) {
      actionLog.push(["navigate", appId]);
    },
  };
  const dialogOptions = [];
  const dialogs = {
    async open(options) {
      dialogOptions.push(options);
      return dialogChoice;
    },
    destroy() {},
  };
  const viewLog = [];
  const view = {
    elements: {},
    selectedRecentId: () => "",
    clearError: () => viewLog.push(["clear-error"]),
    showError: (guidance) => viewLog.push(["error", guidance]),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    setWorkspacePhase: (phase, message = "") => viewLog.push(["phase", phase, message]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createTasksController({
    root,
    api,
    store,
    polling,
    storage: { readActiveBatchId: () => "" },
    actions,
    dialogs,
    pollingScope: "app:tasks",
    app: { id: "tasks", label: "批次管理", windowTitle: "批次管理" },
  }, {
    createView: () => view,
  });
  return {
    root,
    store,
    calls,
    polling,
    actions,
    actionLog,
    dialogs,
    dialogOptions,
    view,
    viewLog,
    controller,
  };
}

function proxyControllerHarness({
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  dialogChoice = "confirm",
} = {}) {
  const root = new ProxyTestElement("main");
  const store = createStore({ reportError: () => {} });
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      return apiGet ? apiGet(url, options) : Promise.resolve(
        url === PROXY_ENDPOINTS.status ? rawProxyStatus() : rawProxySources(),
      );
    },
    post(url, payload, options) {
      calls.push(["post", url, payload, options]);
      return apiPost ? apiPost(url, payload, options) : Promise.resolve({});
    },
    put(url, payload, options) {
      calls.push(["put", url, payload, options]);
      return apiPut ? apiPut(url, payload, options) : Promise.resolve({});
    },
    delete(url, options) {
      calls.push(["delete", url, options]);
      return apiDelete ? apiDelete(url, options) : Promise.resolve({});
    },
  };
  const polling = createPollingHarness();
  const dialogOptions = [];
  const dialogs = {
    async open(options) {
      dialogOptions.push(options);
      return dialogChoice;
    },
    destroy() {},
  };
  const viewLog = [];
  const secretInputs = new Set();
  const view = {
    clearSecretInputs(scope = null) {
      for (const input of secretInputs) {
        if (!scope || input === scope.input || input.parentNode === scope) input.value = "";
      }
      viewLog.push(["clear-secrets"]);
    },
    clearInputValidation: () => viewLog.push(["clear-validation"]),
    setInputValidation: (input, result) => viewLog.push(["validation", result.valid, result.reason]),
    clearError: () => viewLog.push(["clear-error"]),
    showError: (error) => viewLog.push(["error", proxyErrorGuidance(error)]),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setWorkspacePhase: (phase) => viewLog.push(["phase", phase]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createProxyController({
    root,
    api,
    store,
    polling,
    dialogs,
    pollingScope: "app:proxy",
    app: { id: "proxy", label: "代理管理", windowTitle: "代理管理" },
  }, { createView: () => view });
  const submit = (kind, value, sourceId = "") => {
    const input = kind.startsWith("inline") ? new ProxyTestTextArea(value) : new ProxyTestInput(value);
    const form = new ProxyTestForm(kind, input, sourceId);
    secretInputs.add(input);
    root.emit("submit", form);
    return { form, input };
  };
  const click = (action, sourceId = "") => {
    const button = new ProxyTestButton(action);
    if (sourceId) {
      const card = new ProxyTestElement("article");
      card.dataset.sourceId = sourceId;
      button.parentNode = card;
    }
    root.emit("click", button);
    return button;
  };
  return {
    root, store, calls, polling, dialogs, dialogOptions, view, viewLog,
    secretInputs, controller, submit, click,
  };
}

function vaultControllerHarness({
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  dialogChoice = "confirm",
  initialSite = "danbooru",
} = {}) {
  const root = new VaultTestElement("main");
  const store = createStore({ reportError: () => {} });
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      if (apiGet) return apiGet(url, options);
      if (url === `${VAULT_ENDPOINTS.status}?view=vault`) return Promise.resolve(rawVaultSnapshot());
      throw new Error(`unexpected GET ${url}`);
    },
    post(url, payload, options) {
      calls.push(["post", url, payload, options]);
      return apiPost ? apiPost(url, payload, options) : Promise.resolve({});
    },
    put(url, payload, options) {
      calls.push(["put", url, payload, options]);
      return apiPut ? apiPut(url, payload, options) : Promise.resolve({});
    },
    delete(url, options) {
      calls.push(["delete", url, options]);
      return apiDelete ? apiDelete(url, options) : Promise.resolve({});
    },
  };
  const polling = createPollingHarness();
  const dialogOptions = [];
  const dialogLog = [];
  const dialogs = {
    async open(options) {
      dialogOptions.push(options);
      dialogLog.push(["open", options.title]);
      return typeof dialogChoice === "function"
        ? dialogChoice(options, dialogOptions.length - 1)
        : dialogChoice;
    },
    destroy() {
      dialogLog.push(["destroy"]);
    },
  };
  const proxyInput = new VaultTestInput("");
  proxyInput.setAttribute("data-vault-secret", "");
  const proxyForm = new VaultTestForm(proxyInput);
  let selectedSite = initialSite;
  const viewLog = [];
  const view = {
    elements: { proxyInput, proxyForm },
    selectedSite: () => selectedSite,
    selectSite(siteId, options = {}) {
      selectedSite = siteId;
      viewLog.push(["select", siteId, Boolean(options.focus)]);
    },
    clearSensitiveInputs() {
      proxyInput.value = "";
      viewLog.push(["clear-sensitive"]);
    },
    clearError: () => viewLog.push(["clear-error"]),
    showError(error) {
      const safe = error && typeof error === "object"
        ? { code: String(error.code || "request_failed"), status: Number(error.status || 0) }
        : { code: "request_failed", status: 0 };
      viewLog.push(["error", safe]);
    },
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    setWorkspacePhase: (phase) => viewLog.push(["phase", phase]),
    validateProxyInput() {
      const result = validateAuthorizationProxyInput(proxyInput.value);
      viewLog.push(["validation", result.valid, result.mode]);
      return result.valid;
    },
    toggleProxyVisibility: () => viewLog.push(["toggle-proxy"]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createVaultController({
    root,
    api,
    store,
    polling,
    dialogs,
    pollingScope: "app:vault",
    app: { id: "vault", label: "授权管理", windowTitle: "VAULT.CPL" },
  }, { createView: () => view });
  const click = (action) => {
    const button = new VaultTestButton(action);
    root.emit("click", button);
    return button;
  };
  const submitProxy = (value) => {
    proxyInput.value = value;
    root.emit("submit", proxyForm);
    return proxyInput;
  };
  return {
    root,
    store,
    calls,
    polling,
    dialogs,
    dialogOptions,
    dialogLog,
    proxyInput,
    proxyForm,
    view,
    viewLog,
    controller,
    click,
    submitProxy,
  };
}

function getCallUrl(call) {
  return call[1];
}

test("4A model：批次、地址、任务、错误分类与文件事实均为安全白名单", () => {
  const batch = sanitizeBatchDetail(rawBatch());
  const taskPage = sanitizeTaskPage({ items: [rawTask(), rawTask({
    id: "task-proxy",
    artifact_count: 0,
    artifact_bytes: 0,
    last_error_class: "proxy_exhausted",
  })] }, batch.id);
  const serialized = JSON.stringify({ batch, taskPage });

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("output_dir"), false);
  assert.equal(batch.sources[0].addresses[0].hasPlanningIssue, true);
  assert.equal(taskPage.tasks[0].addressId, "address-stage4");
  assert.equal(taskPage.tasks[0].artifactCount, 2);
  assert.equal(taskPage.tasks[0].artifactBytes, 5_242_880);
  assert.deepEqual(taskErrorCategory(taskPage.tasks[0].errorClass), {
    id: "authentication",
    label: "授权失效",
    kind: "warning",
    targetApp: "vault",
  });
  assert.equal(taskErrorCategory(taskPage.tasks[1].errorClass).id, "proxy");
  assert.deepEqual(taskRecoveryTargets(taskPage.tasks), {
    authSites: ["pixiv"],
    proxyIssue: true,
  });
  assert.deepEqual(taskFileFacts(taskPage.tasks), {
    taskCount: 2,
    taskWithFilesCount: 1,
    artifactCount: 2,
    artifactBytes: 5_242_880,
  });
  assert.equal(formatTaskBytes(5_242_880), "5.0 MiB");
  assert.equal(taskResultText(taskPage.tasks[0]), "授权失效 · 已记录 2 个文件 / 5.0 MiB");
  assert.equal(taskErrorCategory("authentication").id, "authentication");
  assert.equal(taskErrorCategory("network_timeout").id, "network");
  assert.equal(taskErrorCategory("rate_limit").id, "rate_limit");
  assert.equal(taskErrorCategory("extraction_error").id, "extraction");
  assert.equal(taskErrorCategory("artifact_write_failed").id, "storage");
  assert.equal(taskErrorCategory("cancelled").id, "cancelled");
  assert.equal(taskErrorCategory("backend_restart").id, "unknown");
  assert.equal(taskErrorCategory(""), null);
});

test("4A model：最近批次筛选、活动/终态与七种显式工作区状态", () => {
  const recent = sanitizeRecentBatches({ items: [
    rawBatch({ id: "batch-running", status: "running" }),
    rawBatch({ id: "batch-pending", status: "pending" }),
    rawBatch({ id: "batch-starting", status: "starting" }),
    rawBatch({ id: "batch-errors", status: "completed_with_errors", resumable: true }),
    rawBatch({ id: "batch-done", status: "succeeded" }),
    rawBatch({ id: "batch-cancelled", status: "cancelled" }),
  ] });
  assert.deepEqual(filterRecentBatches(recent, "active").map((item) => item.id), [
    "batch-running", "batch-pending", "batch-starting",
  ]);
  assert.deepEqual(filterRecentBatches(recent, "attention").map((item) => item.id), [
    "batch-errors", "batch-cancelled",
  ]);
  assert.deepEqual(filterRecentBatches(recent, "terminal").map((item) => item.id), [
    "batch-errors", "batch-done", "batch-cancelled",
  ]);
  assert.throws(() => filterRecentBatches(recent, "unknown"), TypeError);

  const running = sanitizeBatchDetail(rawBatch({ status: "running" }));
  const terminal = sanitizeBatchDetail(rawBatch({ status: "cancelled" }));
  assert.equal(shouldPollBatch(running), true);
  assert.equal(shouldPollBatch(terminal), false);
  assert.equal(TERMINAL_BATCH_STATUSES.has("cancelled"), true);

  const states = [
    ["loading", { phase: "loading", batch: null }],
    ["empty", { phase: "idle", batch: null }],
    ["content", { phase: "idle", batch: running }],
    ["partial", { phase: "partial", batch: running }],
    ["error", { phase: "error", batch: null }],
    ["terminal", { phase: "idle", batch: terminal }],
    ["writing", { phase: "writing", batch: terminal }],
  ];
  for (const [expected, input] of states) {
    const presentation = deriveTasksWorkspacePresentation(input);
    assert.equal(presentation.state, expected);
    assert.equal(Boolean(presentation.label), true);
    assert.equal(Boolean(presentation.message), true);
    assert.equal(["ready", "running", "warning", "error", "disabled"].includes(presentation.kind), true);
  }
});

test("4A model：404/409/422/transport/auth/proxy 错误只产生安全分类与恢复动作", () => {
  const cases = [
    [{ status: 404, code: "crawl_not_found", requestId: "request-404", details: SECRET }, "diagnostics", "批次不存在"],
    [{ status: 409, code: "crawl_not_finished", message: `https://private/${SECRET}` }, "diagnostics", "批次状态已变化"],
    [{ status: 422, code: "invalid_crawl", message: `/private/${SECRET}` }, "diagnostics", "批次参数无效"],
    [{ status: 0, code: "network_error", message: SECRET }, "diagnostics", "批次操作失败"],
    [{ status: 401, code: "credentials_unavailable" }, "vault", "批次操作失败"],
    [{ status: 503, code: "proxy_pool_unavailable" }, "proxy", "批次操作失败"],
  ];
  for (const [error, targetApp, title] of cases) {
    const guidance = taskErrorGuidance(error);
    assert.equal(guidance.targetApp, targetApp);
    assert.equal(guidance.title, title);
    assert.equal(Boolean(guidance.message), true);
    assert.equal(Boolean(guidance.nextStep), true);
    assert.equal(JSON.stringify(guidance).includes(SECRET), false);
    assert.equal(JSON.stringify(guidance).includes("https://"), false);
    assert.equal(JSON.stringify(guidance).includes("/private/"), false);
  }
});

test("4A model/controller：批次 ID 严格校验、编码与 crawl-media 批次重试路径", () => {
  assert.equal(validateBatchId("batch:stage4.1"), "batch:stage4.1");
  assert.equal(taskBatchPath("batch:stage4.1"), "/api/v1/crawls/batch%3Astage4.1");
  assert.equal(taskBatchPath("batch:stage4.1", "/tasks?limit=1000"), "/api/v1/crawls/batch%3Astage4.1/tasks?limit=1000");
  assert.equal(taskBatchPath("batch:stage4.1", "/retry"), "/api/v1/crawls/batch%3Astage4.1/retry");
  for (const invalid of ["", " batch", "batch ", "../batch", "batch/child", "批次", "a".repeat(129)]) {
    assert.throws(() => validateBatchId(invalid), TypeError, invalid);
    assert.throws(() => taskBatchPath(invalid), TypeError, invalid);
  }
  assert.doesNotMatch(TASKS_APP_SOURCE, /\/api\/v1\/tasks/);
  assert.match(TASKS_APP_SOURCE, /taskBatchPath\(batchId, "\/retry"\)/);
});

test("4A request gate：写入和生命周期推进使旧 detail/tasks 读取不可提交", () => {
  const gate = createBatchRequestGate();
  const first = gate.beginRead("batch-stage4");
  const second = gate.beginRead("batch-stage4");
  assert.equal(gate.isReadCurrent(second, "batch-stage4"), true);
  assert.equal(gate.isReadCurrent(first, "batch-stage4"), false);

  const beforeWrite = gate.beginRead("batch-stage4");
  const write = gate.beginWrite();
  assert.equal(gate.isReadCurrent(beforeWrite, "batch-stage4"), false);
  assert.equal(gate.isWriteCurrent(write), true);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
});

test("4A controller：1.5s 只轮询活动批次，权威终态到达后停止", async () => {
  const restore = installControllerDom();
  try {
    let detail = rawBatch({ status: "running" });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [detail] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask({ status: "running", last_error_class: "" })] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(detail);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();

    const poll = harness.polling.entries.get("batches.active");
    assert.equal(poll.intervalMs, TASK_POLL_INTERVAL_MS);
    assert.equal(poll.intervalMs, 1_500);
    assert.equal(poll.scope, "app:tasks");
    assert.equal(shouldPollBatch(harness.store.getState().batches.active), true);

    detail = rawBatch({ status: "succeeded", task_count: 1, succeeded_task_count: 1, failed_task_count: 0 });
    await poll.task(new AbortController().signal);
    await flush();
    assert.equal(harness.store.getState().batches.active.status, "succeeded");
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "terminal"), true);

    harness.controller.deactivate();
    assert.equal(harness.polling.entries.has("batches.active"), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：无活动批次时只读 recent，不启动轮询", async () => {
  const restore = installControllerDom();
  try {
    const harness = controllerHarness({
      activeBatchId: "",
      apiGet(url) {
        assert.equal(url, "/api/v1/crawls?limit=30");
        return Promise.resolve({ items: [rawBatch({ id: "batch-recent-only" })] });
      },
    });
    harness.controller.activate();
    await flush();
    assert.deepEqual(harness.calls.map(getCallUrl), ["/api/v1/crawls?limit=30"]);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.equal(harness.store.getState().batches.active, null);
    assert.equal(harness.store.getState().batches.recent[0].id, "batch-recent-only");
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "empty"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：404 清 active/snapshot，错误恢复不保留陈旧 Store", async () => {
  const restore = installControllerDom();
  try {
    const missing = Object.assign(new Error(SECRET), {
      status: 404,
      code: "crawl_not_found",
      requestId: "request-stage4",
    });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.reject(missing);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.store.dispatch(actionCreators.batchSnapshotReceived(rawBatch(), { items: [rawTask()] }));
    harness.controller.activate();
    await flush();

    assert.equal(harness.store.getState().batches.activeId, "");
    assert.equal(harness.store.getState().batches.active, null);
    assert.deepEqual(harness.store.getState().batches.tasks, []);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.deepEqual(harness.actionLog.at(-1), ["active", ""]);
    assert.equal(JSON.stringify(harness.viewLog).includes(SECRET), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "message" && entry[1].includes("已不存在")), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：取消确认被拒绝时不写入且活动轮询继续", async () => {
  const restore = installControllerDom();
  try {
    const running = rawBatch({ status: "running" });
    const harness = controllerHarness({
      dialogChoice: "cancel",
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [running] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask({ status: "running", last_error_class: "" })] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(running);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    harness.root.emit("click", new TestButton("cancel"));
    await flush();
    assert.equal(harness.dialogOptions.length, 1);
    assert.equal(harness.dialogOptions[0].dangerous, true);
    assert.equal(harness.calls.some((call) => call[0] === "post"), false);
    assert.equal(harness.polling.entries.has("batches.active"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：危险重试确认后只走批次路径，并按 detail/tasks/recent 权威重读", async () => {
  const restore = installControllerDom();
  try {
    const terminal = rawBatch({
      status: "completed_with_errors",
      resumable: true,
      task_count: 1,
      succeeded_task_count: 0,
      failed_task_count: 1,
    });
    let detailReads = 0;
    let taskReads = 0;
    let recentReads = 0;
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") {
          recentReads += 1;
          return Promise.resolve({ items: [terminal] });
        }
        if (url.endsWith("/tasks?limit=1000")) {
          taskReads += 1;
          return Promise.resolve({ items: [rawTask()] });
        }
        if (url === "/api/v1/crawls/batch-stage4") {
          detailReads += 1;
          return Promise.resolve(detailReads === 1 ? terminal : rawBatch({ status: "running", resumable: false }));
        }
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost: () => Promise.resolve({
        batch: rawBatch({ status: "succeeded" }),
        raw: SECRET,
      }),
    });
    harness.controller.activate();
    await flush();
    const before = { detailReads, taskReads, recentReads };

    harness.root.emit("click", new TestButton("retry"));
    await flush();

    const post = harness.calls.find((call) => call[0] === "post");
    assert.equal(getCallUrl(post), "/api/v1/crawls/batch-stage4/retry");
    assert.deepEqual(post[2], { additional_attempts: 2 });
    assert.equal(harness.dialogOptions.length, 1);
    assert.equal(harness.dialogOptions[0].dangerous, true);
    assert.equal(Boolean(harness.dialogOptions[0].confirmationText), true);
    assert.equal(detailReads, before.detailReads + 1);
    assert.equal(taskReads, before.taskReads + 1);
    assert.equal(recentReads, before.recentReads + 1);
    assert.equal(harness.store.getState().batches.active.status, "running");
    assert.equal(JSON.stringify(harness.store.getState()).includes(SECRET), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "writing"), true);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "content"), true);
    assert.equal(harness.calls.some((call) => getCallUrl(call).includes("/api/v1/tasks")), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：取消与重新规划使用精确空 payload，并各自 detail/tasks/recent 权威重读", async () => {
  const restore = installControllerDom();
  try {
    const cases = [
      {
        action: "cancel",
        initial: rawBatch({ status: "running", resumable: false }),
        authoritative: rawBatch({
          status: "cancelled",
          resumable: false,
          task_count: 1,
          succeeded_task_count: 0,
          failed_task_count: 0,
          cancelled_task_count: 1,
        }),
        path: "/api/v1/crawls/batch-stage4/cancel",
      },
      {
        action: "rerun",
        initial: rawBatch({
          status: "succeeded",
          resumable: false,
          task_count: 1,
          succeeded_task_count: 1,
          failed_task_count: 0,
        }),
        authoritative: rawBatch({
          status: "planning",
          resumable: false,
          task_count: 0,
          succeeded_task_count: 0,
          failed_task_count: 0,
        }),
        path: "/api/v1/crawls/batch-stage4/rerun",
      },
    ];
    for (const item of cases) {
      let detailReads = 0;
      let taskReads = 0;
      let recentReads = 0;
      const harness = controllerHarness({
        apiGet(url) {
          if (url === "/api/v1/crawls?limit=30") {
            recentReads += 1;
            return Promise.resolve({ items: [detailReads > 1 ? item.authoritative : item.initial] });
          }
          if (url.endsWith("/tasks?limit=1000")) {
            taskReads += 1;
            return Promise.resolve({ items: [rawTask({
              status: detailReads > 1 ? "cancelled" : "running",
              last_error_class: "",
            })] });
          }
          if (url === "/api/v1/crawls/batch-stage4") {
            detailReads += 1;
            return Promise.resolve(detailReads === 1 ? item.initial : item.authoritative);
          }
          throw new Error(`unexpected GET ${url}`);
        },
        apiPost: () => Promise.resolve({
          batch: rawBatch({ status: "failed" }),
          ignored_secret: SECRET,
        }),
      });
      harness.controller.activate();
      await flush();
      const before = { detailReads, taskReads, recentReads };

      harness.root.emit("click", new TestButton(item.action));
      await flush();

      const posts = harness.calls.filter((call) => call[0] === "post");
      assert.equal(posts.length, 1, item.action);
      assert.equal(getCallUrl(posts[0]), item.path);
      assert.deepEqual(posts[0][2], {});
      assert.equal(detailReads, before.detailReads + 1);
      assert.equal(taskReads, before.taskReads + 1);
      assert.equal(recentReads, before.recentReads + 1);
      assert.equal(harness.store.getState().batches.active.status, item.authoritative.status);
      assert.equal(JSON.stringify(harness.store.getState()).includes(SECRET), false);
      assert.equal(harness.dialogOptions.length, 1);
      assert.equal(harness.dialogOptions[0].dangerous, true);
      harness.controller.destroy();
    }
  } finally {
    restore();
  }
});

test("4A controller：写后权威重读失败保留 partial 非颜色状态", async () => {
  const restore = installControllerDom();
  try {
    const terminal = rawBatch({ status: "completed_with_errors", resumable: true });
    let detailReads = 0;
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30" && detailReads <= 1) {
          return Promise.resolve({ items: [terminal] });
        }
        if (url.endsWith("/tasks?limit=1000") && detailReads <= 1) {
          return Promise.resolve({ items: [rawTask()] });
        }
        if (url === "/api/v1/crawls/batch-stage4" && detailReads === 0) {
          detailReads += 1;
          return Promise.resolve(terminal);
        }
        return Promise.reject(Object.assign(new Error(SECRET), {
          status: 503,
          code: "proxy_pool_unavailable",
        }));
      },
      apiPost: () => Promise.resolve({ ignored: SECRET }),
    });
    harness.controller.activate();
    await flush();
    harness.root.emit("click", new TestButton("retry"));
    await flush();

    assert.equal(harness.store.getState().batches.active.status, "completed_with_errors");
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "partial"), true);
    assert.equal(JSON.stringify(harness.viewLog).includes(SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：deactivate 后写响应与后续读取均不得污染 Store", async () => {
  const restore = installControllerDom();
  try {
    const write = deferred();
    const terminal = rawBatch({ status: "completed_with_errors", resumable: true });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [terminal] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask()] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(terminal);
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost: () => write.promise,
    });
    harness.controller.activate();
    await flush();
    const authoritative = harness.store.getState().batches.active;

    harness.root.emit("click", new TestButton("retry"));
    await flush();
    const callsBeforeDeactivate = harness.calls.length;
    harness.controller.deactivate();
    write.resolve({ batch: rawBatch({ status: "running" }), secret: SECRET });
    await flush();

    assert.equal(harness.store.getState().batches.active, authoritative);
    assert.equal(harness.calls.length, callsBeforeDeactivate);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A view：三段语义、筛选/终态、来源地址任务错误文件事实与恢复动作", () => {
  assert.equal(typeof createTasksView, "function");
  assert.equal(typeof taskResultText, "function");
  for (const contract of [
    /createElement\("aside"/,
    /createElement\("main"/,
    /tasks-workspace-track/,
    /最近批次/,
    /批次筛选/,
    /活动批次|当前活动/,
    /来源地址与任务/,
    /错误分类/,
    /文件事实/,
    /取消批次/,
    /重试未完成项/,
    /重新规划/,
    /打开授权管理/,
    /打开代理管理/,
    /打开去重审核/,
    /data.*tasks.*workspace|tasksWorkspace/,
    /tabindex/,
  ]) assert.match(TASKS_VIEW_SOURCE, contract);
  for (const state of ["loading", "content", "partial", "error", "terminal", "writing"]) {
    assert.match(TASKS_MODEL_SOURCE + TASKS_VIEW_SOURCE, new RegExp(`\\b${state}\\b`));
  }
  assert.match(TASKS_VIEW_SOURCE, /尚未选择批次|暂无批次/);
  assert.doesNotMatch(TASKS_VIEW_SOURCE, /VAULT\.CPL|TASKMGR\.EXE|PROXY\.CPL/);
});

test("4A CSS T7.2：三栏低透明、事实扁平、状态非颜色且只由窗口持有 backdrop", () => {
  const block = (selector) => {
    const marker = `${selector} {`;
    const start = TASKS_CSS_SOURCE.indexOf(marker);
    assert.notEqual(start, -1, selector);
    const opening = TASKS_CSS_SOURCE.indexOf("{", start);
    const closing = TASKS_CSS_SOURCE.indexOf("}", opening);
    return TASKS_CSS_SOURCE.slice(opening + 1, closing);
  };

  assert.match(TASKS_CSS_SOURCE, /\.window-body:has\(> \.tasks-app\)/);
  const workspace = block(".tasks-workspace");
  assert.match(workspace, /padding:\s*24px/);
  assert.match(workspace, /overflow-x:\s*auto/);
  assert.match(workspace, /overflow-y:\s*hidden/);
  const track = block(".tasks-workspace-track");
  assert.match(track, /grid-template-columns:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(track, /min-width:\s*1120px/);
  assert.match(track, /gap:\s*24px/);
  assert.match(block(".tasks-column-scroll"), /overflow-y:\s*auto/);
  assert.match(TASKS_CSS_SOURCE, /\.application-window\[data-maximized\] \.tasks-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);

  const column = block(".tasks-column");
  assert.match(column, /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(column, /border-radius:\s*var\(--imageweave-radius-card\)/);
  assert.match(column, /background:\s*var\(--imageweave-glass-surface-input\)/);
  assert.doesNotMatch(column, /backdrop-filter|var\(--imageweave-shadow-/);
  assert.match(block(".tasks-column--recent"), /background:\s*var\(--imageweave-glass-surface-secondary\)/);

  const solidRefs = [...TASKS_CSS_SOURCE.matchAll(/--imageweave-[\w-]*-solid/g)].map((match) => match[0]);
  assert.deepEqual(solidRefs, ["--imageweave-fallback-elevated-solid"]);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /--imageweave-state-[\w-]*-surface/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /^\s*(?:-webkit-)?backdrop-filter\s*:(?![^\n]*\bnone\b)/m);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /^\s*filter\s*:/m);
  for (const selector of [".tasks-metric", ".tasks-source-card", ".tasks-address", ".tasks-table-wrap"]) {
    const body = block(selector);
    assert.match(body, /border-radius:\s*var\(--imageweave-radius-control\)/, selector);
    assert.match(body, /background:\s*var\(--imageweave-glass-surface-(?:weak|secondary)\)/, selector);
    assert.match(body, /box-shadow:\s*none/, selector);
  }
  assert.match(block(".tasks-list"), /min-width:\s*0/);
  assert.match(block(".tasks-table-wrap"), /min-width:\s*0/);
  assert.match(block(".tasks-table-wrap"), /max-width:\s*100%/);
  assert.match(block(".tasks-table"), /min-width:\s*790px/);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-metric strong[\s\S]*?color:\s*var\(--imageweave-text-code\)[\s\S]*?font-family:\s*var\(--imageweave-font-mono\)/);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-address--current::before[\s\S]*?content:\s*"◆ 当前地址"/);
  const current = block(".tasks-address--current");
  assert.match(current, /border-color:\s*var\(--imageweave-border-focus\)/);
  assert.match(current, /background:\s*var\(--imageweave-glass-surface-input\)/);
  assert.match(current, /box-shadow:\s*none/);
  assert.match(block(".tasks-recent-list option:checked"), /font-weight:\s*700/);

  const errorState = block('.tasks-workspace-state[data-tasks-workspace-state="error"]');
  assert.match(errorState, /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.match(errorState, /background:\s*var\(--imageweave-glass-surface-default\)/);
  assert.match(TASKS_CSS_SOURCE, /data-tasks-workspace-state="loading"[\s\S]*?var\(--imageweave-state-running\)/);
  assert.match(TASKS_CSS_SOURCE, /data-tasks-workspace-state="content"[\s\S]*?var\(--imageweave-state-success\)/);
  const tableHeader = block(".tasks-table th");
  assert.match(tableHeader, /color:\s*var\(--imageweave-text-primary\)/);
  assert.match(tableHeader, /background:\s*var\(--imageweave-glass-surface-default\)/);
  const tableHover = block(".tasks-table tbody tr:hover");
  assert.match(tableHover, /background:\s*var\(--imageweave-glass-surface-default\)/);
  assert.match(tableHover, /transform:\s*none/);

  const kicker = block(".tasks-column-kicker");
  assert.match(kicker, /letter-spacing:\s*normal/);
  assert.match(kicker, /text-transform:\s*none/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /(?:border-(?:left|right):\s*[34]px|inset\s+[34]px\s+0(?:px)?\s+0)/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /\b(?:100|120|150|180)ms\b/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /\.tasks-button--primary/);
  assert.match(TASKS_CSS_SOURCE, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  assert.match(TASKS_CSS_SOURCE, /background:\s*var\(--imageweave-fallback-elevated-solid\)/);
  assert.match(TASKS_CSS_SOURCE, /@media \(prefers-contrast: more\)/);
  assert.match(TASKS_CSS_SOURCE, /@media \(forced-colors: active\)/);
  assert.match(TASKS_CSS_SOURCE, /:root\[data-motion="off"\]/);
  assert.match(TASKS_CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);

  assert.match(TASKS_VIEW_SOURCE, /className:\s*"tasks-workspace"[\s\S]*tabindex:\s*"0"/);
  assert.match(TASKS_VIEW_SOURCE, /当前活动地址/);
  assert.match(TASKS_VIEW_SOURCE, /aria-label.*当前地址/s);
});

test("4A static boundary：唯一 crawls endpoint、无旁路 I/O/storage/console/innerHTML 且生命周期不变", () => {
  assert.deepEqual(TASKS_ENDPOINTS, { crawls: "/api/v1/crawls" });
  assert.equal(TASKS_APP_SOURCE.split('"/api/v1/crawls"').length - 1, 1);
  assert.equal((TASKS_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 1);
  const combined = [TASKS_APP_SOURCE, TASKS_MODEL_SOURCE, TASKS_VIEW_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(TASKS_APP_SOURCE, /requestGate/);
  assert.match(TASKS_APP_SOURCE, /advanceLifecycle/);
  assert.match(TASKS_APP_SOURCE, /\.abort\(\)/);
  assert.match(TASKS_APP_SOURCE, /Promise\.all\(/);
  assert.match(TASKS_APP_SOURCE, /Promise\.allSettled\(/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof tasksApplication[hook], "function");
  }
  assert.equal(typeof createTasksController, "function");
});

test("4B model：状态与来源只投影安全事实，秘密 marker 不进入 Store", () => {
  const status = sanitizeProxyStatus(rawProxyStatus());
  const sources = sanitizeProxySources(rawProxySources());
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.proxyStatusReceived(rawProxyStatus()));
  store.dispatch(actionCreators.proxySourcesReceived(rawProxySources()));
  const serialized = JSON.stringify({ status, sources, store: store.getState().proxy });
  assert.equal(serialized.includes(PROXY_SECRET), false);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(sources.subscriptions[0].display_url, "https://provider.fixture.invalid:443/…");
  assert.equal(sources.node_file.display_path, "路径已隐藏");
  assert.equal(sources.inline_nodes[0].display_endpoint, "vless://***@proxy.fixture.invalid:443#JP-01");
});

test("4B model：显式状态、保存≠应用、控制矩阵和实时 validation", () => {
  const loading = deriveProxyWorkspacePresentation();
  const partial = deriveProxyWorkspacePresentation({ status: sanitizeProxyStatus(rawProxyStatus()) });
  const disabled = deriveProxyWorkspacePresentation({
    status: sanitizeProxyStatus(rawProxyStatus({ enabled: false })),
    sources: sanitizeProxySources(rawProxySources()),
  });
  const waiting = deriveProxyWorkspacePresentation({
    status: sanitizeProxyStatus(rawProxyStatus()),
    sources: sanitizeProxySources(rawProxySources()),
  });
  const running = deriveProxyWorkspacePresentation({
    status: sanitizeProxyStatus(rawProxyStatus({
      running: true,
      active_revision: PROXY_CONFIGURED_REVISION,
      reload_required: false,
    })),
    sources: sanitizeProxySources(rawProxySources({
      active_revision: PROXY_CONFIGURED_REVISION,
      reload_required: false,
    })),
  });
  assert.deepEqual([loading.state, partial.state, disabled.state, waiting.state, running.state], [
    "loading", "partial", "disabled", "reload-required", "running",
  ]);
  assert.match(waiting.message, /已保存.*尚未应用/);
  assert.equal(formatRevisionPair(PROXY_CONFIGURED_REVISION, PROXY_ACTIVE_REVISION).relation, "有更新");
  assert.equal(formatRevisionPair(PROXY_CONFIGURED_REVISION, PROXY_CONFIGURED_REVISION).relation, "已生效");

  const controls = deriveProxyControls(sanitizeProxyStatus(rawProxyStatus()));
  assert.equal(controls.start.disabled, false);
  assert.equal(controls.stop.disabled, true);
  assert.equal(controls.reload.disabled, false);
  assert.equal(controls.probe.disabled, true);
  const active = deriveProxyControls(sanitizeProxyStatus(rawProxyStatus({ running: true })));
  assert.equal(active.start.disabled, true);
  assert.equal(active.stop.disabled, false);
  assert.equal(active.probe.disabled, false);

  assert.equal(validateSubscriptionInput("https://user:pass@provider.invalid/private?token=x").valid, true);
  assert.equal(validateSubscriptionInput("ftp://provider.invalid/private").reason, "unsupported_scheme");
  assert.equal(validateSubscriptionInput("https://").reason, "malformed");
  assert.equal(validateNodeFileInput("../subscriptions/nodes.yaml").valid, true);
  assert.equal(validateNodeFileInput("bad\u0000path").reason, "control_character");
  assert.deepEqual(
    validateInlineNodeInput("vless://uuid@proxy.invalid:443#one\nhttp://user:pass@proxy.invalid:8080", { multiple: true }).value,
    ["vless://uuid@proxy.invalid:443#one", "http://user:pass@proxy.invalid:8080"],
  );
  assert.equal(validateInlineNodeInput("ftp://proxy.invalid:21").reason, "unsupported_scheme");
});

test("4B request gate：同类旧读取、写前读取和生命周期响应均失效", () => {
  const gate = createProxyRequestGate();
  const firstStatus = gate.beginRead("status");
  const secondStatus = gate.beginRead("status");
  const sources = gate.beginRead("sources");
  assert.equal(gate.isReadCurrent(secondStatus), true);
  assert.equal(gate.isReadCurrent(firstStatus), false);
  assert.equal(gate.isReadCurrent(sources), true);
  const beforeWrite = gate.beginRead("sources");
  const write = gate.beginWrite();
  assert.equal(gate.isReadCurrent(beforeWrite), false);
  assert.equal(gate.isWriteCurrent(write), true);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
  assert.throws(() => gate.beginRead("vault"), TypeError);
});

test("4B controller：仅 active app 每 10s poll，deactivate 停止且 reactivate 恢复，destroy 终止", async () => {
  const restore = installProxyControllerDom();
  try {
    const harness = proxyControllerHarness();
    harness.controller.activate();
    await flush();
    const poll = harness.polling.entries.get("proxy.status");
    assert.equal(poll.intervalMs, PROXY_STATUS_POLL_INTERVAL_MS);
    assert.equal(poll.intervalMs, 10_000);
    assert.equal(poll.scope, "app:proxy");
    assert.equal(poll.immediate, true);
    assert.equal(poll.critical, false);
    assert.equal(poll.resume, "immediate");
    assert.equal(harness.calls.filter((call) => call[0] === "get" && call[1] === PROXY_ENDPOINTS.sources).length, 1);
    harness.controller.deactivate();
    assert.equal(harness.polling.entries.has("proxy.status"), false);

    harness.controller.activate();
    await flush();
    assert.equal(harness.polling.starts.length, 2);
    assert.equal(harness.polling.entries.has("proxy.status"), true);
    assert.equal(harness.calls.filter((call) => call[0] === "get" && call[1] === PROXY_ENDPOINTS.sources).length, 2);
    harness.controller.destroy();
    assert.equal(harness.polling.entries.has("proxy.status"), false);
  } finally {
    restore();
  }
});

test("4B controller：status/sources 并发且旧响应、写前响应、destroy 后响应不污染 Store", async () => {
  const restore = installProxyControllerDom();
  try {
    const status = deferred();
    const sources = deferred();
    const write = deferred();
    const harness = proxyControllerHarness({
      apiGet(url) {
        if (url === PROXY_ENDPOINTS.status) return status.promise;
        if (url === PROXY_ENDPOINTS.sources) return sources.promise;
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost: () => write.promise,
    });
    harness.controller.activate();
    await flush();
    const poll = harness.polling.entries.get("proxy.status");
    const pollPromise = poll.task(new AbortController().signal);
    await flush();
    assert.deepEqual(harness.calls.filter((call) => call[0] === "get").map(getCallUrl).sort(), [
      PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status,
    ].sort());

    harness.click("start");
    await flush();
    status.resolve(rawProxyStatus({ running: true }));
    sources.resolve(rawProxySources());
    await pollPromise;
    await flush();
    assert.equal(harness.store.getState().proxy.status, null);
    assert.equal(harness.store.getState().proxy.sources, null);

    harness.controller.destroy();
    write.resolve({ secret: PROXY_SECRET });
    await flush();
    assert.equal(harness.store.getState().proxy.status, null);
    assert.equal(harness.store.getState().proxy.sources, null);
    assert.equal(JSON.stringify(harness.viewLog).includes(PROXY_SECRET), false);
  } finally {
    restore();
  }
});

test("4B controller：五种 source create/update 精确 payload，保存≠reload 且每次双权威重读", async () => {
  const restore = installProxyControllerDom();
  try {
    let statusReads = 0;
    let sourceReads = 0;
    const harness = proxyControllerHarness({
      apiGet(url) {
        if (url === PROXY_ENDPOINTS.status) {
          statusReads += 1;
          return Promise.resolve(rawProxyStatus({ running: statusReads > 2 }));
        }
        if (url === PROXY_ENDPOINTS.sources) {
          sourceReads += 1;
          return Promise.resolve(rawProxySources());
        }
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    const initialPoll = harness.polling.entries.get("proxy.status");
    await initialPoll.task(new AbortController().signal);
    await flush();

    const runSourceWrite = async (kind, value, sourceId, method, endpoint, payload) => {
      const beforeCalls = harness.calls.length;
      const beforeReads = { statusReads, sourceReads };
      const submitted = harness.submit(kind, value, sourceId);
      assert.equal(submitted.input.value, "", `${kind} must clear before request settles`);
      await flush();
      assert.equal(submitted.input.value, "", `${kind} must remain clear after authority reads`);
      const operationCalls = harness.calls.slice(beforeCalls);
      const write = operationCalls.find((call) => call[0] === method && call[1] === endpoint);
      assert.equal(Boolean(write), true, kind);
      assert.deepEqual(write[2], payload, kind);
      assert.deepEqual(
        operationCalls.filter((call) => call[0] === "get").map(getCallUrl).sort(),
        [PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status].sort(),
        kind,
      );
      assert.equal(statusReads, beforeReads.statusReads + 1, kind);
      assert.equal(sourceReads, beforeReads.sourceReads + 1, kind);
    };

    const subscription = `https://user:${PROXY_SECRET}@provider.invalid/private?token=${PROXY_SECRET}`;
    await runSourceWrite(
      "subscription-add", subscription, "", "post", PROXY_ENDPOINTS.subscriptions,
      { url: subscription },
    );
    const replacement = `https://user:${PROXY_SECRET}@replacement.invalid/new`;
    await runSourceWrite(
      "subscription-replace", replacement, PROXY_SUBSCRIPTION_ID, "put",
      `${PROXY_ENDPOINTS.subscriptions}/${PROXY_SUBSCRIPTION_ID}`,
      { url: replacement },
    );
    const nodePath = `../subscriptions/${PROXY_SECRET}.yaml`;
    await runSourceWrite(
      "node-file-set", nodePath, "", "put", PROXY_ENDPOINTS.nodeFile,
      { path: nodePath },
    );
    const inlineText = [
      `vless://${PROXY_SECRET}@proxy.invalid:443#one`,
      `http://user:${PROXY_SECRET}@proxy.invalid:8080`,
    ].join("\n");
    await runSourceWrite(
      "inline-add", inlineText, "", "post", PROXY_ENDPOINTS.inlineNodes,
      { nodes: inlineText.split("\n") },
    );
    const inlineReplacement = `trojan://${PROXY_SECRET}@replacement.invalid:443#two`;
    await runSourceWrite(
      "inline-replace", inlineReplacement, PROXY_INLINE_ID, "put",
      `${PROXY_ENDPOINTS.inlineNodes}/${PROXY_INLINE_ID}`,
      { node: inlineReplacement },
    );

    assert.equal(harness.calls.some((call) => call[1] === PROXY_ENDPOINTS.reload), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "message" && /尚未改变|不会重新显示/.test(entry[1])), true);
    const beforeReload = { statusReads, sourceReads };
    harness.click("reload");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "post" && call[1] === PROXY_ENDPOINTS.reload), true);
    assert.equal(statusReads, beforeReload.statusReads + 1);
    assert.equal(sourceReads, beforeReload.sourceReads + 1);
    assert.equal(JSON.stringify(harness.store.getState()).includes(PROXY_SECRET), false);
  } finally {
    restore();
  }
});

test("4B controller：start/stop/reload/probe 精确 payload、单飞并各自写后双权威重读", async () => {
  const restore = installProxyControllerDom();
  try {
    const expected = {
      start: { force_refresh: true },
      stop: { force: false },
      reload: { force_refresh: true },
      probe: {},
    };
    for (const action of Object.keys(expected)) {
      const harness = proxyControllerHarness();
      harness.controller.activate();
      const poll = harness.polling.entries.get("proxy.status");
      await poll.task(new AbortController().signal);
      await flush();
      const before = harness.calls.length;
      harness.click(action);
      harness.click(action);
      await flush();
      const operationCalls = harness.calls.slice(before).filter((call) => call[0] === "post");
      assert.equal(operationCalls.length, 1, action);
      assert.equal(operationCalls[0][1], PROXY_ENDPOINTS[action], action);
      assert.deepEqual(operationCalls[0][2], expected[action], action);
      const reads = harness.calls.slice(before).filter((call) => call[0] === "get").map(getCallUrl).sort();
      assert.deepEqual(reads, [PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status].sort(), action);
      harness.controller.destroy();
    }
  } finally {
    restore();
  }
});

test("4B controller：四种 delete/reset confirm deny/allow，允许后精确删除并双权威重读", async () => {
  const restore = installProxyControllerDom();
  try {
    const deny = proxyControllerHarness({ dialogChoice: "cancel" });
    deny.controller.activate();
    await flush();
    deny.click("subscription-delete", PROXY_SUBSCRIPTION_ID);
    await flush();
    assert.equal(deny.dialogOptions[0].dangerous, true);
    assert.match(deny.dialogOptions[0].confirmationText, /应用并重新加载/);
    assert.equal(deny.calls.some((call) => call[0] === "delete"), false);
    deny.controller.destroy();

    const allow = proxyControllerHarness();
    allow.controller.activate();
    await flush();
    const operations = [
      ["subscription-delete", PROXY_SUBSCRIPTION_ID, `${PROXY_ENDPOINTS.subscriptions}/${PROXY_SUBSCRIPTION_ID}`],
      ["inline-delete", PROXY_INLINE_ID, `${PROXY_ENDPOINTS.inlineNodes}/${PROXY_INLINE_ID}`],
      ["node-file-clear", "", PROXY_ENDPOINTS.nodeFile],
      ["override-reset", "", PROXY_ENDPOINTS.override],
    ];
    for (const [action, sourceId, endpoint] of operations) {
      const before = allow.calls.length;
      const dialogCount = allow.dialogOptions.length;
      allow.click(action, sourceId);
      await flush();
      assert.equal(allow.dialogOptions.length, dialogCount + 1, action);
      assert.equal(allow.dialogOptions.at(-1).dangerous, true, action);
      const operationCalls = allow.calls.slice(before);
      assert.equal(operationCalls.filter((call) => call[0] === "delete" && call[1] === endpoint).length, 1, action);
      assert.deepEqual(
        operationCalls.filter((call) => call[0] === "get").map(getCallUrl).sort(),
        [PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status].sort(),
        action,
      );
    }
    allow.controller.destroy();
  } finally {
    restore();
  }
});

test("4B controller：secret/raw 输入在成功、失败、取消、deactivate、destroy 全部立即清空", async () => {
  const restore = installProxyControllerDom();
  try {
    const failed = proxyControllerHarness({
      apiPost: () => Promise.reject(Object.assign(new Error(PROXY_SECRET), {
        status: 422,
        code: "invalid_proxy_subscription",
        details: { raw: PROXY_SECRET },
      })),
    });
    failed.controller.activate();
    await flush();
    const invalid = failed.submit("subscription-add", "ftp://bad.invalid/private");
    assert.equal(invalid.input.value, "");
    assert.equal(failed.calls.some((call) => call[0] === "post"), false);
    const rejected = failed.submit("subscription-add", `https://user:${PROXY_SECRET}@bad.invalid/private`);
    assert.equal(rejected.input.value, "");
    await flush();
    assert.equal(rejected.input.value, "");
    assert.equal(JSON.stringify(failed.viewLog).includes(PROXY_SECRET), false);
    failed.controller.destroy();

    const cancelled = proxyControllerHarness({ dialogChoice: "cancel" });
    cancelled.controller.activate();
    await flush();
    const cancelInput = new ProxyTestInput(PROXY_SECRET);
    cancelled.secretInputs.add(cancelInput);
    const replacementForm = new ProxyTestForm("subscription-replace", cancelInput, PROXY_SUBSCRIPTION_ID);
    const replacementCancel = new ProxyTestButton("replacement-cancel");
    replacementCancel.parentNode = replacementForm;
    cancelled.root.emit("click", replacementCancel);
    await flush();
    assert.equal(cancelInput.value, "");
    assert.equal(replacementForm.hidden, true);
    cancelInput.value = PROXY_SECRET;
    cancelled.click("subscription-delete", PROXY_SUBSCRIPTION_ID);
    await flush();
    assert.equal(cancelInput.value, "");
    cancelInput.value = PROXY_SECRET;
    cancelled.controller.deactivate();
    assert.equal(cancelInput.value, "");
    cancelled.controller.destroy();

    const destroyed = proxyControllerHarness();
    destroyed.controller.activate();
    await flush();
    const destroyInput = new ProxyTestInput(PROXY_SECRET);
    destroyed.secretInputs.add(destroyInput);
    destroyed.controller.destroy();
    assert.equal(destroyInput.value, "");
  } finally {
    restore();
  }
});

test("4B CSS T7.3a：Proxy 三栏低透明、事实扁平、敏感控件复用 T6 且窗口独占 backdrop", () => {
  const block = (selector) => {
    const marker = `${selector} {`;
    const start = PROXY_CSS_SOURCE.indexOf(marker);
    assert.notEqual(start, -1, selector);
    const opening = PROXY_CSS_SOURCE.indexOf("{", start);
    const closing = PROXY_CSS_SOURCE.indexOf("}", opening);
    return PROXY_CSS_SOURCE.slice(opening + 1, closing);
  };

  assert.match(PROXY_CSS_SOURCE, /\.window-body:has\(> \.proxy-app\)/);
  const workspace = block(".proxy-workspace");
  assert.match(workspace, /padding:\s*24px/);
  assert.match(workspace, /overflow-x:\s*auto/);
  assert.match(workspace, /overflow-y:\s*hidden/);
  const track = block(".proxy-workspace-track");
  assert.match(track, /grid-template-columns:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(track, /min-width:\s*1120px/);
  assert.match(track, /gap:\s*24px/);
  assert.match(block(".proxy-column-scroll"), /padding:\s*24px[\s\S]*overflow-y:\s*auto/);
  assert.match(PROXY_CSS_SOURCE, /\.application-window\[data-maximized\] \.proxy-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  const column = block(".proxy-column");
  assert.match(column, /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(column, /border-radius:\s*var\(--imageweave-radius-card\)/);
  assert.match(column, /background:\s*var\(--imageweave-glass-surface-input\)/);
  assert.match(column, /inset 0 1px 0[\s\S]*inset 0 -1px 0/);
  assert.doesNotMatch(column, /backdrop-filter|var\(--imageweave-shadow-/);
  assert.match(block(".proxy-column--status"), /background:\s*var\(--imageweave-glass-surface-secondary\)/);

  const solidRefs = [...PROXY_CSS_SOURCE.matchAll(/--imageweave-[\w-]*-solid/g)].map((match) => match[0]);
  assert.deepEqual(solidRefs, ["--imageweave-fallback-elevated-solid"]);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /--imageweave-state-[\w-]*-surface/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /^\s*(?:-webkit-)?backdrop-filter\s*:(?![^\n]*\bnone\b)/m);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /^\s*filter\s*:/m);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-node-card,[\s\S]*?\.proxy-metric\s*\{[\s\S]*?border-radius:\s*var\(--imageweave-radius-control\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-weak\)[\s\S]*?box-shadow:\s*none/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-definition-list > div,[\s\S]*?\.proxy-source-summary > div\s*\{[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)[\s\S]*?border-radius:\s*var\(--imageweave-radius-control\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-weak\)[\s\S]*?box-shadow:\s*none/);
  const flatSection = block(".proxy-source-overview");
  assert.match(flatSection, /border-bottom:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)/);
  assert.match(flatSection, /background:\s*transparent/);
  assert.match(flatSection, /box-shadow:\s*none/);
  assert.match(block(".proxy-metric"), /background:\s*var\(--imageweave-glass-surface-weak\)[\s\S]*box-shadow:\s*none/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-metric strong[\s\S]*?color:\s*var\(--imageweave-text-code\)[\s\S]*?font-family:\s*var\(--imageweave-font-mono\)/);

  const errorState = block('.proxy-waiting-host[data-proxy-workspace-state="error"]');
  assert.match(errorState, /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.match(errorState, /background:\s*var\(--imageweave-glass-surface-default\)/);
  for (const [state, token] of [
    ["loading", "running"], ["writing", "running"], ["running", "running"],
    ["partial", "warning"], ["reload-required", "warning"], ["stopped", "warning"],
    ["disabled", "disabled"],
  ]) {
    assert.match(PROXY_CSS_SOURCE, new RegExp(`data-proxy-workspace-state="${state}"[\\s\\S]*?--imageweave-state-${token}`), state);
  }
  const leased = block('.proxy-node-card[data-leased="true"]');
  assert.match(leased, /border-color:\s*var\(--imageweave-state-running\)/);
  assert.match(leased, /background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(leased, /box-shadow:\s*none/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-node-card\[data-leased="true"\]::before[\s\S]*?content:\s*"◆ 正在使用"/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-danger-zone\s*\{[\s\S]*?margin-top:\s*24px[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  const validation = block(".proxy-field-validation");
  assert.match(validation, /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.match(validation, /color:\s*var\(--imageweave-text-primary\)/);
  assert.match(validation, /background:\s*var\(--imageweave-glass-surface-default\)/);
  assert.match(block(".proxy-control-reasons"), /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)/);
  assert.match(block(".proxy-redaction-note"), /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-redaction-note::before[\s\S]*?content:\s*"◆ 安全投影 · "/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /(?:border-(?:left|right):\s*[34]px|inset\s+[34]px\s+0(?:px)?\s+0)/);

  const secretInput = block(".proxy-secret-input");
  assert.doesNotMatch(secretInput, /background|border|box-shadow|color/);
  assert.match(CONTROLS_CSS_SOURCE, /\.app-view :is\([\s\S]*?input\[type="url"\][\s\S]*?textarea[\s\S]*?background:\s*var\(--imageweave-glass-surface-input\)[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(CONTROLS_CSS_SOURCE, /\.proxy-button\.proxy-button--primary,[\s\S]*?border-color:\s*var\(--imageweave-accent\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/);
  assert.match(CONTROLS_CSS_SOURCE, /\.proxy-button\.proxy-button--dangerous,[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /\.proxy-button--primary|\.proxy-button--dangerous/);
  assert.match(PROXY_CSS_SOURCE, /:hover\s*\{[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)[\s\S]*?transform:\s*none/);
  const kicker = block(".proxy-column-kicker");
  assert.match(kicker, /letter-spacing:\s*normal/);
  assert.match(kicker, /text-transform:\s*none/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /\b(?:100|120|150|180)ms\b/);

  assert.match(PROXY_CSS_SOURCE, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  assert.match(PROXY_CSS_SOURCE, /background:\s*var\(--imageweave-fallback-elevated-solid\)/);
  assert.match(PROXY_CSS_SOURCE, /@media \(prefers-contrast: more\)/);
  assert.match(PROXY_CSS_SOURCE, /@media \(forced-colors: active\)/);
  assert.match(PROXY_CSS_SOURCE, /CanvasText/);
  assert.match(PROXY_CSS_SOURCE, /ButtonFace/);
  assert.match(PROXY_CSS_SOURCE, /Highlight/);
  assert.match(PROXY_CSS_SOURCE, /:root\[data-motion="off"\]/);
  assert.match(PROXY_CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok((PROXY_CSS_SOURCE.match(/transition:\s*none !important/g) || []).length >= 2);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);

  assert.match(PROXY_DOM_SOURCE, /proxy-workspace-track/);
  assert.match(PROXY_DOM_SOURCE, /className:\s*"proxy-workspace"[\s\S]*tabindex:\s*"0"/);
  assert.match(PROXY_DOM_SOURCE, /01 · 状态/);
  assert.match(PROXY_DOM_SOURCE, /02 · 运行池/);
  assert.match(PROXY_DOM_SOURCE, /03 · 来源/);
  assert.match(PROXY_DOM_SOURCE, /autocomplete:\s*"off"/);
  assert.match(PROXY_DOM_SOURCE, /aria-describedby/);
  assert.match(PROXY_DOM_SOURCE, /data-proxy-secret|proxySecret/);
  assert.doesNotMatch([PROXY_APP_SOURCE, PROXY_MODEL_SOURCE, PROXY_VIEW_SOURCE, PROXY_DOM_SOURCE].join("\n"), /innerHTML/);
});

test("4B focus target：重绘后不聚焦隐藏替换表单，按同 source action 回退", () => {
  assert.match(PROXY_VIEW_SOURCE, /closest\("\[hidden\]"\)/);
  assert.match(PROXY_VIEW_SOURCE, /subscription-replace-open/);
  assert.match(PROXY_VIEW_SOURCE, /inline-replace-open/);
  assert.match(PROXY_VIEW_SOURCE, /elements\.workspace/);
});

test("4B static boundary：endpoint 集合固定且无旁路 I/O、storage、console、fixture 或秘密 DOM", () => {
  assert.deepEqual(PROXY_ENDPOINTS, {
    status: "/api/v1/proxy/status",
    start: "/api/v1/proxy/start",
    reload: "/api/v1/proxy/reload",
    probe: "/api/v1/proxy/probe",
    stop: "/api/v1/proxy/stop",
    sources: "/api/v1/proxy/sources",
    subscriptions: "/api/v1/proxy/sources/subscriptions",
    nodeFile: "/api/v1/proxy/sources/node-file",
    inlineNodes: "/api/v1/proxy/sources/inline-nodes",
    override: "/api/v1/proxy/sources/override",
  });
  assert.equal((PROXY_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 10);
  const combined = [PROXY_APP_SOURCE, PROXY_MODEL_SOURCE, PROXY_VIEW_SOURCE, PROXY_DOM_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(PROXY_APP_SOURCE, /createProxyRequestGate/);
  assert.match(PROXY_APP_SOURCE, /AbortController/);
  assert.match(PROXY_APP_SOURCE, /Promise\.allSettled/);
  assert.match(PROXY_APP_SOURCE, /validateSubscriptionInput/);
  assert.match(PROXY_APP_SOURCE, /validateInlineNodeInput/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof proxyApplication[hook], "function");
  }
  assert.equal(typeof createProxyController, "function");
});

test("4B Vault model：五站固定顺序与安全投影不保留 secret、URL 或会话 ID", () => {
  assert.deepEqual(VAULT_SITE_IDS, ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
  const projected = sanitizeVaultStatus(vaultSnapshotWithActive("pixiv"));
  assert.deepEqual([...projected.bySite.keys()], VAULT_SITE_IDS);
  assert.equal(projected.bySite.get("twitter").cookieCount, 2);
  assert.equal(projected.bySite.get("pixiv").session.active, true);
  assert.equal(projected.authorizationProxy.displayEndpoint, "HTTPS · login-proxy.fixture.invalid:8443");
  assert.deepEqual(Object.keys(projected.browserProfile).sort(), ["present", "resetting", "running", "shared"]);
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.authStatusReceived(vaultSnapshotWithActive("pixiv")));
  const serialized = JSON.stringify({
    projected: {
      ...projected,
      bySite: [...projected.bySite],
    },
    store: {
      ...store.getState().auth,
      bySite: [...store.getState().auth.bySite],
    },
  });
  for (const forbidden of [
    VAULT_SECRET,
    VAULT_SESSION_ID,
    "private.invalid",
    "authorization_url",
    "raw_cookie",
    "raw_proxy_url",
    "proxy_url",
    "session_id",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.throws(() => sanitizeVaultStatus(rawVaultSnapshot({ secrets_exposed: true })), TypeError);
});

test("4B Vault model：proxy validation/payload、工作区七态和 request gate", () => {
  const secretProxy = `https://user:${VAULT_SECRET}@proxy.fixture.invalid:8443`;
  assert.deepEqual(validateAuthorizationProxyInput(secretProxy), {
    valid: true,
    mode: "proxy",
    error: "",
  });
  assert.deepEqual(buildAuthorizationProxyPayload(secretProxy), { proxy_url: secretProxy });
  assert.deepEqual(buildAuthorizationProxyPayload(""), { proxy_url: "" });
  for (const invalid of [
    "http://proxy.invalid",
    "file:///private/proxy",
    "https://proxy.invalid:443/path",
    "https://proxy.invalid:443?token=x",
    "socks5://user:pass@proxy.invalid:1080",
    `http://proxy.invalid:8080\n${VAULT_SECRET}`,
  ]) {
    assert.equal(validateAuthorizationProxyInput(invalid).valid, false, invalid);
    assert.throws(() => buildAuthorizationProxyPayload(invalid), TypeError);
  }

  const snapshot = sanitizeVaultStatus(rawVaultSnapshot());
  const active = sanitizeVaultStatus(vaultSnapshotWithActive());
  assert.equal(deriveVaultWorkspacePresentation({
    snapshot: { bySite: new Map(), browserProfile: null, authorizationProxy: null },
  }).state, "loading");
  const cases = [
    ["loading", {}],
    ["ready", { snapshot }],
    ["authorized", { snapshot, siteId: "twitter" }],
    ["required", { snapshot, siteId: "pixiv" }],
    ["authorizing", { snapshot: active, siteId: "pixiv" }],
    ["partial", { snapshot: { ...snapshot, bySite: new Map([["twitter", snapshot.bySite.get("twitter")]]) }, phase: "partial" }],
    ["error", { phase: "error" }],
    ["writing", { snapshot, phase: "writing" }],
  ];
  for (const [expected, input] of cases) {
    const presentation = deriveVaultWorkspacePresentation(input);
    assert.equal(presentation.state, expected);
    assert.equal(Boolean(presentation.label), true);
    assert.equal(Boolean(presentation.message), true);
  }

  const gate = createVaultRequestGate();
  const oldStatus = gate.beginRead("status");
  const currentStatus = gate.beginRead("status");
  const session = gate.beginRead("session");
  assert.equal(gate.isReadCurrent(oldStatus), false);
  assert.equal(gate.isReadCurrent(currentStatus), true);
  assert.equal(gate.isReadCurrent(session), true);
  const beforeWrite = gate.beginRead("status");
  const write = gate.beginWrite();
  assert.equal(gate.isReadCurrent(beforeWrite), false);
  assert.equal(gate.isWriteCurrent(write), true);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
});

test("4B Vault session reference：仅严格活动 opaque ID 可用于请求，恶意值永不进入 DOM/Store", () => {
  const active = vaultSnapshotWithActive("twitter");
  assert.deepEqual(extractVaultSessionReference(active.items[1]), {
    site: "twitter",
    kind: "managed_browser",
    sessionId: VAULT_SESSION_ID,
  });
  const invalidValues = [
    `../${VAULT_SECRET}`,
    VAULT_SECRET,
    "A".repeat(32),
    "0".repeat(31),
    "0".repeat(33),
  ];
  for (const sessionId of invalidValues) {
    const raw = vaultSnapshotWithActive("twitter", sessionId).items[1];
    assert.equal(extractVaultSessionReference(raw), null, sessionId);
  }
  const terminal = vaultSnapshotWithActive("twitter").items[1];
  terminal.login.state = "authorized";
  assert.equal(extractVaultSessionReference(terminal), null);
  assert.doesNotMatch(VAULT_VIEW_SOURCE + VAULT_DOM_SOURCE, /sessionId|session_id|authorization_url/);
  assert.doesNotMatch(VAULT_VIEW_SOURCE + VAULT_DOM_SOURCE, /dataset\.[A-Za-z0-9_]*(?:session|token|cookie)/i);
});

test("4B Vault controller：initial full read 后只对活动会话以 800ms 前台频率轮询", async () => {
  const restore = installVaultControllerDom();
  try {
    const initial = vaultSnapshotWithActive("twitter");
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) return Promise.resolve(initial);
        if (url === `${VAULT_ENDPOINTS.status}/twitter/login/${VAULT_SESSION_ID}?view=vault`) {
          return Promise.resolve({ status: initial.items[1], session: initial.items[1].login });
        }
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    assert.deepEqual(harness.calls.filter((call) => call[0] === "get").map(getCallUrl), [
      `${VAULT_ENDPOINTS.status}?view=vault`,
    ]);
    const poll = harness.polling.entries.get("vault.authorization");
    assert.equal(poll.intervalMs, 800);
    assert.equal(poll.scope, "app:vault");
    assert.equal(poll.alwaysFocusRate, true);
    assert.equal(poll.immediate, false);
    await poll.task(new AbortController().signal);
    assert.equal(harness.calls.at(-1)[1], `${VAULT_ENDPOINTS.status}/twitter/login/${VAULT_SESSION_ID}?view=vault`);
    assert.equal(JSON.stringify(harness.store.getState()).includes(VAULT_SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：poll 观察 complete 后停止并按 full+site 权威重读", async () => {
  const restore = installVaultControllerDom();
  try {
    let fullReads = 0;
    let siteReads = 0;
    let firstFull = true;
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) {
          fullReads += 1;
          if (firstFull) {
            firstFull = false;
            return Promise.resolve(vaultSnapshotWithActive("twitter"));
          }
          return Promise.resolve(rawVaultSnapshot());
        }
        if (url === `${VAULT_ENDPOINTS.status}/twitter/login/${VAULT_SESSION_ID}?view=vault`) {
          return Promise.resolve({ status: rawVaultSite("twitter", { login: null }) });
        }
        if (url === `${VAULT_ENDPOINTS.status}/twitter?view=vault`) {
          siteReads += 1;
          return Promise.resolve(rawVaultSite("twitter", { login: null }));
        }
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    const poll = harness.polling.entries.get("vault.authorization");
    const before = { fullReads, siteReads };
    await poll.task(new AbortController().signal);
    await flush();
    assert.equal(harness.polling.entries.has("vault.authorization"), false);
    assert.equal(fullReads, before.fullReads + 1);
    assert.equal(siteReads, before.siteReads + 1);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：session 结束、换站、deactivate/destroy 均立即停止 polling", async () => {
  const restore = installVaultControllerDom();
  try {
    let initial = vaultSnapshotWithActive("twitter");
    let sessionResponse = { status: initial.items[1], session: initial.items[1].login };
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) return Promise.resolve(initial);
        if (url.includes("/twitter/login/")) return Promise.resolve(sessionResponse);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    let poll = harness.polling.entries.get("vault.authorization");
    sessionResponse = { status: rawVaultSite("twitter", { login: null }) };
    initial = rawVaultSnapshot();
    await poll.task(new AbortController().signal);
    await flush();
    assert.equal(harness.polling.entries.has("vault.authorization"), false);

    initial = vaultSnapshotWithActive("twitter", VAULT_SECOND_SESSION_ID);
    harness.click("site:twitter");
    await flush();
    assert.equal(harness.polling.entries.has("vault.authorization"), true);
    harness.click("site:pixiv");
    await flush();
    assert.equal(harness.polling.entries.has("vault.authorization"), false);

    harness.controller.deactivate();
    assert.equal(harness.polling.entries.has("vault.authorization"), false);
    harness.controller.activate();
    await flush();
    poll = harness.polling.entries.get("vault.authorization");
    assert.equal(Boolean(poll), false, "非活动站点上的旧会话不能恢复轮询");
    harness.controller.destroy();
    assert.equal(harness.polling.entries.has("vault.authorization"), false);
  } finally {
    restore();
  }
});

test("4B Vault controller：start/complete/close 与换站路径只使用固定 auth view 集合", async () => {
  const restore = installVaultControllerDom();
  try {
    let snapshot = rawVaultSnapshot();
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) return Promise.resolve(snapshot);
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost(url) {
        if (url.includes("/twitter/login/start")) {
          snapshot = vaultSnapshotWithActive("twitter");
          return Promise.resolve({ status: snapshot.items[1], session: snapshot.items[1].login, raw: VAULT_SECRET });
        }
        if (url === `${VAULT_ENDPOINTS.pixivOAuthStart}?view=vault`) {
          snapshot = vaultSnapshotWithActive("pixiv");
          return Promise.resolve({ ...snapshot.items[2].oauth, raw: VAULT_SECRET });
        }
        throw new Error(`unexpected POST ${url}`);
      },
      apiDelete(url) {
        if (url.includes("/twitter/login/")) {
          snapshot = rawVaultSnapshot();
          return Promise.resolve({ status: snapshot.items[1], raw: VAULT_SECRET });
        }
        if (url === `${VAULT_ENDPOINTS.pixivOAuthSession}?view=vault`) {
          snapshot = rawVaultSnapshot();
          return Promise.resolve(snapshot.items[2]);
        }
        throw new Error(`unexpected DELETE ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    harness.click("authorize:twitter");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "post" && call[1] === `${VAULT_ENDPOINTS.status}/twitter/login/start?view=vault`), true);
    assert.equal(harness.polling.entries.has("vault.authorization"), true);

    snapshot = rawVaultSnapshot();
    harness.click("cancel:twitter");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "delete" && call[1] === `${VAULT_ENDPOINTS.status}/twitter/login/${VAULT_SESSION_ID}?view=vault`), true);
    assert.equal(harness.polling.entries.has("vault.authorization"), false);

    harness.click("site:pixiv");
    harness.click("authorize:pixiv");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "post" && call[1] === `${VAULT_ENDPOINTS.pixivOAuthStart}?view=vault`), true);
    harness.click("cancel:pixiv");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "delete" && call[1] === `${VAULT_ENDPOINTS.pixivOAuthSession}?view=vault`), true);
    assert.equal(JSON.stringify(harness.store.getState()).includes(VAULT_SESSION_ID), false);
    assert.equal(JSON.stringify(harness.viewLog).includes(VAULT_SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：未信任 session 响应不发请求、不进 Store/DOM/dataset/log", async () => {
  const restore = installVaultControllerDom();
  try {
    for (const sessionId of [VAULT_SECRET, `../${VAULT_SECRET}`, "A".repeat(32)]) {
      const harness = vaultControllerHarness({
        initialSite: "twitter",
        apiGet(url) {
          if (url === `${VAULT_ENDPOINTS.status}?view=vault`) {
            return Promise.resolve(vaultSnapshotWithActive("twitter", sessionId));
          }
          throw new Error(`unexpected GET ${url}`);
        },
      });
      harness.controller.activate();
      await flush();
      assert.equal(harness.polling.entries.has("vault.authorization"), false, sessionId);
      assert.deepEqual(harness.calls.filter((call) => call[0] === "get").map(getCallUrl), [
        `${VAULT_ENDPOINTS.status}?view=vault`,
      ]);
      assert.equal(JSON.stringify(harness.store.getState()).includes(sessionId), false);
      assert.equal(JSON.stringify(harness.viewLog).includes(sessionId), false);
      assert.equal(VAULT_VIEW_SOURCE.includes(sessionId), false);
      assert.equal(VAULT_DOM_SOURCE.includes(sessionId), false);
      harness.controller.destroy();
    }
  } finally {
    restore();
  }
});

test("4B Vault controller：site material confirm deny/allow，busy 单飞且写后 full+site 权威重读", async () => {
  const restore = installVaultControllerDom();
  try {
    const deny = vaultControllerHarness({ dialogChoice: "cancel", initialSite: "twitter" });
    deny.controller.activate();
    await flush();
    deny.click("clear:twitter");
    await flush();
    assert.equal(deny.dialogOptions[0].dangerous, true);
    assert.equal(deny.calls.some((call) => call[0] === "delete"), false);
    deny.controller.destroy();

    let fullReads = 0;
    let siteReads = 0;
    const write = deferred();
    const allow = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) {
          fullReads += 1;
          return Promise.resolve(rawVaultSnapshot());
        }
        if (url === `${VAULT_ENDPOINTS.status}/twitter?view=vault`) {
          siteReads += 1;
          return Promise.resolve(rawVaultSite("twitter", { authorized: false, cookies: { present: false, valid: false, cookie_count: 0 } }));
        }
        throw new Error(`unexpected GET ${url}`);
      },
      apiDelete: () => write.promise,
    });
    allow.controller.activate();
    await flush();
    const before = { fullReads, siteReads };
    allow.click("clear:twitter");
    allow.click("clear:twitter");
    await flush();
    assert.equal(allow.calls.filter((call) => call[0] === "delete").length, 1);
    write.resolve({ status: rawVaultSite("twitter"), secret: VAULT_SECRET });
    await flush();
    assert.equal(fullReads, before.fullReads + 1);
    assert.equal(siteReads, before.siteReads + 1);
    assert.equal(JSON.stringify(allow.store.getState()).includes(VAULT_SECRET), false);
    allow.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：危险 proxy/profile 动作 confirm deny 时不写入且清 raw", async () => {
  const restore = installVaultControllerDom();
  try {
    const deny = vaultControllerHarness({ dialogChoice: "cancel", initialSite: "twitter" });
    deny.controller.activate();
    await flush();
    for (const action of ["proxy-reset", "profile-clear"]) {
      deny.proxyInput.value = VAULT_SECRET;
      const writesBefore = deny.calls.filter((call) => call[0] !== "get").length;
      deny.click(action);
      await flush();
      assert.equal(deny.proxyInput.value, "");
      assert.equal(deny.dialogOptions.at(-1).dangerous, true);
      assert.equal(deny.calls.filter((call) => call[0] !== "get").length, writesBefore);
    }
    assert.equal(JSON.stringify(deny.viewLog).includes(VAULT_SECRET), false);
    deny.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：proxy save/direct/reset 与 profile clear 均确认/重读且秘密立即清空", async () => {
  const restore = installVaultControllerDom();
  try {
    const secretProxy = `https://user:${VAULT_SECRET}@proxy.fixture.invalid:8443`;
    let snapshot = rawVaultSnapshot();
    let fullReads = 0;
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) {
          fullReads += 1;
          return Promise.resolve(snapshot);
        }
        if (url === `${VAULT_ENDPOINTS.proxy}?view=vault`) return Promise.resolve(snapshot.authorization_proxy);
        if (url === `${VAULT_ENDPOINTS.browserProfile}?view=vault`) return Promise.resolve(snapshot.browser_profile);
        if (url === `${VAULT_ENDPOINTS.status}/twitter?view=vault`) return Promise.resolve(snapshot.items[1]);
        throw new Error(`unexpected GET ${url}`);
      },
      apiPut(url, payload) {
        assert.equal(url, `${VAULT_ENDPOINTS.proxy}?view=vault`);
        assert.deepEqual(payload, { proxy_url: secretProxy });
        return Promise.resolve({ raw: VAULT_SECRET });
      },
      apiDelete(url) {
        if (url === `${VAULT_ENDPOINTS.proxy}?view=vault`) return Promise.resolve({ source: "config", raw: VAULT_SECRET });
        if (url === `${VAULT_ENDPOINTS.browserProfile}?view=vault`) return Promise.resolve({ raw: VAULT_SECRET });
        throw new Error(`unexpected DELETE ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    const beforeSave = fullReads;
    const input = harness.submitProxy(secretProxy);
    assert.equal(input.value, "");
    await flush();
    assert.equal(input.value, "");
    assert.equal(fullReads, beforeSave + 1);
    assert.equal(harness.calls.some((call) => call[0] === "get" && call[1] === `${VAULT_ENDPOINTS.status}/twitter?view=vault`), true);

    const beforeDirect = fullReads;
    harness.submitProxy("");
    await flush();
    assert.equal(harness.dialogOptions.some((options) => /直连/.test(options.title)), true);
    assert.equal(harness.calls.some((call) => call[0] === "put" && call[2]?.proxy_url === ""), true);
    assert.equal(fullReads, beforeDirect + 1);

    const beforeReset = fullReads;
    harness.click("proxy-reset");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "delete" && call[1] === `${VAULT_ENDPOINTS.proxy}?view=vault`), true);
    assert.equal(fullReads, beforeReset + 1);

    const beforeProfile = fullReads;
    harness.click("profile-clear");
    await flush();
    assert.equal(harness.calls.some((call) => call[0] === "delete" && call[1] === `${VAULT_ENDPOINTS.browserProfile}?view=vault`), true);
    assert.equal(fullReads, beforeProfile + 1);
    assert.equal(JSON.stringify(harness.viewLog).includes(VAULT_SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：proxy 失败与 direct confirm cancel 均立即清 raw 且不回显错误秘密", async () => {
  const restore = installVaultControllerDom();
  try {
    const secretProxy = `https://user:${VAULT_SECRET}@proxy.fixture.invalid:8443`;
    const failed = vaultControllerHarness({
      initialSite: "twitter",
      apiPut: () => Promise.reject(Object.assign(new Error(VAULT_SECRET), {
        code: "invalid_authorization_proxy",
        status: 422,
        details: { token: VAULT_SECRET },
      })),
    });
    failed.controller.activate();
    await flush();
    failed.submitProxy(secretProxy);
    assert.equal(failed.proxyInput.value, "");
    await flush();
    assert.equal(failed.proxyInput.value, "");
    assert.equal(JSON.stringify(failed.store.getState()).includes(VAULT_SECRET), false);
    assert.equal(JSON.stringify(failed.viewLog).includes(VAULT_SECRET), false);
    failed.controller.destroy();

    const cancelled = vaultControllerHarness({ dialogChoice: "cancel", initialSite: "twitter" });
    cancelled.controller.activate();
    await flush();
    cancelled.submitProxy("");
    await flush();
    assert.equal(cancelled.proxyInput.value, "");
    assert.equal(cancelled.calls.some((call) => call[0] === "put"), false);
    assert.equal(cancelled.dialogOptions.at(-1).dangerous, true);
    cancelled.controller.destroy();
  } finally {
    restore();
  }
});

test("4B Vault controller：失败、confirm cancel、换站、deactivate/destroy 清 raw；旧 read/write/lifecycle 不提交", async () => {
  const restore = installVaultControllerDom();
  try {
    const initial = deferred();
    let fullReadCount = 0;
    const harness = vaultControllerHarness({
      initialSite: "twitter",
      apiGet(url) {
        if (url === `${VAULT_ENDPOINTS.status}?view=vault`) {
          fullReadCount += 1;
          return fullReadCount === 1 ? initial.promise : new Promise(() => {});
        }
        if (url === `${VAULT_ENDPOINTS.status}/pixiv?view=vault`) return new Promise(() => {});
        throw new Error(`unexpected GET ${url}`);
      },
      apiPut: () => Promise.reject(Object.assign(new Error(VAULT_SECRET), {
        code: "invalid_authorization_proxy",
        status: 422,
        details: { token: VAULT_SECRET },
      })),
    });
    harness.controller.activate();
    harness.proxyInput.value = VAULT_SECRET;
    harness.click("site:pixiv");
    assert.equal(harness.proxyInput.value, "");
    initial.resolve(vaultSnapshotWithActive("twitter"));
    await flush();
    assert.equal(harness.store.getState().auth.bySite.size, 0, "换站推进读取世代，旧 full response 不提交");

    harness.proxyInput.value = VAULT_SECRET;
    harness.controller.deactivate();
    assert.equal(harness.proxyInput.value, "");
    harness.controller.activate();
    await flush();
    harness.proxyInput.value = VAULT_SECRET;
    harness.controller.destroy();
    assert.equal(harness.proxyInput.value, "");
    assert.equal(JSON.stringify(harness.store.getState()).includes(VAULT_SECRET), false);
    assert.equal(JSON.stringify(harness.viewLog).includes(VAULT_SECRET), false);
  } finally {
    restore();
  }
});

test("4B CSS T7.3b：Vault 三栏低透明、状态非颜色、敏感控件复用 T6 且窗口独占 backdrop", () => {
  const block = (selector) => {
    const marker = `${selector} {`;
    const start = VAULT_CSS_SOURCE.indexOf(marker);
    assert.notEqual(start, -1, selector);
    const opening = VAULT_CSS_SOURCE.indexOf("{", start);
    const closing = VAULT_CSS_SOURCE.indexOf("}", opening);
    return VAULT_CSS_SOURCE.slice(opening + 1, closing);
  };

  // Existing navigation/material/recovery semantics remain the sole layout
  // owner. Normal windows scroll horizontally, maximized windows fit all three
  // columns, and each column retains its independent vertical scroll owner.
  for (const contract of [
    /vault-workspace-track/,
    /className:\s*"vault-workspace"[\s\S]*tabindex:\s*"0"/,
    /01 · 站点/,
    /02 · 材料与会话/,
    /03 · 共享与恢复/,
    /createElement\("nav"/,
    /data.*vault.*site|vaultSite/,
    /共享授权浏览器数据/,
    /登录代理/,
    /危险操作/,
  ]) assert.match(VAULT_DOM_SOURCE, contract);
  assert.match(VAULT_CSS_SOURCE, /\.window-body:has\(> \.vault-app\)/);
  const workspace = block(".vault-workspace");
  assert.match(workspace, /padding:\s*24px/);
  assert.match(workspace, /overflow-x:\s*auto/);
  assert.match(workspace, /overflow-y:\s*hidden/);
  const track = block(".vault-workspace-track");
  assert.match(track, /min-width:\s*1120px/);
  assert.match(track, /gap:\s*24px/);
  assert.ok((track.match(/minmax\(/g) || []).length >= 3);
  assert.match(VAULT_CSS_SOURCE, /\.application-window\[data-maximized\] \.vault-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  const column = block(".vault-column");
  assert.match(column, /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(column, /border-radius:\s*var\(--imageweave-radius-card\)/);
  assert.match(column, /background:\s*var\(--imageweave-glass-surface-input\)/);
  assert.match(column, /inset 0 1px 0[\s\S]*inset 0 -1px 0/);
  assert.doesNotMatch(column, /backdrop-filter|var\(--imageweave-shadow-/);
  assert.match(block(".vault-column--navigation"), /background:\s*var\(--imageweave-glass-surface-secondary\)/);
  const columnScroll = block(".vault-column-scroll");
  assert.match(columnScroll, /padding:\s*24px/);
  assert.match(columnScroll, /overflow-y:\s*auto/);

  // All normal Vault surfaces use canonical 4%-8% neutral glass. The only
  // solid token is the capability fallback; facts/forms use 16px weak rows,
  // no outer card shadow and no additional compositing layer.
  const solidRefs = [...VAULT_CSS_SOURCE.matchAll(/--imageweave-[\w-]*-solid/g)].map((match) => match[0]);
  assert.deepEqual(solidRefs, ["--imageweave-fallback-elevated-solid"]);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /--imageweave-state-[\w-]*-surface/);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /^\s*(?:-webkit-)?backdrop-filter\s*:(?![^\n]*\bnone\b)/m);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /^\s*filter\s*:/m);
  assert.match(VAULT_CSS_SOURCE, /\.vault-waiting-host,[\s\S]*?\.vault-definition-list > div\s*\{[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)[\s\S]*?border-radius:\s*var\(--imageweave-radius-control\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-weak\)[\s\S]*?box-shadow:\s*none/);
  const flatPanel = block(".vault-app .vault-panel");
  assert.match(flatPanel, /border-bottom:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-weak\)/);
  assert.match(flatPanel, /background:\s*transparent/);
  assert.match(flatPanel, /background-image:\s*none/);
  assert.match(flatPanel, /box-shadow:\s*none/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-definition-list dd[\s\S]*?color:\s*var\(--imageweave-text-code\)[\s\S]*?font-family:\s*var\(--imageweave-font-mono\)/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-profile-status \.empty-state,[\s\S]*?background:\s*transparent[\s\S]*?box-shadow:\s*none/);

  // pending/ready/error/expired-material proxies keep neutral fills and use
  // complete semantic edges plus existing badge/text and explicit shaped copy.
  const errorState = block('.vault-waiting-host[data-vault-workspace-state="error"]');
  assert.match(errorState, /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.match(errorState, /background:\s*var\(--imageweave-glass-surface-default\)/);
  for (const [state, token] of [
    ["loading", "running"], ["authorizing", "running"], ["writing", "running"],
    ["ready", "success"], ["authorized", "success"],
    ["partial", "warning"], ["required", "warning"], ["error", "danger"],
  ]) {
    assert.match(VAULT_CSS_SOURCE, new RegExp(`data-vault-workspace-state="${state}"[\\s\\S]*?--imageweave-state-${token}`), state);
  }
  for (const [state, token] of [
    ["ready", "success"], ["running", "running"], ["warning", "warning"],
    ["error", "danger"], ["disabled", "disabled"],
  ]) {
    assert.match(VAULT_CSS_SOURCE, new RegExp(`data-site-state="${state}"[\\s\\S]*?--imageweave-state-${token}`), state);
  }
  assert.match(VAULT_CSS_SOURCE, /\.vault-site-nav-button\[aria-current="true"\]::after[\s\S]*?content:\s*"◆"/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-operation-live::before[\s\S]*?content:\s*"◆"/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-impact-note::before[\s\S]*?content:\s*"⚠ 影响 · "/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-proof-note::before,[\s\S]*?content:\s*"◆ 状态说明 · "/);
  const validation = block(".vault-field-error:not(:empty)");
  assert.match(validation, /border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.match(validation, /color:\s*var\(--imageweave-text-primary\)/);
  assert.match(validation, /background:\s*var\(--imageweave-glass-surface-default\)/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-danger-zone\s*\{[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /(?:border-(?:left|right):\s*[34]px|inset\s+[34]px\s+0(?:px)?\s+0)/);
  const kicker = block(".vault-column-kicker");
  assert.match(kicker, /letter-spacing:\s*normal/);
  assert.match(kicker, /text-transform:\s*none/);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /\b(?:100|120|150|180)ms\b/);

  // Sensitive proxy input and all actions delegate appearance to T6. Local
  // Vault CSS adds sizing only; invalid/disabled reasons and dangerous Dialog
  // ownership retain full edges and readable text.
  const secretInput = block(".vault-secret-input");
  assert.doesNotMatch(secretInput, /background|border|box-shadow|color/);
  assert.match(CONTROLS_CSS_SOURCE, /\.app-view :is\([\s\S]*?input\[type="text"\][\s\S]*?textarea[\s\S]*?background:\s*var\(--imageweave-glass-surface-input\)[\s\S]*?border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
  assert.match(CONTROLS_CSS_SOURCE, /\.vault-button\.vault-button--primary,[\s\S]*?border-color:\s*var\(--imageweave-accent\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/);
  assert.match(CONTROLS_CSS_SOURCE, /\.vault-button\.vault-button--dangerous,[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\)/);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /\.vault-button--primary|\.vault-button--dangerous/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-site-nav-button:hover[\s\S]*?background:\s*var\(--imageweave-glass-surface-secondary\)[\s\S]*?transform:\s*none/);
  assert.match(VAULT_CSS_SOURCE, /\.vault-site-card:hover,[\s\S]*?transform:\s*none/);

  // Canonical no-backdrop, contrast, forced-colors and both motion opt-outs
  // stay explicit. Forced colors remove every optical effect.
  assert.match(VAULT_CSS_SOURCE, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  assert.match(VAULT_CSS_SOURCE, /background:\s*var\(--imageweave-fallback-elevated-solid\)/);
  assert.match(VAULT_CSS_SOURCE, /@media \(prefers-contrast: more\)/);
  assert.match(VAULT_CSS_SOURCE, /@media \(forced-colors: active\)/);
  assert.match(VAULT_CSS_SOURCE, /CanvasText/);
  assert.match(VAULT_CSS_SOURCE, /ButtonFace/);
  assert.match(VAULT_CSS_SOURCE, /Highlight/);
  assert.match(VAULT_CSS_SOURCE, /background-image:\s*none/);
  assert.match(VAULT_CSS_SOURCE, /box-shadow:\s*none/);
  assert.match(VAULT_CSS_SOURCE, /backdrop-filter:\s*none/);
  assert.match(VAULT_CSS_SOURCE, /:root\[data-motion="off"\]/);
  assert.match(VAULT_CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.ok((VAULT_CSS_SOURCE.match(/transition:\s*none !important/g) || []).length >= 2);
  assert.doesNotMatch(VAULT_CSS_SOURCE, /@media\s*\(max-width\s*:/);
});

test("4B Vault focus/state：站点和 action 重绘保持稳定焦点，显式非颜色状态进入 aria-live", () => {
  assert.match(VAULT_VIEW_SOURCE, /vaultFocusToken/);
  assert.match(VAULT_VIEW_SOURCE, /restoreVaultFocus/);
  assert.match(VAULT_VIEW_SOURCE, /elements\.workspace/);
  assert.match(VAULT_VIEW_SOURCE, /data.*vault.*workspace.*state|vaultWorkspaceState/);
  assert.match(VAULT_VIEW_SOURCE, /deriveVaultWorkspacePresentation/);
  assert.match(VAULT_DOM_SOURCE, /aria-live/);
  for (const state of ["loading", "ready", "authorized", "required", "authorizing", "partial", "error", "writing"]) {
    assert.match(VAULT_MODEL_SOURCE + VAULT_VIEW_SOURCE, new RegExp(`\\b${state}\\b`));
  }
  assert.doesNotMatch(VAULT_DOM_SOURCE + VAULT_VIEW_SOURCE, /type:\s*"password"|\.type\s*=\s*"password"/);
  assert.match(VAULT_DOM_SOURCE, /autocomplete:\s*"off"/);
});

test("4B Vault static boundary：endpoint/query 集合固定，无旁路 I/O/storage/console/innerHTML/fixture", () => {
  assert.deepEqual(VAULT_ENDPOINTS, {
    status: "/api/v1/auth",
    proxy: "/api/v1/auth/proxy",
    browserProfile: "/api/v1/auth/browser-profile",
    pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
    pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
  });
  assert.equal((VAULT_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 5);
  assert.equal((VAULT_APP_SOURCE.match(/view=vault/g) || []).length, 1);
  const combined = [VAULT_APP_SOURCE, VAULT_MODEL_SOURCE, VAULT_VIEW_SOURCE, VAULT_DOM_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(VAULT_APP_SOURCE, /createVaultRequestGate/);
  assert.match(VAULT_APP_SOURCE, /AbortController/);
  assert.match(VAULT_APP_SOURCE, /alwaysFocusRate:\s*true/);
  assert.match(VAULT_APP_SOURCE, /intervalMs:\s*AUTHORIZATION_POLL_INTERVAL_MS/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof vaultApplication[hook], "function");
  }
  assert.equal(typeof createVaultController, "function");
});

const POLICY_SECRET = "stage4-policy-cookie-token-path-secret-141421";
const policyApplication = policyApplicationModule.default;
const {
  createPolicyController,
  POLICY_ENDPOINTS,
} = policyApplicationModule;
const {
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  derivePolicyEditorPresentation,
  derivePolicyWorkspacePresentation,
  isPolicyDirty,
  POLICY_SITE_IDS,
  policyConfigToDraft,
  policyErrorGuidance,
  sanitizePolicyResponse,
  validatePolicyDraft,
} = policyModelModule;

const POLICY_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/policy.js", import.meta.url),
  "utf8",
);
const POLICY_MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/policy-model.js", import.meta.url),
  "utf8",
);
const POLICY_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/policy-view.js", import.meta.url),
  "utf8",
);
const POLICY_DOM_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/policy-dom.js", import.meta.url),
  "utf8",
);
const POLICY_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/policy.css", import.meta.url),
  "utf8",
);

function rawPolicyConfig(overrides = {}) {
  return {
    max_concurrency: 20,
    retry_limit: 2,
    backoff_base_seconds: 2,
    proxy_mode: "prefer",
    ...overrides,
  };
}

const POLICY_SITES = Object.freeze([
  ["danbooru", "Danbooru", "anonymous"],
  ["twitter", "X / Twitter", "managed_browser"],
  ["pixiv", "Pixiv", "oauth"],
  ["exhentai", "EH", "managed_browser_for_private_content"],
  ["pawchive", "Pawchive", "anonymous"],
]);

function rawPolicySnapshot({ overrides = {}, corruptSite = "", extraItems = [] } = {}) {
  const defaultPolicy = rawPolicyConfig();
  return {
    response_profile: "policy",
    secrets_exposed: false,
    effect_scope: "new_requests_and_tasks",
    concurrency_protection: "none",
    default_source: "startup_snapshot",
    persistence: "sqlite_atomic",
    default: { editable: true, reason: "", policy: { ...defaultPolicy } },
    items: [
      ...POLICY_SITES.map(([site, label, authorization]) => {
        const override = overrides[site] || null;
        const item = {
          site,
          label,
          supported: true,
          authorization,
          selection_mode: "per_request",
          availability: "not_probed",
          inherited: !override,
          has_override: Boolean(override),
          editable: true,
          reason: "",
          updated_at: override ? 1_700_000_000 : null,
          policy: { ...(override || defaultPolicy) },
        };
        if (site === corruptSite) {
          item.policy = {
            ...item.policy,
            request_body: `token=${POLICY_SECRET}`,
          };
        }
        return item;
      }),
      ...extraItems,
    ],
    unknown_override_count: 0,
  };
}

class PolicyTestElement extends TestElement {
  constructor(tagName = "div") {
    super(tagName);
    this.value = "";
    this.checked = false;
    this.validationMessage = "";
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    if (selector === "[data-policy-site]") return this.dataset.policySite !== undefined;
    if (selector === "[data-policy-field]") return this.dataset.policyField !== undefined;
    return false;
  }

  setCustomValidity(message) {
    this.validationMessage = String(message);
  }

  closest(selector) {
    let current = this;
    while (current instanceof PolicyTestElement) {
      if (selector === "[data-policy-site]" && current.dataset.policySite !== undefined) return current;
      if (selector === "[data-policy-action]" && current.dataset.policyAction !== undefined) return current;
      if (selector === "form" && current instanceof PolicyTestForm) return current;
      current = current.parentNode;
    }
    return null;
  }
}

class PolicyTestButton extends PolicyTestElement {
  constructor({ action = "", site = "" } = {}) {
    super("button");
    if (action) this.dataset.policyAction = action;
    if (site) {
      this.dataset.policySite = site;
      this.value = site;
    }
  }
}

class PolicyTestInput extends PolicyTestElement {
  constructor(field = "", value = "") {
    super("input");
    if (field) this.dataset.policyField = field;
    this.value = value;
  }
}

class PolicyTestForm extends PolicyTestElement {
  constructor() {
    super("form");
  }
}

function installPolicyControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const windowListeners = new Map();
  install("Element", PolicyTestElement);
  install("HTMLElement", PolicyTestElement);
  install("HTMLButtonElement", PolicyTestButton);
  install("HTMLInputElement", PolicyTestInput);
  install("HTMLFormElement", PolicyTestForm);
  install("addEventListener", (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(listener);
  });
  install("removeEventListener", (type, listener) => windowListeners.get(type)?.delete(listener));
  return {
    emitWindow(type, event) {
      for (const listener of [...(windowListeners.get(type) || [])]) listener(event);
    },
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function policyControllerHarness({
  initialSnapshot = rawPolicySnapshot(),
  apiGet,
  apiPut,
  apiDelete,
  dialogChoice = "confirm",
  initialSite = "danbooru",
} = {}) {
  const root = new PolicyTestElement("main");
  const form = new PolicyTestForm();
  form.parentNode = root;
  const store = createStore({ reportError: () => {} });
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      return apiGet ? apiGet(url, options) : Promise.resolve(initialSnapshot);
    },
    put(url, payload, options) {
      calls.push(["put", url, payload, options]);
      return apiPut ? apiPut(url, payload, options) : Promise.resolve({});
    },
    delete(url, options) {
      calls.push(["delete", url, options]);
      return apiDelete ? apiDelete(url, options) : Promise.resolve({});
    },
  };
  const dialogOptions = [];
  const dialogs = {
    open(options) {
      dialogOptions.push(options);
      return typeof dialogChoice === "function"
        ? dialogChoice(options, dialogOptions.length - 1)
        : Promise.resolve(dialogChoice);
    },
    destroy() {},
  };
  let selectedSite = initialSite;
  let draft = policyConfigToDraft(rawPolicyConfig());
  const viewLog = [];
  const item = () => store.getState().policy.config?.bySite.get(selectedSite) || null;
  const loadCurrentDraft = () => {
    const current = item();
    if (current?.editable && current.policy) draft = policyConfigToDraft(current.policy);
  };
  const view = {
    elements: { form },
    getSelectedSite: () => selectedSite,
    getCurrentItem: item,
    readDraft: () => ({ ...draft }),
    validateDraft: () => validatePolicyDraft(draft),
    isDirty: () => Boolean(item()?.policy && isPolicyDirty(item().policy, draft)),
    selectSite(siteId) {
      selectedSite = siteId;
      loadCurrentDraft();
      viewLog.push(["select", siteId]);
    },
    restoreSourceSelection: () => viewLog.push(["restore-selection", selectedSite]),
    captureFocusToken: () => Object.freeze({ siteId: selectedSite, field: "", action: "" }),
    restoreFocusToken: (token) => viewLog.push(["restore-focus", token?.siteId || ""]),
    focusAfterOperation: (kind) => viewLog.push(["focus", kind]),
    reloadDraft() {
      loadCurrentDraft();
      viewLog.push(["reload-draft", selectedSite]);
      return true;
    },
    restoreDraft(value) {
      draft = { ...value };
      viewLog.push(["restore-draft", selectedSite]);
      return true;
    },
    clearDraft: () => viewLog.push(["clear-draft"]),
    clearError: () => viewLog.push(["clear-error"]),
    showError(error) {
      viewLog.push(["error", policyErrorGuidance(error)]);
    },
    setOperationMessage: (message) => viewLog.push(["message", message]),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setWorkspacePhase: (phase) => viewLog.push(["phase", phase]),
    renderDraftState: () => viewLog.push(["draft-state"]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createPolicyController({
    root,
    api,
    store,
    dialogs,
    app: { id: "policy", label: "站点设置", windowTitle: "站点设置" },
  }, { createView: () => view });
  const setDraft = (changes) => {
    draft = { ...draft, ...changes };
    return { ...draft };
  };
  const getDraft = () => ({ ...draft });
  const clickSite = (siteId) => root.emit("click", new PolicyTestButton({ site: siteId }));
  const clickAction = (action) => root.emit("click", new PolicyTestButton({ action }));
  const submit = () => root.emit("submit", form);
  return {
    root,
    form,
    store,
    calls,
    dialogs,
    dialogOptions,
    view,
    viewLog,
    controller,
    setDraft,
    getDraft,
    clickSite,
    clickAction,
    submit,
    selectedSite: () => selectedSite,
  };
}

function latestPolicyCall(harness, method) {
  return harness.calls.filter((call) => call[0] === method).at(-1);
}

test("4C model：工作区/编辑器纯投影覆盖全状态，按钮采用 busy > readonly/invalid > clean > dirty", () => {
  const snapshot = sanitizePolicyResponse(rawPolicySnapshot({
    overrides: { pixiv: rawPolicyConfig({ max_concurrency: 8 }) },
    corruptSite: "twitter",
  }));
  const inherited = snapshot.bySite.get("danbooru");
  const custom = snapshot.bySite.get("pixiv");
  const readonly = snapshot.bySite.get("twitter");
  const states = [
    ["loading", {}],
    ["ready", { snapshot, item: inherited }],
    ["dirty", { snapshot, item: inherited, dirty: true }],
    ["invalid", { snapshot, item: inherited, dirty: true, valid: false }],
    ["saving", { snapshot, item: inherited, busy: "save" }],
    ["saved", { snapshot, item: custom, phase: "saved" }],
    ["readonly", { snapshot, item: readonly }],
    ["error", { snapshot, item: inherited, phase: "error" }],
    ["partial", { snapshot, item: inherited, phase: "partial" }],
  ];
  for (const [expected, input] of states) {
    const presentation = derivePolicyWorkspacePresentation(input);
    assert.equal(presentation.state, expected);
    assert.equal(Boolean(presentation.label), true);
    assert.equal(Boolean(presentation.message), true);
    assert.equal(["ready", "running", "warning", "error", "disabled"].includes(presentation.kind), true);
  }
  assert.match(derivePolicyEditorPresentation(inherited).source, /默认|继承/);
  assert.match(derivePolicyEditorPresentation(custom).source, /自定义|覆盖/);
  assert.match(derivePolicyEditorPresentation(readonly).message, /无法|只读/);

  let controls = derivePolicyControls(inherited, { busy: "save", dirty: true, valid: false });
  assert.match(controls.save.reason, /等待/);
  controls = derivePolicyControls(readonly, { dirty: true, valid: false });
  assert.match(controls.save.reason, /无法编辑/);
  controls = derivePolicyControls(inherited, { dirty: true, valid: false });
  assert.match(controls.save.reason, /修正/);
  controls = derivePolicyControls(inherited, { dirty: false, valid: true });
  assert.match(controls.save.reason, /没有变化/);
  controls = derivePolicyControls(inherited, { dirty: true, valid: true });
  assert.equal(controls.save.disabled, false);
});

test("4C model/Store：五站固定顺序、严格四字段 payload、危险/未知/损坏数据只读且错误安全", () => {
  assert.deepEqual(POLICY_SITE_IDS, POLICY_SITES.map(([site]) => site));
  const raw = rawPolicySnapshot({
    corruptSite: "twitter",
    extraItems: [{
      site: "unknown",
      label: POLICY_SECRET,
      authorization: "anonymous",
      policy: { token: POLICY_SECRET, path: `/private/${POLICY_SECRET}` },
    }],
  });
  raw.items[0].unknown = `https://private.invalid/?token=${POLICY_SECRET}`;
  const snapshot = sanitizePolicyResponse(raw);
  assert.deepEqual([...snapshot.bySite.keys()], POLICY_SITE_IDS);
  assert.equal(snapshot.bySite.get("twitter").editable, false);
  assert.equal(snapshot.bySite.get("twitter").policy, null);
  assert.equal(JSON.stringify([...snapshot.bySite]).includes(POLICY_SECRET), false);

  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.policyConfigReceived(raw));
  assert.equal(JSON.stringify([...store.getState().policy.config.bySite]).includes(POLICY_SECRET), false);
  const dangerous = JSON.parse(`{"response_profile":"policy","__proto__":{"token":"${POLICY_SECRET}"}}`);
  assert.throws(() => sanitizePolicyResponse(dangerous), TypeError);
  assert.equal({}.token, undefined);

  const payload = buildPolicyPayload({
    max_concurrency: "12",
    retry_limit: "3",
    backoff_base_seconds: "1.5",
    proxy_mode: "required",
  });
  assert.deepEqual(Object.keys(payload), [
    "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode",
  ]);
  assert.deepEqual(payload, {
    max_concurrency: 12,
    retry_limit: 3,
    backoff_base_seconds: 1.5,
    proxy_mode: "required",
  });
  assert.equal(validatePolicyDraft({ ...payload, token: POLICY_SECRET }).valid, false);

  const guidance = policyErrorGuidance({
    code: "invalid_policy",
    status: 422,
    message: `token=${POLICY_SECRET}`,
    details: {
      field: "retry_limit",
      reason: "less_than_equal",
      body: `https://private.invalid/${POLICY_SECRET}`,
      path: `/private/${POLICY_SECRET}`,
    },
  });
  const serialized = JSON.stringify(guidance);
  assert.equal(serialized.includes(POLICY_SECRET), false);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("/private/"), false);
});

test("4C request gate：旧 read、写前 read、旧 write 与生命周期响应不可提交", () => {
  const gate = createPolicyRequestGate();
  const first = gate.beginRead();
  const second = gate.beginRead();
  assert.equal(gate.isReadCurrent(first), false);
  assert.equal(gate.isReadCurrent(second), true);
  const beforeWrite = gate.beginRead();
  const write = gate.beginWrite();
  assert.equal(gate.isReadCurrent(beforeWrite), false);
  assert.equal(gate.isWriteCurrent(write), true);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
});

test("4C controller：activate 单次 GET 无轮询，save 精确 PUT→GET，reset DELETE→GET", async () => {
  const globals = installPolicyControllerDom();
  try {
    let server = rawPolicySnapshot();
    const harness = policyControllerHarness({
      apiGet: () => Promise.resolve(server),
      apiPut(url, payload) {
        server = rawPolicySnapshot({ overrides: { danbooru: { ...payload } } });
        return Promise.resolve({ ignored: POLICY_SECRET });
      },
      apiDelete() {
        server = rawPolicySnapshot();
        return Promise.resolve({ ignored: POLICY_SECRET });
      },
    });
    harness.controller.activate();
    harness.controller.activate();
    await flush();
    assert.deepEqual(harness.calls.map((call) => call[0]), ["get"]);
    assert.equal(harness.calls[0][1], "/api/v1/sites/policies?view=policy");

    harness.setDraft({
      max_concurrency: "9",
      retry_limit: "4",
      backoff_base_seconds: "1.25",
      proxy_mode: "required",
    });
    harness.submit();
    harness.submit();
    await flush();
    const put = latestPolicyCall(harness, "put");
    assert.equal(put[1], "/api/v1/sites/policies/danbooru?view=policy");
    assert.deepEqual(put[2], {
      max_concurrency: 9,
      retry_limit: 4,
      backoff_base_seconds: 1.25,
      proxy_mode: "required",
    });
    assert.deepEqual(harness.calls.map((call) => call[0]), ["get", "put", "get"]);
    assert.equal(harness.store.getState().policy.config.bySite.get("danbooru").hasOverride, true);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "saved"), true);

    harness.clickAction("reset");
    await flush();
    assert.equal(harness.dialogOptions.at(-1).dangerous, true);
    assert.equal(latestPolicyCall(harness, "delete")[1], "/api/v1/sites/policies/danbooru?view=policy");
    assert.deepEqual(harness.calls.map((call) => call[0]), ["get", "put", "get", "delete", "get"]);
    assert.equal(harness.store.getState().policy.config.bySite.get("danbooru").hasOverride, false);
    harness.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C controller：native/realtime 共用 validation，非法草稿零请求；无 override reset 仅清本地", async () => {
  const globals = installPolicyControllerDom();
  try {
    const harness = policyControllerHarness();
    harness.controller.activate();
    await flush();
    const reads = harness.calls.length;
    harness.setDraft({ max_concurrency: "999", proxy_mode: "required" });
    harness.root.emit("input", new PolicyTestInput("max_concurrency", "999"));
    harness.submit();
    await flush();
    assert.equal(harness.calls.length, reads);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "error"), true);

    harness.setDraft({ max_concurrency: "8" });
    const beforeReset = harness.calls.length;
    const dialogsBefore = harness.dialogOptions.length;
    harness.clickAction("reset");
    await flush();
    assert.equal(harness.calls.length, beforeReset);
    assert.equal(harness.dialogOptions.length, dialogsBefore);
    assert.deepEqual(harness.getDraft(), policyConfigToDraft(rawPolicyConfig()));
    harness.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C controller：旧读取、写前读取、deactivate/destroy 后 read/write 均不提交", async () => {
  const globals = installPolicyControllerDom();
  try {
    const oldRead = deferred();
    const write = deferred();
    let getCount = 0;
    const fresh = rawPolicySnapshot({ overrides: {
      danbooru: rawPolicyConfig({ max_concurrency: 7 }),
    } });
    const harness = policyControllerHarness({
      apiGet() {
        getCount += 1;
        return getCount === 1 ? oldRead.promise : Promise.resolve(fresh);
      },
      apiPut: () => write.promise,
    });
    harness.store.dispatch(actionCreators.policyConfigReceived(rawPolicySnapshot()));
    harness.controller.activate();
    harness.setDraft({ max_concurrency: "7" });
    harness.submit();
    await flush();
    assert.equal(harness.calls.filter((call) => call[0] === "put").length, 1);
    oldRead.resolve(rawPolicySnapshot({ overrides: {
      danbooru: rawPolicyConfig({ max_concurrency: 99 }),
    } }));
    write.resolve({ raw: POLICY_SECRET });
    await flush();
    assert.equal(harness.store.getState().policy.config.bySite.get("danbooru").policy.max_concurrency, 7);

    const staleWrite = deferred();
    const stale = policyControllerHarness({ apiPut: () => staleWrite.promise });
    stale.controller.activate();
    await flush();
    const before = stale.store.getState().policy.config;
    stale.setDraft({ max_concurrency: "6" });
    stale.submit();
    await flush();
    const callsBeforeDeactivate = stale.calls.length;
    stale.controller.deactivate();
    staleWrite.resolve({ raw: POLICY_SECRET });
    await flush();
    assert.equal(stale.calls.length, callsBeforeDeactivate);
    assert.equal(stale.store.getState().policy.config, before);
    stale.controller.destroy();
    harness.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C controller：dirty 切站 deny/allow 保留或丢弃草稿，destroy 后 stale confirm 不切站", async () => {
  const globals = installPolicyControllerDom();
  try {
    const choices = ["cancel", "confirm"];
    const harness = policyControllerHarness({
      dialogChoice: () => Promise.resolve(choices.shift()),
    });
    harness.controller.activate();
    await flush();
    harness.setDraft({ max_concurrency: "7" });
    const original = harness.getDraft();
    harness.clickSite("pixiv");
    await flush();
    assert.equal(harness.selectedSite(), "danbooru");
    assert.deepEqual(harness.getDraft(), original);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "restore-focus"), true);

    harness.clickSite("pixiv");
    await flush();
    assert.equal(harness.selectedSite(), "pixiv");
    assert.deepEqual(harness.getDraft(), policyConfigToDraft(rawPolicyConfig()));
    harness.controller.destroy();

    const pending = deferred();
    const stale = policyControllerHarness({ dialogChoice: () => pending.promise });
    stale.controller.activate();
    await flush();
    stale.setDraft({ retry_limit: "5" });
    stale.clickSite("twitter");
    await flush();
    stale.controller.destroy();
    pending.resolve("confirm");
    await flush();
    assert.equal(stale.selectedSite(), "danbooru");
  } finally {
    globals.restore();
  }
});

test("4C controller：leave/minimize/close 共用 discard promise 单飞，beforeunload 同步保护 dirty", async () => {
  const globals = installPolicyControllerDom();
  try {
    const choice = deferred();
    const harness = policyControllerHarness({ dialogChoice: () => choice.promise });
    harness.controller.activate();
    await flush();
    harness.setDraft({ retry_limit: "6" });
    const leave = harness.controller.beforeLeave();
    const minimize = harness.controller.beforeWindowHide("minimized");
    const close = harness.controller.beforeWindowHide("closed");
    assert.equal(leave, minimize);
    assert.equal(minimize, close);
    assert.equal(harness.dialogOptions.length, 1);

    const unload = { prevented: false, returnValue: null, preventDefault() { this.prevented = true; } };
    globals.emitWindow("beforeunload", unload);
    assert.equal(unload.prevented, true);
    assert.equal(unload.returnValue, "");

    choice.resolve("cancel");
    assert.deepEqual(await Promise.all([leave, minimize, close]), [false, false, false]);
    assert.equal(harness.controller.beforeWindowHide("closed") instanceof Promise, true);
    await flush();
    assert.equal(harness.dialogOptions.length, 2);
    harness.controller.destroy();

    const allow = policyControllerHarness({ dialogChoice: "confirm" });
    allow.controller.activate();
    await flush();
    allow.setDraft({ retry_limit: "6" });
    assert.equal(await allow.controller.beforeLeave(), true);
    assert.deepEqual(allow.getDraft(), policyConfigToDraft(rawPolicyConfig()));
    allow.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C controller：reset confirm cancel/allow 与失败均保留正确草稿，write 全程单飞", async () => {
  const globals = installPolicyControllerDom();
  try {
    const override = rawPolicyConfig({ max_concurrency: 6 });
    const snapshot = rawPolicySnapshot({ overrides: { danbooru: override } });
    const deny = policyControllerHarness({ initialSnapshot: snapshot, dialogChoice: "cancel" });
    deny.controller.activate();
    await flush();
    deny.setDraft({ max_concurrency: "7" });
    const deniedDraft = deny.getDraft();
    deny.clickAction("reset");
    await flush();
    assert.equal(deny.calls.some((call) => call[0] === "delete"), false);
    assert.deepEqual(deny.getDraft(), deniedDraft);
    deny.controller.destroy();

    const write = deferred();
    const failed = policyControllerHarness({
      initialSnapshot: snapshot,
      apiGet: () => Promise.resolve(snapshot),
      apiDelete: () => write.promise,
    });
    failed.controller.activate();
    await flush();
    failed.setDraft({ max_concurrency: "7", retry_limit: "4" });
    const failedDraft = failed.getDraft();
    failed.clickAction("reset");
    failed.clickAction("reset");
    await flush();
    assert.equal(failed.calls.filter((call) => call[0] === "delete").length, 1);
    write.reject(Object.assign(new Error(POLICY_SECRET), {
      code: "policy_store_error",
      status: 500,
      message: `token=${POLICY_SECRET}`,
      details: { body: POLICY_SECRET, url: `https://private.invalid/${POLICY_SECRET}` },
    }));
    await flush();
    assert.deepEqual(failed.getDraft(), failedDraft);
    assert.equal(JSON.stringify(failed.viewLog).includes(POLICY_SECRET), false);
    failed.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C controller：failed PUT 权威重读后恢复原 draft，错误不回显提交体/URL/token/path/secret", async () => {
  const globals = installPolicyControllerDom();
  try {
    const snapshot = rawPolicySnapshot();
    const harness = policyControllerHarness({
      apiGet: () => Promise.resolve(snapshot),
      apiPut: () => Promise.reject(Object.assign(new Error(`token=${POLICY_SECRET}`), {
        code: "invalid_policy",
        status: 422,
        details: {
          field: "max_concurrency",
          reason: "less_than_equal",
          body: `token=${POLICY_SECRET}`,
          url: `https://private.invalid/${POLICY_SECRET}`,
          path: `/private/${POLICY_SECRET}`,
        },
      })),
    });
    harness.controller.activate();
    await flush();
    harness.setDraft({ max_concurrency: "7", retry_limit: "5", proxy_mode: "direct" });
    const original = harness.getDraft();
    harness.submit();
    await flush();
    assert.deepEqual(harness.getDraft(), original);
    assert.deepEqual(harness.calls.map((call) => call[0]), ["get", "put", "get"]);
    const log = JSON.stringify(harness.viewLog);
    for (const forbidden of [POLICY_SECRET, "private.invalid", "/private/"]) {
      assert.equal(log.includes(forbidden), false, forbidden);
    }
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "error"), true);
    harness.controller.destroy();
  } finally {
    globals.restore();
  }
});

test("4C DOM/CSS：三栏、真实横向 owner、四字段语义、aria-live、稳定焦点 token 与纵向列滚动", () => {
  for (const contract of [
    /policy-workspace-track/,
    /className:\s*"policy-workspace"[\s\S]*tabindex:\s*"0"/,
    /01 · 站点/,
    /02 · 当前站点/,
    /03 · 状态与操作/,
    /createElement\("nav"/,
    /policy-column-scroll/,
    /max_concurrency/,
    /retry_limit/,
    /backoff_base_seconds/,
    /proxy_mode/,
    /aria-live/,
    /恢复默认设置/,
    /影响范围/,
  ]) assert.match(POLICY_DOM_SOURCE, contract);
  assert.match(POLICY_VIEW_SOURCE, /policyFocusToken/);
  assert.match(POLICY_VIEW_SOURCE, /restorePolicyFocus/);
  assert.match(POLICY_VIEW_SOURCE, /setCustomValidity/);
  assert.match(POLICY_VIEW_SOURCE, /validatePolicyDraft/);
  assert.match(POLICY_VIEW_SOURCE, /aria-invalid/);
  assert.match(POLICY_VIEW_SOURCE, /elements\.workspace/);
  assert.match(POLICY_CSS_SOURCE, /\.window-body:has\(> \.policy-app\)/);
  assert.match(POLICY_CSS_SOURCE, /\.policy-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(POLICY_CSS_SOURCE, /\.policy-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(POLICY_CSS_SOURCE, /\.policy-workspace-track\s*\{[^}]*min-width\s*:\s*(?:1080|1100|1120|1140|1160)px/s);
  assert.match(POLICY_CSS_SOURCE, /\.policy-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(POLICY_CSS_SOURCE, /\.application-window\[data-maximized\] \.policy-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(POLICY_CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(POLICY_CSS_SOURCE, /forced-colors/);
  assert.match(POLICY_CSS_SOURCE, /prefers-reduced-motion|data-motion/);
  assert.doesNotMatch(POLICY_CSS_SOURCE, /@media\s*\(max-width\s*:/);
  assert.doesNotMatch(POLICY_CSS_SOURCE, /backdrop-filter/);
});

test("4C static boundary：唯一 Policy endpoint/view，无 polling/旁路 I/O/storage/console/innerHTML/fixture 且四生命周期", () => {
  assert.deepEqual(POLICY_ENDPOINTS, { policies: "/api/v1/sites/policies" });
  assert.equal((POLICY_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 1);
  assert.equal((POLICY_APP_SOURCE.match(/view=policy/g) || []).length, 1);
  const combined = [POLICY_APP_SOURCE, POLICY_MODEL_SOURCE, POLICY_VIEW_SOURCE, POLICY_DOM_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
    /polling\.start|setInterval|setTimeout/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(POLICY_APP_SOURCE, /AbortController/);
  assert.match(POLICY_APP_SOURCE, /createPolicyRequestGate/);
  assert.match(POLICY_APP_SOURCE, /discardRequest/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof policyApplication[hook], "function");
  }
  assert.equal(typeof createPolicyController, "function");
});
