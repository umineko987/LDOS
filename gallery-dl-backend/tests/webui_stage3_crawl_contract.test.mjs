import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import * as crawlModel from "../gdl_backend/webui/js/core/crawl-model.js";
import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";
import crawlApplication, * as crawlControllerModule from "../gdl_backend/webui/js/apps/crawl.js";
import * as crawlViewModule from "../gdl_backend/webui/js/components/crawl-view.js";
import {
  createCrawlView,
  createSourceErrorWarning,
  readCrawlSourceOptions,
} from "../gdl_backend/webui/js/components/crawl-view.js";

const {
  CRAWL_PAGE_LIMITS,
  CRAWL_SITE_DEFINITIONS,
  buildCrawlPayload,
  buildSearchPayload,
  candidateMatchesEhFilter,
  deriveCrawlPreconditions,
  validateCrawlDraft,
  validateSearchDraft,
  crawlCandidateVisible,
  crawlErrorGuidance,
  deriveCrawlSearchPresentation,
  deriveCrawlSubmitPresentation,
  parseEhTag,
  projectCrawlSearchResponse,
  sanitizeAutocompleteResponse,
} = crawlModel;
const {
  AUTOCOMPLETE_DELAY_MS,
  CRAWL_ENDPOINTS,
  createCrawlController,
} = crawlControllerModule;

const SECRET = "stage3-token-cookie-secret-991425f1c4";
const SITE_IDS = ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"];
const REPO_ROOT = new URL("../", import.meta.url);
const CRAWL_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/crawl.js", import.meta.url),
  "utf8",
);
const CRAWL_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/crawl-view.js", import.meta.url),
  "utf8",
);
const CRAWL_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/crawl.css", import.meta.url),
  "utf8",
);

function sourceResult(site, addresses = [], overrides = {}) {
  return {
    site,
    status: "succeeded",
    evidence_count: addresses.length,
    preview_count: addresses.length,
    attempts: 1,
    auth: { state: ["twitter", "pixiv", "exhentai"].includes(site) ? "required" : "public", authorized: !["twitter", "pixiv", "exhentai"].includes(site) },
    addresses,
    weak_evidence: [],
    tag_facets: [],
    ...overrides,
  };
}

function candidate(site, id, overrides = {}) {
  const origins = {
    danbooru: `https://danbooru.donmai.us/posts?tags=artist_${id}`,
    twitter: `https://x.com/artist_${id}/media`,
    pixiv: `https://www.pixiv.net/users/${100 + Number(id)}/artworks`,
    exhentai: `https://e-hentai.org/g/${3000 + Number(id)}/a${String(id).padStart(9, "0")}/`,
    pawchive: `https://pawoo.net/@artist_${id}`,
  };
  return {
    id: `${site}-${id}`,
    label: `${site} candidate ${id}`,
    address_type: site === "exhentai" ? "gallery" : "account",
    url: origins[site],
    confidence: "verified",
    media_count: 2,
    evidence_reasons: ["site_search_work_evidence"],
    metadata: {},
    ...overrides,
  };
}

function completeSearchResponse() {
  return {
    keyword: "stage3",
    sources: [
      sourceResult("danbooru", [candidate("danbooru", "1"), candidate("danbooru", "2")]),
      sourceResult("twitter", [candidate("twitter", "1")]),
      sourceResult("pixiv", [candidate("pixiv", "1")]),
      sourceResult("exhentai", [candidate("exhentai", "1", {
        thumbnail_url: "https://ehgt.org/w/stage3.webp",
        metadata: { tags: ["artist:stage3", "language:chinese"] },
      })], {
        status: "partial",
        error: { code: "exhentai_preview_lookup_failed", message: `https://private.invalid/${SECRET}` },
        tag_facets: [{
          namespace: "artist",
          label: "画师",
          gallery_count: 1,
          tags: [{ tag: "artist:stage3", count: 1 }],
        }],
      }),
      sourceResult("pawchive", [candidate("pawchive", "1")], {
        weak_evidence: [candidate("pawchive", "2", {
          confidence: "weak",
          evidence_reasons: ["account_identity_unverified"],
        })],
      }),
    ],
    related_profiles: [{
      artist_name: "Stage 3",
      platform: "twitter",
      url: `https://user:${SECRET}@x.com/stage3?token=${SECRET}#private`,
    }, {
      artist_name: "Safe",
      platform: "pixiv",
      url: "https://www.pixiv.net/users/303",
    }],
    raw: SECRET,
  };
}

function selectCandidate(snapshot, sourceIndex, candidateIndex, selected = true) {
  const sources = snapshot.sources.map((source, index) => index === sourceIndex
    ? {
        ...source,
        addresses: source.addresses.map((item, itemIndex) => itemIndex === candidateIndex
          ? { ...item, selected }
          : item),
      }
    : source);
  return { ...snapshot, sources };
}

function selectedSnapshot(projected) {
  let snapshot = projected.snapshot;
  snapshot = selectCandidate(snapshot, 4, 0);
  snapshot = selectCandidate(snapshot, 0, 1);
  snapshot = selectCandidate(snapshot, 0, 0);
  return {
    ...snapshot,
    sources: [snapshot.sources[4], snapshot.sources[0], ...snapshot.sources.slice(1, 4)],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class TestClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

function selectorDataName(name) {
  return name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

class TestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new TestClassList();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.name = "";
    this.listeners = new Map();
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name === "name") this.name = text;
    if (name.startsWith("data-")) this.dataset[selectorDataName(name)] = text;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
    if (name.startsWith("data-")) delete this.dataset[selectorDataName(name)];
  }
  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }
  addEventListener(type, listener, _options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener, _options) { this.listeners.get(type)?.delete(listener); }
  emit(type, target = this, init = {}) {
    const event = {
      type,
      target,
      key: "",
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...init,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
  append(...items) {
    for (const item of items) {
      if (!(item instanceof TestElement)) continue;
      item.parentNode = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children.forEach((item) => { item.parentNode = null; });
    this.children = [];
    this.append(...items);
  }
  contains(item) {
    return item === this || this.children.some((child) => child.contains(item));
  }
  matches(selector) {
    if (selector === "button") return this.tagName === "BUTTON";
    if (selector === "button, input") return ["BUTTON", "INPUT"].includes(this.tagName);
    if (selector === "button, input, select, textarea, [tabindex]") {
      return ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName) || this.hasAttribute("tabindex");
    }
    const data = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(selector);
    if (data) {
      const value = this.dataset[selectorDataName(`data-${data[1]}`)];
      return value !== undefined && (data[2] === undefined || value === data[2]);
    }
    return false;
  }
  closest(selector) {
    let current = this;
    while (current instanceof TestElement) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
}

class TestButton extends TestElement { constructor() { super("button"); } }
class TestInput extends TestElement { constructor() { super("input"); } }
class TestSelect extends TestElement { constructor() { super("select"); } }
class TestForm extends TestElement { constructor() { super("form"); } }

function installControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentObject = { activeElement: null };
  install("Element", TestElement);
  install("HTMLElement", TestElement);
  install("HTMLButtonElement", TestButton);
  install("HTMLInputElement", TestInput);
  install("HTMLSelectElement", TestSelect);
  install("HTMLFormElement", TestForm);
  install("document", documentObject);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function controllerHarness({ apiOverrides = {}, initialSearch = null } = {}) {
  const root = new TestElement("main");
  const keyword = new TestInput();
  keyword.value = "stage 3";
  keyword.setAttribute("role", "combobox");
  keyword.setAttribute("aria-expanded", "false");
  keyword.setAttribute("aria-controls", "crawl-suggestions");
  const suggestions = new TestElement("div");
  suggestions.hidden = true;
  const ehTagQuery = new TestInput();
  const gpPolicy = new TestSelect();
  const outputDir = new TestInput();
  outputDir.value = "/private/output";
  const viewLog = [];
  const suggestionButtons = [];
  const view = {
    elements: { keyword, suggestions, ehTagQuery, gpPolicy, outputDir },
    readSearchDraft: () => ({
      keyword: keyword.value,
      sites: [...SITE_IDS],
      limit: 20,
      proxyMode: "required",
      sourceOptions: { pixiv: { proxy_mode: "direct" } },
    }),
    readCrawlDraft: () => ({
      concurrency: 20,
      maxTasks: 1000,
      proxyMode: "required",
      outputDir: outputDir.value,
      sourceOptions: {},
      ehDownload: { image_mode: "original", gp_policy: "stop" },
    }),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setSearchState: (state, meta = {}) => viewLog.push(["search-state", state, meta]),
    showError: (guidance) => viewLog.push(["error", guidance]),
    clearError: () => viewLog.push(["clear-error"]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    renderPreconditions: () => viewLog.push(["preconditions"]),
    setSuggestions(items) {
      suggestionButtons.length = 0;
      items.forEach((item, index) => {
        const button = new TestButton();
        button.dataset.crawlAction = "suggestion";
        button.dataset.suggestionValue = item.value;
        button.dataset.suggestionIndex = String(index);
        button.setAttribute("role", "option");
        suggestions.append(button);
        suggestionButtons.push(button);
      });
      suggestions.hidden = items.length === 0;
      keyword.setAttribute("aria-expanded", items.length ? "true" : "false");
      viewLog.push(["suggestions", items.map((item) => item.value)]);
    },
    hideSuggestions() {
      suggestions.hidden = true;
      suggestions.replaceChildren();
      suggestionButtons.length = 0;
      keyword.setAttribute("aria-expanded", "false");
      keyword.removeAttribute("aria-activedescendant");
      viewLog.push(["hide-suggestions"]);
    },
    moveSuggestionFocus(command) {
      if (!suggestionButtons.length) return false;
      let index = suggestionButtons.indexOf(globalThis.document.activeElement);
      if (command === "first") index = 0;
      else if (command === "last") index = suggestionButtons.length - 1;
      else if (command === "next") index = Math.min(suggestionButtons.length - 1, Math.max(0, index + 1));
      else if (command === "previous") index = Math.max(0, index < 0 ? suggestionButtons.length - 1 : index - 1);
      suggestionButtons[index].focus();
      keyword.setAttribute("aria-activedescendant", `crawl-suggestion-${index}`);
      return true;
    },
    activeSuggestionValue() {
      return suggestionButtons.find((item) => item === globalThis.document.activeElement)?.dataset.suggestionValue || "";
    },
    visibleCandidateKeys: () => [],
    sourceCandidateKeys: (sourceKey) => store.getState().crawl.sources
      .find((source) => source.key === sourceKey)?.addresses.map((item) => item.key) || [],
    sourceVisibleKeys: () => [],
    activeSourceKey: () => store.getState().crawl.sources[0]?.key || "",
    validateSearchDraft() {
      return view.searchValidation || { valid: true, reason: "", field: "" };
    },
    validateCrawlDraft() {
      return view.crawlValidation || { valid: true, reason: "", field: "" };
    },
    setOperationalAvailability: (available) => viewLog.push(["operational", available]),
    refreshValidation: () => { viewLog.push(["validation"]); return view.searchValidation || view.crawlValidation || { valid: true, reason: "", field: "" }; },
    handleInvalid: () => viewLog.push(["invalid"]),
    normalizeActiveSource: () => viewLog.push(["normalize-source"]),
    setActiveSource: (key) => viewLog.push(["active-source", key]),
    setEhQuery: () => {},
    clearOutputInput() { outputDir.value = ""; viewLog.push(["clear-output"]); },
    destroy: () => viewLog.push(["destroy"]),
  };
  const store = createStore({ reportError: () => {} });
  let operations = new Map();
  if (initialSearch) {
    const projected = projectCrawlSearchResponse(initialSearch);
    operations = projected.operations;
    store.dispatch(actionCreators.crawlSearchReceived(initialSearch));
  }
  const calls = [];
  const api = {
    get: (...args) => {
      calls.push(["get", ...args]);
      return apiOverrides.get ? apiOverrides.get(...args) : Promise.resolve({ items: [] });
    },
    post: (...args) => {
      calls.push(["post", ...args]);
      return apiOverrides.post ? apiOverrides.post(...args) : Promise.resolve({});
    },
  };
  const actionsLog = [];
  const actions = {
    setActiveBatchId(id) { actionsLog.push(["active", id]); },
    navigateToApp(id) { actionsLog.push(["navigate", id]); },
  };
  const controller = createCrawlController(
    { root, api, store, actions },
    { createView: () => view, initialOperations: operations },
  );
  return { root, keyword, suggestions, outputDir, view, viewLog, store, api, calls, actionsLog, controller, suggestionButtons };
}

test("3A model：五站顺序、全局/来源 proxy、limit 与精确 search payload", () => {
  assert.equal(Object.isFrozen(CRAWL_SITE_DEFINITIONS), true);
  assert.deepEqual(CRAWL_SITE_DEFINITIONS.map((item) => item.id), SITE_IDS);
  assert.deepEqual(CRAWL_PAGE_LIMITS, { search: 200, addresses: 500, tasks: 100_000 });

  assert.deepEqual(buildSearchPayload({
    keyword: "  stage 3  ",
    sites: ["pawchive", "pixiv", "danbooru", "pixiv"],
    limit: 37,
    proxyMode: "prefer",
    sourceOptions: {
      danbooru: { proxy_mode: "direct", ignored: SECRET },
      pixiv: { proxy_mode: "required" },
      twitter: { proxy_mode: "direct" },
      unknown: { proxy_mode: "direct" },
    },
  }), {
    keyword: "stage 3",
    sites: ["danbooru", "pixiv", "pawchive"],
    limit: 37,
    proxy_mode: "prefer",
    source_options: {
      danbooru: { proxy_mode: "direct" },
      pixiv: { proxy_mode: "required" },
    },
  });

  for (const invalid of [
    { keyword: "", sites: ["danbooru"], limit: 1, proxyMode: "direct" },
    { keyword: `x\n${SECRET}`, sites: ["danbooru"], limit: 1, proxyMode: "direct" },
    { keyword: "x", sites: [], limit: 1, proxyMode: "direct" },
    { keyword: "x", sites: ["danbooru"], limit: 0, proxyMode: "direct" },
    { keyword: "x", sites: ["danbooru"], limit: 201, proxyMode: "direct" },
    { keyword: "x", sites: ["danbooru"], limit: 1, proxyMode: "secret" },
    { keyword: "x", sites: ["danbooru"], limit: 1, proxyMode: "direct", sourceOptions: { danbooru: { proxy_mode: "secret" } } },
  ]) assert.throws(() => buildSearchPayload(invalid), TypeError);
});

test("3A model：白名单投影、EH allowlist 与安全外链不泄漏 raw URL", () => {
  const raw = completeSearchResponse();
  raw.sources[3].addresses.push(candidate("exhentai", "9", {
    thumbnail_url: `https://evil.invalid/${SECRET}.webp`,
    url: `https://e-hentai.org/g/3009/a000000009/?token=${SECRET}`,
  }));
  raw.related_profiles.push({
    artist_name: "Credential",
    platform: "twitter",
    url: `https://user:${SECRET}@x.com/stage3`,
  });
  const projected = projectCrawlSearchResponse(raw);
  const serialized = JSON.stringify(projected.snapshot);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("e-hentai.org/g/"), false);
  assert.equal(projected.operations.size, 8);
  assert.equal([...projected.operations.values()].some((item) => item.url.includes("e-hentai.org/g/")), true);
  assert.equal(projected.snapshot.sources[3].addresses[0].thumbnailUrl, "https://ehgt.org/w/stage3.webp");
  assert.equal(projected.snapshot.sources[3].addresses[1].thumbnailUrl, "");
  assert.deepEqual(projected.snapshot.relatedProfiles, [{
    artist: "Safe", platform: "pixiv", host: "pixiv.net", url: "https://www.pixiv.net/users/303",
  }]);
  assert.match(projected.snapshot.sources[3].errorMessage, /地址已隐藏/);
  assert.equal(projected.snapshot.sources[3].errorMessage.includes(SECRET), false);
  assert.throws(() => projectCrawlSearchResponse({ sources: null }), /搜索响应格式无效/);
});

test("3A model/store：来源、地址与筛选顺序精确进入 crawl payload", () => {
  const projected = projectCrawlSearchResponse(completeSearchResponse());
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.crawlSearchReceived(completeSearchResponse()));
  const danbooru = store.getState().crawl.sources[0];
  const pawchive = store.getState().crawl.sources[4];
  store.dispatch(actionCreators.crawlCandidateSelectionChanged(danbooru.addresses[0].key, true));
  store.dispatch(actionCreators.crawlCandidateSelectionChanged(danbooru.addresses[1].key, true));
  store.dispatch(actionCreators.crawlCandidateSelectionChanged(pawchive.addresses[0].key, true));
  store.dispatch(actionCreators.crawlCandidateMoved(danbooru.key, danbooru.addresses[1].key, -1));
  for (let index = 0; index < 4; index += 1) {
    store.dispatch(actionCreators.crawlSourceMoved(pawchive.key, -1));
  }

  const payload = buildCrawlPayload({
    snapshot: store.getState().crawl,
    operations: projected.operations,
    concurrency: 31,
    maxTasks: 4242,
    proxyMode: "prefer",
    outputDir: "stage3/output",
    sourceOptions: { pawchive: { proxy_mode: "direct" } },
    ehDownload: { image_mode: "original", gp_policy: "stop" },
  });
  assert.deepEqual(Object.keys(payload), ["sources", "concurrency", "max_tasks", "proxy_mode", "output_dir"]);
  assert.deepEqual(payload.sources.map((source) => source.site), ["pawchive", "danbooru"]);
  assert.equal(payload.sources[0].proxy_mode, "direct");
  assert.deepEqual(payload.sources[1].addresses.map((item) => item.id), ["danbooru-2", "danbooru-1"]);
  assert.deepEqual(payload.sources[1].addresses.map((item) => Object.keys(item)), [
    ["url", "id", "label", "address_type"],
    ["url", "id", "label", "address_type"],
  ]);
  assert.equal(payload.concurrency, 31);
  assert.equal(payload.max_tasks, 4242);
  assert.equal(payload.proxy_mode, "prefer");
  assert.equal(payload.output_dir, "stage3/output");
  const stored = JSON.stringify(store.getState().crawl);
  assert.equal(stored.includes("danbooru.donmai.us/posts"), false);
  assert.equal(stored.includes("e-hentai.org/g/"), false);
  assert.equal(stored.includes("x.com/artist_1/media"), false);
});

test("3A model：EH include/exclude、筛选外已选、弱证据与下载 fallback 约束", () => {
  const projected = projectCrawlSearchResponse(completeSearchResponse());
  const eh = projected.snapshot.sources[3];
  const item = eh.addresses[0];
  assert.equal(parseEhTag("a:Stage3").key, "artist:stage3");
  assert.equal(candidateMatchesEhFilter(item, new Map([["artist:stage3", "include"]])), true);
  assert.equal(candidateMatchesEhFilter(item, new Map([["language:english", "include"]])), false);
  assert.equal(candidateMatchesEhFilter(item, new Map([
    ["artist:stage3", "include"], ["language:chinese", "exclude"],
  ])), false);
  assert.equal(crawlCandidateVisible(projected.snapshot, projected.snapshot.sources[4], projected.snapshot.sources[4].addresses[1]), false);
  assert.equal(crawlCandidateVisible({ ...projected.snapshot, showWeakEvidence: true }, projected.snapshot.sources[4], projected.snapshot.sources[4].addresses[1]), true);

  const selected = selectCandidate(projected.snapshot, 3, 0);
  for (const ehDownload of [
    { image_mode: "original", gp_policy: "stop" },
    { image_mode: "original", gp_policy: "resized" },
    { image_mode: "resample", gp_policy: "stop" },
  ]) {
    const payload = buildCrawlPayload({
      snapshot: selected,
      operations: projected.operations,
      concurrency: 1,
      maxTasks: 1,
      proxyMode: "direct",
      ehDownload,
    });
    assert.deepEqual(payload.sources[0].eh_download, ehDownload);
  }
  assert.throws(() => buildCrawlPayload({
    snapshot: selected, operations: projected.operations, concurrency: 1, maxTasks: 1,
    proxyMode: "direct", ehDownload: { image_mode: "resample", gp_policy: "resized" },
  }), /EH 下载选项无效/);
});

test("3A model：共享草稿验证覆盖搜索、创建、控制字符与 EH 组合", () => {
  const validSearch = {
    keyword: "stage 3",
    sites: ["danbooru"],
    limit: 20,
    proxyMode: "required",
    sourceOptions: {},
  };
  assert.deepEqual(validateSearchDraft(validSearch), { valid: true, reason: "", field: "" });
  assert.equal(validateSearchDraft({ ...validSearch, keyword: "" }).field, "keyword");
  assert.equal(validateSearchDraft({ ...validSearch, keyword: `safe\n${SECRET}` }).field, "keyword");
  assert.equal(validateSearchDraft({ ...validSearch, sites: [] }).field, "sites");
  assert.equal(validateSearchDraft({ ...validSearch, limit: 201 }).field, "search-limit");
  assert.equal(validateSearchDraft({ ...validSearch, proxyMode: "secret" }).field, "search-proxy");

  const validCrawl = {
    concurrency: 20,
    maxTasks: 1000,
    proxyMode: "required",
    outputDir: "stage3/output",
    sourceOptions: {},
    ehDownload: { image_mode: "original", gp_policy: "stop" },
  };
  assert.deepEqual(validateCrawlDraft(validCrawl), { valid: true, reason: "", field: "" });
  assert.equal(validateCrawlDraft({ ...validCrawl, concurrency: 0 }).field, "concurrency");
  assert.equal(validateCrawlDraft({ ...validCrawl, maxTasks: 100001 }).field, "max-tasks");
  assert.equal(validateCrawlDraft({ ...validCrawl, outputDir: `safe\n${SECRET}` }).field, "output-dir");
  assert.equal(validateCrawlDraft({
    ...validCrawl,
    ehDownload: { image_mode: "resample", gp_policy: "resized" },
  }).field, "eh-gp-policy");
  for (const validation of [
    validateSearchDraft({ ...validSearch, keyword: `safe\n${SECRET}` }),
    validateCrawlDraft({ ...validCrawl, outputDir: `/private/${SECRET}\n` }),
  ]) {
    assert.equal(JSON.stringify(validation).includes(SECRET), false);
    assert.equal(JSON.stringify(validation).includes("/private/"), false);
  }
});

test("3A model：代理/授权前置条件投影全局、来源覆盖和 readiness", () => {
  const disabled = { status: "disabled", running: false, healthy: 0, sourceCount: 0 };
  const error = { status: "error", running: false, healthy: 0, sourceCount: 0 };
  const running = { status: "ok", running: true, healthy: 2, sourceCount: 3 };
  const sourceDrafts = CRAWL_SITE_DEFINITIONS.map(({ id }) => ({ site: id, enabled: true, proxyMode: "" }));

  assert.deepEqual(deriveCrawlPreconditions({
    readinessProxy: disabled,
    authBySite: new Map(),
    crawlSources: [],
    sourceDrafts,
    searchProxyMode: "required",
    crawlProxyMode: "required",
  }).proxy, {
    severity: "required",
    state: "disabled",
    label: "代理已禁用，当前仅代理模式不可用",
    action: "open-proxy",
  });
  assert.equal(deriveCrawlPreconditions({
    readinessProxy: running,
    authBySite: new Map(),
    crawlSources: [],
    sourceDrafts,
    searchProxyMode: "direct",
    crawlProxyMode: "direct",
  }).proxy, null);
  assert.equal(deriveCrawlPreconditions({
    readinessProxy: error,
    authBySite: new Map(),
    crawlSources: [],
    sourceDrafts: sourceDrafts.map((item) => item.site === "pixiv"
      ? { ...item, proxyMode: "required" }
      : item),
    searchProxyMode: "direct",
    crawlProxyMode: "direct",
  }).proxy.severity, "required");
  assert.equal(deriveCrawlPreconditions({
    readinessProxy: disabled,
    authBySite: new Map(),
    crawlSources: [],
    sourceDrafts,
    searchProxyMode: "prefer",
    crawlProxyMode: "direct",
  }).proxy.severity, "prefer");
  assert.deepEqual(deriveCrawlPreconditions({
    readinessProxy: running,
    authBySite: new Map([["pixiv", { authorized: false }]]),
    crawlSources: [],
    sourceDrafts,
    searchProxyMode: "direct",
    crawlProxyMode: "direct",
  }).authSites, ["pixiv"]);
});

test("3A model：创建参数校验、0 选择禁用原因与显式搜索状态", () => {
  const projected = projectCrawlSearchResponse(completeSearchResponse());
  for (const invalid of [
    { concurrency: 0, maxTasks: 1, proxyMode: "direct" },
    { concurrency: 129, maxTasks: 1, proxyMode: "direct" },
    { concurrency: 1, maxTasks: 0, proxyMode: "direct" },
    { concurrency: 1, maxTasks: 100001, proxyMode: "direct" },
    { concurrency: 1, maxTasks: 1, proxyMode: "invalid" },
    { concurrency: 1, maxTasks: 1, proxyMode: "direct", outputDir: `bad\n${SECRET}` },
  ]) assert.throws(() => buildCrawlPayload({
    snapshot: selectCandidate(projected.snapshot, 0, 0),
    operations: projected.operations,
    ehDownload: { image_mode: "original", gp_policy: "stop" },
    ...invalid,
  }), TypeError);
  assert.throws(() => buildCrawlPayload({
    snapshot: projected.snapshot, operations: projected.operations,
    concurrency: 1, maxTasks: 1, proxyMode: "direct",
  }), /至少选择一个采集来源/);

  assert.deepEqual(deriveCrawlSearchPresentation({ snapshot: projectCrawlSearchResponse({ sources: [] }).snapshot, phase: "initial" }), {
    state: "initial", hasResults: false, partialSourceCount: 0, failedSourceCount: 0,
  });
  assert.equal(deriveCrawlSearchPresentation({ snapshot: projected.snapshot, phase: "loading" }).state, "loading");
  assert.equal(deriveCrawlSearchPresentation({ snapshot: projectCrawlSearchResponse({ sources: SITE_IDS.map((site) => sourceResult(site)) }).snapshot, phase: "settled" }).state, "empty");
  assert.equal(deriveCrawlSearchPresentation({ snapshot: projected.snapshot, phase: "settled" }).state, "partial");
  assert.equal(deriveCrawlSearchPresentation({ snapshot: projected.snapshot, phase: "error" }).state, "error");
  assert.equal(deriveCrawlSearchPresentation({ snapshot: projected.snapshot, phase: "recovery" }).state, "recovery");
  assert.deepEqual(deriveCrawlSubmitPresentation(projected.snapshot, { busy: "" }), {
    state: "disabled", selectedSourceCount: 0, selectedAddressCount: 0, reason: "请先选择至少一个候选地址。",
  });
  const selected = selectCandidate(projected.snapshot, 0, 0);
  assert.equal(deriveCrawlSubmitPresentation(selected, { busy: "crawl", invalidReason: "失效" }).state, "busy");
  assert.equal(deriveCrawlSubmitPresentation(selected, { busy: "", staleReason: "操作地址已安全清理" }).state, "stale");
  assert.equal(deriveCrawlSubmitPresentation(selected, { busy: "", invalidReason: "并发数无效" }).state, "invalid");
  assert.equal(deriveCrawlSubmitPresentation(selected, { busy: "" }).state, "ready");
});

test("3A model：422/409/transport/auth/proxy 错误只给安全恢复动作", () => {
  const cases = [
    [{ status: 422, code: "invalid_crawl", requestId: "req-422", details: SECRET }, "diagnostics"],
    [{ status: 409, code: "crawl_conflict", message: `https://private/${SECRET}` }, "diagnostics"],
    [{ status: 0, code: "network_error", message: `/home/${SECRET}` }, "diagnostics"],
    [{ status: 401, code: "authentication_required" }, "vault"],
    [{ status: 503, code: "proxy_pool_unavailable" }, "proxy"],
  ];
  for (const [error, app] of cases) {
    const guidance = crawlErrorGuidance(error);
    assert.equal(guidance.targetApp, app);
    assert.equal(JSON.stringify(guidance).includes(SECRET), false);
    assert.equal(JSON.stringify(guidance).includes("https://"), false);
    assert.equal(JSON.stringify(guidance).includes("/home/"), false);
  }
});

test("3A autocomplete：300ms、URL encode、Abort/sequence/lifecycle 与完整键盘 combobox", async () => {
  const restore = installControllerDom();
  try {
    const first = deferred();
    const second = deferred();
    const requests = [];
    const harness = controllerHarness({
      apiOverrides: {
        get(url, options) {
          const item = requests.length === 0 ? first : second;
          requests.push({ url, options, item });
          return item.promise;
        },
      },
    });
    harness.controller.activate();
    assert.equal(AUTOCOMPLETE_DELAY_MS, 300);
    assert.equal(harness.keyword.getAttribute("role"), "combobox");
    assert.equal(harness.keyword.getAttribute("aria-controls"), "crawl-suggestions");
    assert.equal(harness.keyword.getAttribute("aria-expanded"), "false");

    harness.keyword.value = "柠檬 静&x";
    harness.root.emit("input", harness.keyword);
    assert.equal(requests.length, 0);
    await new Promise((resolve) => setTimeout(resolve, AUTOCOMPLETE_DELAY_MS + 30));
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /q=%E6%9F%A0%E6%AA%AC%20%E9%9D%99%26x/);
    assert.equal(requests[0].options.signal.aborted, false);

    harness.keyword.value = "new query";
    harness.root.emit("input", harness.keyword);
    assert.equal(requests[0].options.signal.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, AUTOCOMPLETE_DELAY_MS + 30));
    assert.equal(requests.length, 2);
    second.resolve({ items: [
      { value: "new_1", label: "New 1", category: "artist" },
      { value: "new_2", label: "New 2", category: "artist" },
      { value: "new_3", label: "New 3", category: "artist" },
    ] });
    await flush();
    assert.deepEqual(harness.viewLog.filter((item) => item[0] === "suggestions").at(-1), ["suggestions", ["new_1", "new_2", "new_3"]]);
    first.resolve({ items: [{ value: "stale", label: "Stale", category: "artist" }] });
    await flush();
    assert.equal(JSON.stringify(harness.viewLog).includes("stale"), false);

    const down = harness.root.emit("keydown", harness.keyword, { key: "ArrowDown" });
    assert.equal(down.defaultPrevented, true);
    assert.equal(globalThis.document.activeElement.dataset.suggestionValue, "new_1");
    harness.root.emit("keydown", globalThis.document.activeElement, { key: "End" });
    assert.equal(globalThis.document.activeElement.dataset.suggestionValue, "new_3");
    harness.root.emit("keydown", globalThis.document.activeElement, { key: "Home" });
    assert.equal(globalThis.document.activeElement.dataset.suggestionValue, "new_1");
    harness.root.emit("keydown", globalThis.document.activeElement, { key: "ArrowUp" });
    assert.equal(globalThis.document.activeElement.dataset.suggestionValue, "new_1");
    harness.root.emit("keydown", globalThis.document.activeElement, { key: "ArrowDown" });
    const enter = harness.root.emit("keydown", globalThis.document.activeElement, { key: "Enter" });
    assert.equal(enter.defaultPrevented, true);
    assert.equal(harness.keyword.value, "new_2");
    assert.equal(harness.suggestions.hidden, true);
    assert.equal(globalThis.document.activeElement, harness.keyword);

    harness.view.setSuggestions(sanitizeAutocompleteResponse({ items: [{ value: "escape", label: "Escape", category: "artist" }] }));
    harness.root.emit("keydown", harness.keyword, { key: "Escape" });
    assert.equal(harness.suggestions.hidden, true);
    assert.equal(globalThis.document.activeElement, harness.keyword);

    const form = new TestForm();
    form.dataset.crawlForm = "search";
    const option = new TestButton();
    option.dataset.crawlAction = "suggestion";
    option.dataset.suggestionValue = "chosen";
    harness.view.setSuggestions(sanitizeAutocompleteResponse({ items: [{ value: "chosen", label: "Chosen", category: "artist" }] }));
    harness.root.emit("click", harness.suggestionButtons[0]);
    assert.equal(harness.keyword.value, "chosen");
    assert.equal(harness.calls.filter((item) => item[0] === "post").length, 0);

    harness.keyword.value = "deactivate";
    harness.root.emit("input", harness.keyword);
    harness.controller.deactivate();
    await new Promise((resolve) => setTimeout(resolve, AUTOCOMPLETE_DELAY_MS + 30));
    assert.equal(requests.length, 2);
    assert.equal(harness.suggestions.hidden, true);
    assert.equal(harness.outputDir.value, "");
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("3A controller：loading/error/recovery 保留权威 Store，busy 阻止重复搜索", async () => {
  const restore = installControllerDom();
  try {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const harness = controllerHarness({
      initialSearch: completeSearchResponse(),
      apiOverrides: {
        post(url) {
          if (url !== CRAWL_ENDPOINTS.search) throw new Error("unexpected endpoint");
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
      },
    });
    const before = harness.store.getState().crawl;
    harness.controller.activate();
    const searchForm = new TestForm();
    searchForm.dataset.crawlForm = "search";
    harness.root.emit("submit", searchForm);
    harness.root.emit("submit", searchForm);
    await flush();
    assert.equal(call, 1);
    assert.equal(harness.viewLog.some((item) => item[0] === "search-state" && item[1] === "loading"), true);
    first.reject(Object.assign(new Error(`https://private/${SECRET}`), { status: 502, code: "proxy_failed" }));
    await flush();
    assert.equal(harness.store.getState().crawl, before);
    assert.equal(harness.viewLog.some((item) => item[0] === "search-state" && item[1] === "error"), true);

    harness.root.emit("submit", searchForm);
    await flush();
    second.resolve({ sources: SITE_IDS.map((site) => sourceResult(site, site === "pixiv" ? [candidate(site, "7")] : [])) });
    await flush();
    assert.equal(harness.store.getState().crawl.sources[2].addresses.length, 1);
    assert.equal(harness.viewLog.some((item) => item[0] === "search-state" && item[1] === "recovery"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("3A controller：原生 invalid 与实时草稿验证在 0 请求前更新 UI", async () => {
  const restore = installControllerDom();
  try {
    const harness = controllerHarness({ initialSearch: completeSearchResponse() });
    const searchForm = new TestForm();
    searchForm.dataset.crawlForm = "search";
    const invalidInput = new TestInput();
    invalidInput.name = "search-limit";
    harness.view.searchValidation = {
      valid: false,
      reason: "结果上限需为 1–200 的整数",
      field: "search-limit",
    };
    harness.controller.activate();
    harness.root.emit("input", invalidInput);
    harness.root.emit("change", invalidInput);
    harness.root.emit("invalid", invalidInput, { preventDefault() { this.defaultPrevented = true; } });
    harness.root.emit("submit", searchForm);
    await flush();
    assert.equal(harness.calls.filter((item) => item[0] === "post").length, 0);
    assert.equal(harness.viewLog.some((item) => item[0] === "validation"), true);
    assert.equal(harness.viewLog.some((item) => item[0] === "invalid"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("3A controller：关闭重开无 operational URL 时禁用，fresh search 后恢复", async () => {
  const restore = installControllerDom();
  try {
    const search = completeSearchResponse();
    const first = controllerHarness({ initialSearch: search });
    const key = first.store.getState().crawl.sources[0].addresses[0].key;
    first.store.dispatch(actionCreators.crawlCandidateSelectionChanged(key, true));
    first.controller.activate();
    assert.deepEqual(first.viewLog.filter((item) => item[0] === "operational").at(-1), ["operational", true]);
    first.controller.destroy();

    const refreshed = deferred();
    const reopened = controllerHarness({
      apiOverrides: {
        post(url) {
          assert.equal(url, CRAWL_ENDPOINTS.search);
          return refreshed.promise;
        },
      },
    });
    reopened.store.dispatch(actionCreators.crawlSearchReceived(search));
    reopened.store.dispatch(actionCreators.crawlCandidateSelectionChanged(key, true));
    reopened.controller.activate();
    assert.deepEqual(reopened.viewLog.filter((item) => item[0] === "operational").at(-1), ["operational", false]);
    const createForm = new TestForm();
    createForm.dataset.crawlForm = "submit";
    reopened.root.emit("submit", createForm);
    await flush();
    assert.equal(reopened.calls.filter((item) => item[0] === "post").length, 0);
    assert.equal(reopened.viewLog.some((item) => item[0] === "error"), false);

    const searchForm = new TestForm();
    searchForm.dataset.crawlForm = "search";
    reopened.root.emit("submit", searchForm);
    await flush();
    refreshed.resolve(search);
    await flush();
    assert.deepEqual(reopened.viewLog.filter((item) => item[0] === "operational").at(-1), ["operational", true]);
    reopened.controller.destroy();
  } finally {
    restore();
  }
});

test("3A controller：清空当前来源包含筛选外候选", () => {
  const restore = installControllerDom();
  try {
    const harness = controllerHarness({ initialSearch: completeSearchResponse() });
    const source = harness.store.getState().crawl.sources[3];
    const selected = source.addresses[0];
    harness.store.dispatch(actionCreators.crawlCandidateSelectionChanged(selected.key, true));
    harness.view.sourceCandidateKeys = () => source.addresses.map((item) => item.key);
    harness.controller.activate();
    const sourceHost = new TestElement("section");
    sourceHost.dataset.sourceKey = source.key;
    const clear = new TestButton();
    clear.dataset.crawlAction = "clear-source-selection";
    sourceHost.append(clear);
    harness.root.append(sourceHost);
    harness.root.emit("click", clear);
    assert.equal(harness.store.getState().crawl.sources[3].addresses[0].selected, false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("3A controller：create 幂等、单次 active batch/导航、失败保留选择且清敏感引用", async () => {
  const restore = installControllerDom();
  try {
    const search = completeSearchResponse();
    const created = deferred();
    const harness = controllerHarness({
      initialSearch: search,
      apiOverrides: { post: (_url, _payload, _options) => created.promise },
    });
    const key = harness.store.getState().crawl.sources[0].addresses[0].key;
    harness.store.dispatch(actionCreators.crawlCandidateSelectionChanged(key, true));
    harness.controller.activate();
    const form = new TestForm();
    form.dataset.crawlForm = "submit";
    harness.root.emit("submit", form);
    harness.root.emit("submit", form);
    await flush();
    const posts = harness.calls.filter((item) => item[0] === "post");
    assert.equal(posts.length, 1);
    assert.equal(posts[0][1], CRAWL_ENDPOINTS.crawls);
    assert.equal(posts[0][3].idempotencyKey, true);
    assert.equal(posts[0][2].sources[0].addresses[0].url.includes("danbooru.donmai.us"), true);
    assert.equal(harness.outputDir.value, "");

    created.resolve({
      id: "batch-stage3",
      status: "pending",
      concurrency: 20,
      max_tasks: 1000,
      task_count: 0,
      succeeded_task_count: 0,
      failed_task_count: 0,
      cancelled_task_count: 0,
      sources: [],
    });
    await flush();
    assert.deepEqual(harness.actionsLog, [["active", "batch-stage3"], ["navigate", "tasks"]]);
    assert.equal(harness.store.getState().batches.active.id, "batch-stage3");
    harness.controller.destroy();

    const failed = deferred();
    const retry = deferred();
    let attempt = 0;
    const failureHarness = controllerHarness({
      initialSearch: search,
      apiOverrides: { post: () => (++attempt === 1 ? failed.promise : retry.promise) },
    });
    const failedKey = failureHarness.store.getState().crawl.sources[0].addresses[0].key;
    failureHarness.store.dispatch(actionCreators.crawlCandidateSelectionChanged(failedKey, true));
    failureHarness.controller.activate();
    const failedForm = new TestForm();
    failedForm.dataset.crawlForm = "submit";
    failureHarness.root.emit("submit", failedForm);
    await flush();
    failed.reject(Object.assign(new Error(SECRET), { status: 409, code: "crawl_conflict" }));
    await flush();
    assert.equal(failureHarness.store.getState().crawl.sources[0].addresses[0].selected, true);
    assert.deepEqual(failureHarness.actionsLog, []);
    assert.equal(failureHarness.viewLog.some((item) => item[0] === "error"), true);
    failureHarness.root.emit("submit", failedForm);
    await flush();
    failureHarness.controller.deactivate();
    retry.resolve({ id: "stale-batch", status: "pending", sources: [] });
    await flush();
    assert.deepEqual(failureHarness.actionsLog, []);
    assert.equal(failureHarness.outputDir.value, "");
    failureHarness.controller.destroy();
  } finally {
    restore();
  }
});

test("3A view：三段语义工作区、来源 override、权威摘要和局部 active source", () => {
  assert.equal(typeof createCrawlView, "function");
  const selects = new Map([
    ["source-danbooru", { value: "" }],
    ["source-twitter", { value: "prefer" }],
    ["source-pixiv", { value: "direct" }],
    ["source-exhentai", { value: "required" }],
    ["source-pawchive", { value: "" }],
  ]);
  assert.deepEqual(readCrawlSourceOptions({
    sitePicker: { querySelector: (selector) => selects.get(selector.match(/name=\"([^\"]+)/)?.[1]) || null },
  }), {
    twitter: { proxy_mode: "prefer" },
    pixiv: { proxy_mode: "direct" },
    exhentai: { proxy_mode: "required" },
  });
  for (const contract of [
    /<aside|createElement\("aside"/,
    /createElement\("main"/,
    /createElement\("section"/,
    /createElement\("fieldset"/,
    /data.*crawl.*workspace|crawl-workspace/,
    /当前来源|activeSource/,
    /执行顺序/,
    /创建批次/,
    /上移来源/,
    /下移来源/,
    /上移地址/,
    /下移地址/,
    /role.*combobox|"combobox"/,
    /aria-expanded/,
    /aria-controls/,
    /aria-label/,
    /title/,
  ]) assert.match(CRAWL_VIEW_SOURCE, contract);
  assert.doesNotMatch(CRAWL_VIEW_SOURCE, /innerHTML/);
  assert.doesNotMatch(CRAWL_VIEW_SOURCE, />↑<|>↓<|text:\s*"[↑↓]"/);
  assert.doesNotMatch(CRAWL_VIEW_SOURCE, /GALLERY|SCHEDULE|EXPORT|TASKMGR|VAULT\.CPL/);
});

test("3A view：来源和候选重绘按稳定 token 恢复焦点", () => {
  const restore = installControllerDom();
  try {
    assert.equal(typeof crawlViewModule.captureCrawlFocusToken, "function");
    assert.equal(typeof crawlViewModule.restoreCrawlFocus, "function");

    const root = new TestElement("main");
    const oldSource = new TestElement("section");
    oldSource.dataset.sourceKey = "source:pawchive:4";
    const oldMove = new TestButton();
    oldMove.dataset.crawlAction = "source-up";
    oldSource.append(oldMove);
    root.append(oldSource);
    oldMove.focus();

    const token = crawlViewModule.captureCrawlFocusToken(root);
    const newSource = new TestElement("section");
    newSource.dataset.sourceKey = "source:pawchive:4";
    const newActivate = new TestButton();
    newActivate.dataset.crawlAction = "source-activate";
    const newMove = new TestButton();
    newMove.dataset.crawlAction = "source-up";
    newSource.append(newActivate, newMove);
    root.replaceChildren(newSource);

    assert.equal(crawlViewModule.restoreCrawlFocus(root, token, newActivate), true);
    assert.equal(globalThis.document.activeElement, newMove);

    newMove.disabled = true;
    globalThis.document.activeElement = oldMove;
    assert.equal(crawlViewModule.restoreCrawlFocus(root, token, newActivate), true);
    assert.equal(globalThis.document.activeElement, newActivate);

    const oldTag = new TestButton();
    oldTag.dataset.crawlAction = "eh-cycle";
    oldTag.dataset.tagKey = "artist:stage3";
    root.replaceChildren(oldTag);
    oldTag.focus();
    const tagToken = crawlViewModule.captureCrawlFocusToken(root);
    const newTag = new TestButton();
    newTag.dataset.crawlAction = "eh-cycle";
    newTag.dataset.tagKey = "artist:stage3";
    root.replaceChildren(newTag);
    assert.equal(crawlViewModule.restoreCrawlFocus(root, tagToken, null), true);
    assert.equal(globalThis.document.activeElement, newTag);
  } finally {
    restore();
  }
});

test("3A CSS：普通窗口由真实工作区拥有横向滚动，最大化仍保持三栏", () => {
  assert.match(CRAWL_VIEW_SOURCE, /crawl-workspace-track/);
  assert.match(CRAWL_CSS_SOURCE, /grid-template-columns\s*:[^;]*(?:260|280|300|clamp|minmax)[^;]*;/);
  assert.match(CRAWL_CSS_SOURCE, /\.crawl-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(CRAWL_CSS_SOURCE, /\.crawl-workspace-track\s*\{[^}]*min-width\s*:\s*1020px/s);
  assert.doesNotMatch(
    CRAWL_CSS_SOURCE,
    /\.application-window:not\(\[data-maximized\]\)\s+\.crawl-app\s*\{[^}]*width\s*:\s*max/s,
  );
  assert.match(CRAWL_CSS_SOURCE, /--imageweave-surface-content(?:-solid)?/);
  assert.match(CRAWL_CSS_SOURCE, /forced-colors/);
  assert.match(CRAWL_CSS_SOURCE, /prefers-reduced-motion|data-motion/);
  assert.doesNotMatch(CRAWL_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(CRAWL_CSS_SOURCE, /backdrop-filter/);
});

test("3A static boundary：唯一三个 endpoint、无旁路 I/O/fixture/console 且四生命周期不变", () => {
  assert.deepEqual(CRAWL_ENDPOINTS, {
    search: "/api/v1/search",
    autocomplete: "/api/v1/search/autocomplete",
    crawls: "/api/v1/crawls",
  });
  for (const endpoint of Object.values(CRAWL_ENDPOINTS)) {
    assert.equal(CRAWL_APP_SOURCE.split(`"${endpoint}"`).length - 1, 1, endpoint);
  }
  assert.equal((CRAWL_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 3);
  for (const forbidden of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /tests\/fixtures|fixtures\/webui/,
    /innerHTML/,
  ]) {
    assert.doesNotMatch(CRAWL_APP_SOURCE, forbidden);
    assert.doesNotMatch(CRAWL_VIEW_SOURCE, forbidden);
  }
  assert.match(CRAWL_APP_SOURCE, /new Map\(\)/);
  assert.match(CRAWL_APP_SOURCE, /idempotencyKey:\s*true/);
  assert.match(CRAWL_APP_SOURCE, /\.abort\(\)/);
  assert.match(CRAWL_APP_SOURCE, /sequence|Sequence/);
  assert.match(CRAWL_APP_SOURCE, /lifecycle/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof crawlApplication[hook], "function");
  }
  assert.equal(typeof createCrawlController, "function");
  assert.equal(REPO_ROOT.protocol, "file:");
});
