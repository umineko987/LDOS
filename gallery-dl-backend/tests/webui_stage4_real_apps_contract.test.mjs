import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";
import proxyApplication, {
  createProxyController,
  PROXY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/proxy.js";
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

const PROXY_SECRET = "stage4-proxy-cookie-token-password-secret-271828";
const PROXY_CONFIGURED_REVISION = "a".repeat(64);
const PROXY_ACTIVE_REVISION = "b".repeat(64);
const PROXY_SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const PROXY_INLINE_ID = `node_${"d".repeat(64)}`;

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

test("4A CSS：普通 800x560 有局部可聚焦横向 scroll owner，最大化三栏独立纵向滚动", () => {
  assert.match(TASKS_CSS_SOURCE, /\.window-body:has\(> \.tasks-app\)/);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace-track\s*\{[^}]*min-width\s*:\s*(?:1080|1100|1120|1140|1160)px/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(TASKS_CSS_SOURCE, /\.application-window\[data-maximized\] \.tasks-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(TASKS_CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(TASKS_CSS_SOURCE, /forced-colors/);
  assert.match(TASKS_CSS_SOURCE, /prefers-reduced-motion|data-motion/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /backdrop-filter/);
  assert.match(TASKS_VIEW_SOURCE, /className:\s*"tasks-workspace"[\s\S]*tabindex:\s*"0"/);
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

test("4B controller：仅 active app 每 10s poll，deactivate/destroy 停止并中止", async () => {
  const restore = installProxyControllerDom();
  try {
    const harness = proxyControllerHarness();
    harness.controller.activate();
    await flush();
    const poll = harness.polling.entries.get("proxy.status");
    assert.equal(poll.intervalMs, PROXY_STATUS_POLL_INTERVAL_MS);
    assert.equal(poll.intervalMs, 10_000);
    assert.equal(poll.scope, "app:proxy");
    assert.equal(harness.calls.filter((call) => call[0] === "get" && call[1] === PROXY_ENDPOINTS.sources).length, 1);
    harness.controller.deactivate();
    assert.equal(harness.polling.entries.has("proxy.status"), false);
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

test("4B controller：保存 source draft 与 reload 分离，控制写后权威 status+sources 重读", async () => {
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
    const beforeSave = { statusReads, sourceReads };

    const submitted = harness.submit(
      "subscription-add",
      `https://user:${PROXY_SECRET}@provider.invalid/private?token=${PROXY_SECRET}`,
    );
    await flush();
    assert.equal(submitted.input.value, "");
    const save = harness.calls.find((call) => call[0] === "post" && call[1] === PROXY_ENDPOINTS.subscriptions);
    assert.equal(Boolean(save), true);
    assert.equal(harness.calls.some((call) => call[1] === PROXY_ENDPOINTS.reload), false);
    assert.equal(statusReads, beforeSave.statusReads + 1);
    assert.equal(sourceReads, beforeSave.sourceReads + 1);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "message" && /尚未改变/.test(entry[1])), true);

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

test("4B controller：start/stop/reload/probe 单飞并各自写后权威重读", async () => {
  const restore = installProxyControllerDom();
  try {
    const endpoints = ["start", "stop", "reload", "probe"];
    for (const action of endpoints) {
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
      const reads = harness.calls.slice(before).filter((call) => call[0] === "get").map(getCallUrl).sort();
      assert.deepEqual(reads, [PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status].sort(), action);
      harness.controller.destroy();
    }
  } finally {
    restore();
  }
});

test("4B controller：delete confirm deny/allow，危险操作只在允许后写入并重读", async () => {
  const restore = installProxyControllerDom();
  try {
    const deny = proxyControllerHarness({ dialogChoice: "cancel" });
    deny.controller.activate();
    await flush();
    deny.click("subscription-delete", PROXY_SUBSCRIPTION_ID);
    await flush();
    assert.equal(deny.dialogOptions[0].dangerous, true);
    assert.equal(deny.calls.some((call) => call[0] === "delete"), false);
    deny.controller.destroy();

    const allow = proxyControllerHarness();
    allow.controller.activate();
    await flush();
    const before = allow.calls.length;
    allow.click("subscription-delete", PROXY_SUBSCRIPTION_ID);
    await flush();
    assert.equal(allow.dialogOptions[0].dangerous, true);
    assert.equal(allow.calls.some((call) => call[0] === "delete" &&
      call[1] === `${PROXY_ENDPOINTS.subscriptions}/${PROXY_SUBSCRIPTION_ID}`), true);
    assert.deepEqual(
      allow.calls.slice(before).filter((call) => call[0] === "get").map(getCallUrl).sort(),
      [PROXY_ENDPOINTS.sources, PROXY_ENDPOINTS.status].sort(),
    );
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

test("4B target：Proxy 使用可聚焦三段工作区和独立滚动列", () => {
  assert.match(PROXY_DOM_SOURCE, /proxy-workspace-track/);
  assert.match(PROXY_DOM_SOURCE, /className:\s*"proxy-workspace"[\s\S]*tabindex:\s*"0"/);
  assert.match(PROXY_DOM_SOURCE, /01 · 状态/);
  assert.match(PROXY_DOM_SOURCE, /02 · 运行池/);
  assert.match(PROXY_DOM_SOURCE, /03 · 来源/);
  assert.match(PROXY_CSS_SOURCE, /\.window-body:has\(> \.proxy-app\)/);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-workspace-track\s*\{[^}]*min-width\s*:\s*(?:1080|1100|1120|1140|1160)px/s);
  assert.match(PROXY_CSS_SOURCE, /\.proxy-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(PROXY_CSS_SOURCE, /\.application-window\[data-maximized\] \.proxy-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(PROXY_CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(PROXY_CSS_SOURCE, /forced-colors/);
  assert.match(PROXY_CSS_SOURCE, /prefers-reduced-motion|data-motion/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(PROXY_CSS_SOURCE, /backdrop-filter/);
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
