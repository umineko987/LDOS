import { createElement } from "../core/dom.js";
import {
  CRAWL_SITE_DEFINITIONS,
  crawlCandidateVisible,
  deriveCrawlPreconditions,
  deriveCrawlSearchPresentation,
  deriveCrawlSubmitPresentation,
  validateCrawlDraft,
  validateSearchDraft,
} from "../core/crawl-model.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge } from "./status.js";

const CATEGORY_LABELS = Object.freeze({
  artist: "画师", character: "角色", copyright: "作品", general: "标签", meta: "META",
});
const CONFIDENCE_LABELS = Object.freeze({
  verified: "已核实", site_search: "站内结果", weak: "待核实",
});
const TAG_MODE_LABELS = Object.freeze({ include: "包含", exclude: "排除", none: "未筛选" });
const SEARCH_STATE_COPY = Object.freeze({
  initial: ["等待搜索", "输入关键词，确认左栏来源与连接方式后开始搜索。", "disabled"],
  loading: ["正在搜索", "正在查询已启用来源；上次结果仍可查看，但搜索完成前不能创建批次。", "running"],
  empty: ["没有结果", "已完成搜索，但当前来源没有候选地址。可调整关键词、授权或代理后重试。", "disabled"],
  content: ["搜索完成", "候选已按来源返回，可在当前来源中选择并调整地址顺序。", "ready"],
  partial: ["部分结果", "部分来源未完整返回；可继续使用已有候选，或修复来源后重试。", "warning"],
  error: ["搜索失败", "上次结果、选择与顺序已保留。请按错误指引修复后重试。", "error"],
  recovery: ["已恢复", "搜索已恢复并更新为最新权威结果。", "ready"],
});

function button(action, label, {
  primary = false,
  small = false,
  title = label,
  ariaLabel = label,
} = {}) {
  return createElement("button", {
    className: [
      "crawl-button",
      primary ? "crawl-button--primary" : "",
      small ? "crawl-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button", title, "aria-label": ariaLabel },
    dataset: { crawlAction: action },
  });
}

export function createSourceErrorWarning(source) {
  if (!source?.errorCode) return null;
  const text = source.errorMessage
    ? `来源搜索失败（${source.errorCode}）：${source.errorMessage}。请检查授权或代理后重试。`
    : `来源搜索失败（${source.errorCode}）。请检查授权或代理后重试。`;
  return createElement("p", { className: "crawl-source-warning", text });
}

function field(label, control, help = "", className = "") {
  return createElement("label", {
    className: ["crawl-field", className].filter(Boolean).join(" "),
  }, [
    createElement("span", { text: label }),
    control,
    ...(help ? [createElement("small", { text: help })] : []),
  ]);
}

function selectProxyMode(name, value = "required", { inherit = false, label = "连接方式" } = {}) {
  const select = createElement("select", { attributes: { name, "aria-label": label } });
  if (inherit) select.append(createElement("option", { text: "使用全局设置", attributes: { value: "" } }));
  for (const [mode, text] of [
    ["required", "仅使用代理"],
    ["prefer", "优先代理，不可用时直连"],
    ["direct", "不使用代理"],
  ]) {
    const option = createElement("option", { text, attributes: { value: mode } });
    option.selected = mode === value;
    select.append(option);
  }
  return select;
}

export function readCrawlSourceOptions(elements) {
  const result = {};
  for (const site of CRAWL_SITE_DEFINITIONS) {
    const select = elements.sitePicker.querySelector(`[name="source-${site.id}"]`);
    if (select?.value) result[site.id] = { proxy_mode: select.value };
  }
  return result;
}

function selectedSites(elements) {
  return [...elements.sitePicker.querySelectorAll('input[name="crawl-site"]:checked')]
    .map((input) => input.value);
}

function crawlControlToken(target) {
  if (target.dataset.crawlWeakToggle !== undefined) return "weak-toggle";
  if (target.dataset.crawlEhQuery !== undefined) return "eh-query";
  return target.getAttribute("name") || target.id || "";
}

export function captureCrawlFocusToken(root) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !root.contains(target)) return null;
  const token = {
    action: target.dataset.crawlAction || "",
    candidate: target.closest("[data-candidate-key]")?.dataset.candidateKey || "",
    source: target.closest("[data-source-key]")?.dataset.sourceKey || "",
    tag: target.dataset.tagKey || "",
    control: crawlControlToken(target),
  };
  return Object.values(token).some(Boolean) ? Object.freeze(token) : null;
}

export function restoreCrawlFocus(root, token, fallback = null) {
  if (!token) return false;
  const controls = [...root.querySelectorAll("button, input, select, textarea, [tabindex]")];
  const exact = controls.find((element) =>
    !element.disabled
    && (!token.action || element.dataset.crawlAction === token.action)
    && (!token.candidate || element.closest("[data-candidate-key]")?.dataset.candidateKey === token.candidate)
    && (!token.source || element.closest("[data-source-key]")?.dataset.sourceKey === token.source)
    && (!token.tag || element.dataset.tagKey === token.tag)
    && (!token.control || crawlControlToken(element) === token.control));
  const candidateFallback = token.candidate
    ? controls.find((element) => !element.disabled
      && element.closest("[data-candidate-key]")?.dataset.candidateKey === token.candidate)
    : null;
  const sourceFallback = token.source
    ? controls.find((element) => !element.disabled
      && element.closest("[data-source-key]")?.dataset.sourceKey === token.source)
    : null;
  const controlFallback = token.control
    ? controls.find((element) => !element.disabled && crawlControlToken(element) === token.control)
    : null;
  const target = exact || candidateFallback || sourceFallback || controlFallback || (fallback?.disabled ? null : fallback);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "crawl-heading";
  const keyword = createElement("input", {
    attributes: {
      type: "search",
      name: "keyword",
      maxlength: "1000",
      autocomplete: "off",
      placeholder: "画师、角色或作品关键词",
      required: "",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": "crawl-suggestions",
    },
    dataset: { crawlInput: "keyword" },
  });
  const suggestions = createElement("div", {
    className: "crawl-suggestions",
    attributes: { id: "crawl-suggestions", role: "listbox", hidden: "" },
  });
  const keywordField = field(
    "关键词",
    keyword,
    "输入至少 2 个字符可查看 Danbooru 建议；方向键浏览，Enter 选用。",
    "crawl-field--keyword",
  );
  keywordField.append(suggestions);

  const searchLimit = createElement("input", {
    attributes: { type: "number", name: "search-limit", min: "1", max: "200", value: "20" },
  });
  const searchProxy = selectProxyMode("search-proxy", "required", { label: "搜索全局代理" });
  const searchButton = createElement("button", {
    className: "crawl-button crawl-button--primary",
    text: "搜索来源",
    attributes: { type: "submit", title: "搜索已启用来源" },
    dataset: { operationKind: "search" },
  });
  const searchForm = createElement("form", {
    className: "crawl-search-form",
    dataset: { crawlForm: "search" },
  }, [
    keywordField,
    createElement("div", { className: "crawl-search-controls" }, [
      field("结果上限", searchLimit),
      createElement("div", { className: "crawl-form-actions" }, [searchButton]),
    ]),
  ]);

  const sitePicker = createElement("fieldset", { className: "crawl-site-picker" }, [
    createElement("legend", { text: "来源启用状态" }),
  ]);
  const sourceOverrides = createElement("div", { className: "crawl-source-overrides" });
  for (const site of CRAWL_SITE_DEFINITIONS) {
    const toggleId = `crawl-site-${site.id}`;
    const overrideId = `crawl-source-${site.id}`;
    const input = createElement("input", {
      attributes: {
        id: toggleId,
        type: "checkbox",
        name: "crawl-site",
        value: site.id,
        checked: "",
        "aria-label": `启用 ${site.label} 搜索来源`,
      },
    });
    input.checked = true;
    const override = selectProxyMode(`source-${site.id}`, "", {
      inherit: true,
      label: `${site.label} 搜索代理覆盖`,
    });
    override.id = overrideId;
    const sourceToggle = createElement("div", { className: "crawl-source-definition" }, [
      createElement("div", { className: "crawl-source-definition__toggle" }, [
        input,
        createElement("label", { text: site.label, attributes: { for: toggleId } }),
      ]),
      createElement("label", {
        className: "crawl-source-definition__proxy-label",
        text: `${site.label} 代理覆盖`,
        attributes: { for: overrideId },
      }),
      override,
    ]);
    sitePicker.append(sourceToggle);
    sourceOverrides.append(createElement("span", {
      className: "crawl-source-override-marker",
      dataset: { sourceOverride: site.id },
    }));
  }
  const searchSettings = createElement("fieldset", { className: "crawl-global-settings" }, [
    createElement("legend", { text: "全局搜索连接" }),
    field("全局代理", searchProxy, "每个来源可在上方单独覆盖。"),
  ]);

  const leftSourceHost = createElement("nav", {
    className: "crawl-source-nav",
    attributes: { "aria-label": "采集来源顺序与当前来源" },
    dataset: { crawlSourceNav: "" },
  });
  const ehTagQuery = createElement("input", {
    attributes: {
      type: "search",
      placeholder: "检索 EH 标签",
      autocomplete: "off",
      "aria-label": "检索 EH 标签",
    },
    dataset: { crawlEhQuery: "" },
  });
  const ehFilterHost = createElement("section", {
    className: "crawl-eh-filter",
    attributes: { hidden: "", "aria-labelledby": "crawl-eh-title" },
    dataset: { crawlEhFilter: "" },
  }, [
    createElement("div", { className: "crawl-section-heading" }, [
      createElement("div", {}, [
        createElement("h3", { text: "EH 标签", attributes: { id: "crawl-eh-title" } }),
        createElement("p", { text: "同分类为任一匹配，跨分类需同时匹配；排除优先。" }),
      ]),
    ]),
    field("标签检索", ehTagQuery),
    createElement("p", { className: "crawl-eh-summary", dataset: { crawlEhSummary: "" } }),
    createElement("div", { className: "crawl-eh-groups", dataset: { crawlEhGroups: "" } }),
    button("eh-clear", "清空标签筛选", { small: true }),
  ]);

  const preconditions = createElement("div", {
    className: "crawl-preconditions",
    attributes: { "aria-live": "polite" },
    dataset: { crawlPreconditions: "" },
  });
  const sourceColumn = createElement("aside", {
    className: "crawl-column crawl-column--sources",
    attributes: { "aria-labelledby": "crawl-sources-heading" },
  }, [
    createElement("header", { className: "crawl-column-header" }, [
      createElement("p", { className: "crawl-column-kicker", text: "01 · 来源" }),
      createElement("h2", { text: "来源与连接", attributes: { id: "crawl-sources-heading" } }),
      createElement("p", { text: "启用五个权威来源，选择当前来源并调整执行顺序。" }),
    ]),
    createElement("div", { className: "crawl-column-scroll" }, [
      sitePicker,
      searchSettings,
      leftSourceHost,
      preconditions,
      ehFilterHost,
    ]),
  ]);

  const weakToggle = createElement("input", {
    attributes: { type: "checkbox" },
    dataset: { crawlWeakToggle: "" },
  });
  const sourceHost = createElement("div", { className: "crawl-address-list", dataset: { crawlSources: "" } });
  const profileHost = createElement("div", { className: "crawl-profiles", dataset: { crawlProfiles: "" } });
  const resultSummary = createElement("p", { dataset: { crawlResultSummary: "" } });
  const currentSourceTitle = createElement("h3", { text: "尚未选择来源", dataset: { crawlCurrentSourceTitle: "" } });
  const searchState = createElement("section", {
    className: "crawl-search-state",
    attributes: { role: "status", "aria-live": "polite" },
    dataset: { crawlSearchState: "initial" },
  }, [
    createStatusBadge("disabled", "等待搜索", { compact: true }),
    createElement("p", { text: SEARCH_STATE_COPY.initial[1], dataset: { crawlSearchStateMessage: "" } }),
  ]);
  const resultHost = createElement("section", {
    className: "crawl-results",
    attributes: { "aria-labelledby": "crawl-current-source-title" },
    dataset: { crawlResults: "" },
  }, [
    createElement("div", { className: "crawl-section-heading" }, [
      createElement("div", {}, [
        currentSourceTitle,
        resultSummary,
      ]),
      createElement("div", { className: "crawl-toolbar" }, [
        createElement("label", { className: "crawl-toggle" }, [
          weakToggle,
          createElement("span", { text: "显示待核实候选" }),
        ]),
        button("select-visible", "全选当前显示", { small: true }),
        button("clear-source-selection", "清空当前来源", { small: true }),
      ]),
    ]),
    sourceHost,
    profileHost,
  ]);
  const discoveryColumn = createElement("main", {
    className: "crawl-column crawl-column--discovery",
    attributes: { "aria-labelledby": "crawl-discovery-heading" },
  }, [
    createElement("header", { className: "crawl-column-header" }, [
      createElement("p", { className: "crawl-column-kicker", text: "02 · 候选" }),
      createElement("h2", { text: "搜索与候选地址", attributes: { id: "crawl-discovery-heading" } }),
    ]),
    createElement("div", { className: "crawl-column-scroll" }, [
      searchForm,
      searchState,
      resultHost,
    ]),
  ]);

  const concurrency = createElement("input", {
    attributes: { type: "number", min: "1", max: "128", value: "20", name: "concurrency" },
  });
  const maxTasks = createElement("input", {
    attributes: { type: "number", min: "1", max: "100000", value: "10000", name: "max-tasks" },
  });
  const crawlProxy = selectProxyMode("crawl-proxy", "required", { label: "下载全局代理" });
  const outputDir = createElement("input", {
    attributes: {
      type: "text",
      maxlength: "2048",
      name: "output-dir",
      autocomplete: "off",
      placeholder: "可选：系统允许的输出目录",
    },
  });
  const imageOriginal = createElement("input", {
    attributes: { type: "radio", name: "eh-image-mode", value: "original", checked: "" },
  });
  imageOriginal.checked = true;
  const imageResample = createElement("input", {
    attributes: { type: "radio", name: "eh-image-mode", value: "resample" },
  });
  const gpPolicy = createElement("select", {
    attributes: { name: "eh-gp-policy", "aria-label": "EH 原图不可用时的处理" },
  }, [
    createElement("option", { text: "停止该地址", attributes: { value: "stop" } }),
    createElement("option", { text: "降级到 1280 查看图", attributes: { value: "resized" } }),
  ]);
  const ehOptions = createElement("fieldset", {
    className: "crawl-eh-download",
    attributes: { hidden: "" },
    dataset: { crawlEhDownload: "" },
  }, [
    createElement("legend", { text: "EH 下载选项" }),
    createElement("div", { className: "crawl-segmented" }, [
      createElement("label", {}, [imageOriginal, createElement("span", { text: "原图" })]),
      createElement("label", {}, [imageResample, createElement("span", { text: "1280 查看图" })]),
    ]),
    field("原图 GP 不足时", gpPolicy, "1280 查看图固定停止策略；原图可选择停止或降级。"),
  ]);

  const selectionSummary = createElement("div", {
    className: "crawl-selection-summary",
    dataset: { crawlSelectionSummary: "" },
  });
  const executionPreview = createElement("ol", {
    className: "crawl-execution-preview",
    attributes: { "aria-label": "来源和候选地址执行顺序" },
    dataset: { crawlExecutionPreview: "" },
  });
  const submitBadge = createStatusBadge("disabled", "尚未选择地址");
  const submitReason = createElement("p", {
    className: "crawl-submit-reason",
    text: "请先选择至少一个候选地址。",
    attributes: { role: "status", "aria-live": "polite" },
    dataset: { crawlSubmitReason: "" },
  });
  const startButton = createElement("button", {
    className: "crawl-button crawl-button--primary",
    text: "创建批次",
    attributes: {
      type: "submit",
      disabled: "",
      title: "请先选择至少一个候选地址",
      "aria-describedby": "crawl-submit-reason",
    },
    dataset: { operationKind: "crawl" },
  });
  submitReason.setAttribute("id", "crawl-submit-reason");
  const submitForm = createElement("form", {
    className: "crawl-submit-form",
    dataset: { crawlForm: "submit", crawlSubmitPanel: "" },
  }, [
    createElement("section", { className: "crawl-summary-section", attributes: { "aria-labelledby": "crawl-summary-title" } }, [
      createElement("div", { className: "crawl-section-heading" }, [
        createElement("h3", { text: "当前选择", attributes: { id: "crawl-summary-title" } }),
        submitBadge,
      ]),
      selectionSummary,
    ]),
    createElement("section", { className: "crawl-summary-section", attributes: { "aria-labelledby": "crawl-order-title" } }, [
      createElement("h3", { text: "执行顺序", attributes: { id: "crawl-order-title" } }),
      executionPreview,
    ]),
    createElement("fieldset", { className: "crawl-run-settings" }, [
      createElement("legend", { text: "批次设置" }),
      field("单地址并发", concurrency),
      field("最多任务数", maxTasks),
      field("下载代理", crawlProxy),
      field("输出目录（可选）", outputDir, "留空使用默认下载目录；离开应用即清空此输入。"),
    ]),
    ehOptions,
    createElement("footer", { className: "crawl-create-footer" }, [
      submitReason,
      startButton,
    ]),
  ]);
  const submitColumn = createElement("aside", {
    className: "crawl-column crawl-column--submit",
    attributes: { "aria-labelledby": "crawl-submit-heading" },
  }, [
    createElement("header", { className: "crawl-column-header" }, [
      createElement("p", { className: "crawl-column-kicker", text: "03 · 执行" }),
      createElement("h2", { text: "摘要与创建批次", attributes: { id: "crawl-submit-heading" } }),
    ]),
    createElement("div", { className: "crawl-column-scroll crawl-column-scroll--submit" }, [submitForm]),
  ]);

  const searchValidation = createElement("p", {
    className: "crawl-validation-message",
    attributes: { id: "crawl-search-validation", role: "status", "aria-live": "polite", hidden: "" },
    dataset: { crawlSearchValidation: "" },
  });
  searchForm.append(searchValidation);
  keyword.setAttribute("aria-describedby", "crawl-search-validation");
  searchLimit.setAttribute("aria-describedby", "crawl-search-validation");
  searchProxy.setAttribute("aria-describedby", "crawl-search-validation");

  const errorHost = createElement("div", { className: "crawl-error-host", dataset: { crawlError: "" } });
  const operationLive = createElement("p", {
    className: "crawl-operation-live",
    text: "输入关键词并选择来源。",
    attributes: { "aria-live": "polite" },
    dataset: { crawlLive: "" },
  });
  const workspaceTrack = createElement("div", {
    className: "crawl-workspace-track",
  }, [sourceColumn, discoveryColumn, submitColumn]);
  const workspace = createElement("section", {
    className: "crawl-workspace",
    attributes: {
      "aria-label": "图片采集三段工作区，可横向滚动查看全部三栏",
      tabindex: "0",
    },
    dataset: { crawlWorkspace: "" },
  }, [workspaceTrack]);

  root.classList.add("app-view", "crawl-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header crawl-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      createElement("div", { className: "crawl-app-status" }, [
        createStatusBadge("ready", "真实 API 工作区"),
        operationLive,
      ]),
    ]),
    errorHost,
    workspace,
  );

  return {
    keyword,
    suggestions,
    searchLimit,
    searchProxy,
    sitePicker,
    sourceOverrides,
    searchButton,
    leftSourceHost,
    weakToggle,
    sourceHost,
    ehTagQuery,
    ehFilterHost,
    ehSummary: ehFilterHost.querySelector("[data-crawl-eh-summary]"),
    ehGroups: ehFilterHost.querySelector("[data-crawl-eh-groups]"),
    profileHost,
    resultHost,
    resultSummary,
    currentSourceTitle,
    searchState,
    searchStateBadge: searchState.querySelector(".status-badge"),
    searchStateMessage: searchState.querySelector("[data-crawl-search-state-message]"),
    concurrency,
    maxTasks,
    crawlProxy,
    outputDir,
    imageOriginal,
    imageResample,
    gpPolicy,
    ehOptions,
    submitForm,
    searchValidation,
    submitBadge,
    submitReason,
    selectionSummary,
    executionPreview,
    startButton,
    preconditions,
    errorHost,
    operationLive,
    workspace,
    workspaceTrack,
  };
}

export function createCrawlView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let renderedError = null;
  let ehQuery = "";
  let activeSourceKey = "";
  let searchPhase = store.getState().crawl.sources.length ? "settled" : "initial";
  let operationalAvailable = store.getState().crawl.sources.length === 0;
  let crawlValidation = validateCrawlDraft({
    concurrency: Number(elements.concurrency.value),
    maxTasks: Number(elements.maxTasks.value),
    proxyMode: elements.crawlProxy.value,
    outputDir: elements.outputDir.value,
    outputDirInvalid: Boolean(elements.outputDir.dataset.crawlControlInvalid),
    sourceOptions: readCrawlSourceOptions(elements),
    ehDownload: { image_mode: "original", gp_policy: "stop" },
  });

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (guidance) => {
    clearError();
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
      actionLabel: guidance.targetApp === "vault"
        ? "打开授权管理"
        : guidance.targetApp === "proxy"
          ? "打开代理管理"
          : "打开系统诊断",
      onAction: () => actions.navigateToApp(guidance.targetApp),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const normalizeActiveSource = (snapshot = store.getState().crawl) => {
    if (!snapshot.sources.some((source) => source.key === activeSourceKey)) {
      activeSourceKey = snapshot.sources[0]?.key || "";
    }
    return activeSourceKey;
  };

  const activeSource = (snapshot) => {
    const key = normalizeActiveSource(snapshot);
    return snapshot.sources.find((source) => source.key === key) || null;
  };

  const visibleKeysForSource = (snapshot, source) => source
    ? source.addresses
      .filter((candidate) => crawlCandidateVisible(snapshot, source, candidate))
      .map((candidate) => candidate.key)
    : [];

  const sourceDrafts = () => CRAWL_SITE_DEFINITIONS.map((site) => ({
    site: site.id,
    enabled: Boolean(elements.sitePicker.querySelector(`input[name="crawl-site"][value="${site.id}"]`)?.checked),
    proxyMode: elements.sitePicker.querySelector(`[name="source-${site.id}"]`)?.value || "",
  }));

  const renderPreconditions = () => {
    const state = store.getState();
    const notices = [];
    const presentation = deriveCrawlPreconditions({
      readinessProxy: state.system.readiness?.proxy || null,
      authBySite: state.auth?.bySite instanceof Map ? state.auth.bySite : new Map(),
      crawlSources: state.crawl.sources,
      sourceDrafts: sourceDrafts(),
      searchProxyMode: elements.searchProxy.value,
      crawlProxyMode: elements.crawlProxy.value,
    });
    if (presentation.authSites.length) {
      const labels = presentation.authSites.map((site) =>
        CRAWL_SITE_DEFINITIONS.find((item) => item.id === site)?.label || site);
      notices.push(createElement("section", { className: "crawl-precondition" }, [
        createStatusBadge("warning", `待授权：${labels.join("、")}`),
        createElement("p", { text: "启用的来源需要先完成授权。" }),
        button("open-vault", "打开授权管理", { small: true }),
      ]));
    }
    if (presentation.proxy) {
      notices.push(createElement("section", {
        className: `crawl-precondition crawl-precondition--${presentation.proxy.severity}`,
      }, [
        createStatusBadge("warning", presentation.proxy.severity === "required" ? "代理前置条件" : "代理回退提示"),
        createElement("p", { text: presentation.proxy.label }),
        button("open-proxy", "打开代理管理", { small: true }),
      ]));
    }
    elements.preconditions.replaceChildren(...notices);
  };

  const renderEhFilter = (snapshot) => {
    const source = snapshot.sources.find((item) => item.site === "exhentai");
    const facets = source?.tagFacets || [];
    const active = activeSource(snapshot);
    elements.ehFilterHost.hidden = active?.site !== "exhentai" || !facets.length;
    if (!facets.length) {
      elements.ehGroups.replaceChildren();
      return;
    }
    const total = source.addresses.filter((candidate) => !candidate.weak).length;
    const matched = source.addresses.filter((candidate) =>
      !candidate.weak && crawlCandidateVisible(snapshot, source, candidate)).length;
    const hiddenSelected = source.addresses.filter((candidate) =>
      candidate.selected && !crawlCandidateVisible(snapshot, source, candidate)).length;
    const include = [...snapshot.ehTagFilter.values()].filter((mode) => mode === "include").length;
    const exclude = snapshot.ehTagFilter.size - include;
    elements.ehSummary.textContent = snapshot.ehTagFilter.size
      ? `显示 ${matched}/${total} · 包含 ${include} · 排除 ${exclude}${hiddenSelected ? ` · 筛选外已选 ${hiddenSelected}` : ""}`
      : `显示全部 ${total} 个 EH 候选。`;
    const query = ehQuery.trim().toLowerCase();
    const groups = [];
    for (const facet of facets) {
      const tags = facet.tags.filter((tag) =>
        !query || `${facet.namespace} ${facet.label} ${tag.value}`.toLowerCase().includes(query));
      if (!tags.length) continue;
      const details = createElement("details", { className: "crawl-eh-group" });
      details.open = Boolean(query) || tags.some((tag) => snapshot.ehTagFilter.has(tag.key));
      details.append(createElement("summary", { text: `${facet.label} · ${facet.galleryCount} 画廊` }));
      const options = createElement("div", { className: "crawl-eh-options" });
      for (const tag of tags) {
        const mode = snapshot.ehTagFilter.get(tag.key) || "none";
        options.append(createElement("button", {
          className: `crawl-eh-tag crawl-eh-tag--${mode}`,
          text: `${tag.value} · ${tag.count} · ${TAG_MODE_LABELS[mode]}`,
          attributes: {
            type: "button",
            title: `${facet.label} ${tag.value}：${TAG_MODE_LABELS[mode]}`,
            "aria-label": `${facet.label} ${tag.value}，${TAG_MODE_LABELS[mode]}，按下切换筛选模式`,
          },
          dataset: { crawlAction: "eh-cycle", tagKey: tag.key, tagMode: mode },
        }));
      }
      details.append(options);
      groups.push(details);
    }
    elements.ehGroups.replaceChildren(...(groups.length ? groups : [createEmptyState({
      label: "无匹配标签",
      title: "当前标签检索无结果",
      message: "清空检索词后查看全部标签。",
    })]));
  };

  const renderProfiles = (profiles) => {
    if (!profiles.length) {
      elements.profileHost.replaceChildren();
      return;
    }
    const details = createElement("details", { className: "crawl-profile-details" }, [
      createElement("summary", { text: `Danbooru 维护的关联主页（${profiles.length}）` }),
    ]);
    const list = createElement("ul");
    for (const profile of profiles) {
      list.append(createElement("li", {}, [createElement("a", {
        text: `${profile.artist} · ${profile.platform} · ${profile.host}`,
        attributes: { href: profile.url, target: "_blank", rel: "noreferrer noopener" },
      })]));
    }
    details.append(list);
    elements.profileHost.replaceChildren(details);
  };

  const renderSourceNavigation = (snapshot) => {
    const token = captureCrawlFocusToken(root);
    normalizeActiveSource(snapshot);
    const entries = snapshot.sources.map((source, index) => {
      const selected = source.addresses.filter((candidate) => candidate.selected).length;
      const entry = createElement("section", {
        className: `crawl-source-nav-item${source.key === activeSourceKey ? " crawl-source-nav-item--active" : ""}`,
        dataset: { sourceKey: source.key, sourceSite: source.site },
      }, [
        createElement("button", {
          className: "crawl-source-nav-select",
          text: `${index + 1}. ${source.label}`,
          attributes: {
            type: "button",
            title: `查看 ${source.label} 候选`,
            "aria-label": `第 ${index + 1} 个来源，${source.label}，${selected} 个已选地址`,
            "aria-current": source.key === activeSourceKey ? "page" : null,
          },
          dataset: { crawlAction: "source-activate" },
        }),
        createElement("span", {
          className: "crawl-source-nav-meta",
          text: `${source.status === "succeeded" ? "完整" : source.status === "partial" ? "部分" : "失败"} · ${selected} 已选`,
        }),
        createElement("div", { className: "crawl-order-actions" }, [
          button("source-up", "上移来源", {
            small: true,
            title: `将 ${source.label} 上移`,
            ariaLabel: `将来源 ${source.label} 上移一位`,
          }),
          button("source-down", "下移来源", {
            small: true,
            title: `将 ${source.label} 下移`,
            ariaLabel: `将来源 ${source.label} 下移一位`,
          }),
        ]),
      ]);
      entry.querySelector('[data-crawl-action="source-up"]').disabled = index === 0;
      entry.querySelector('[data-crawl-action="source-down"]').disabled = index === snapshot.sources.length - 1;
      return entry;
    });
    elements.leftSourceHost.replaceChildren(...entries);
    queueMicrotask(() => restoreCrawlFocus(
      root,
      token,
      elements.leftSourceHost.querySelector('[aria-current="page"]'),
    ));
  };

  const renderCurrentSource = (snapshot) => {
    const token = captureCrawlFocusToken(root);
    const source = activeSource(snapshot);
    if (!source) {
      elements.currentSourceTitle.textContent = "尚无来源结果";
      elements.sourceHost.replaceChildren(createEmptyState({
        label: "初始空态",
        title: "尚未执行搜索",
        message: "在上方输入关键词并搜索，候选会显示在这里。",
      }));
      renderProfiles([]);
      return;
    }
    const visible = source.addresses.filter((candidate) => crawlCandidateVisible(snapshot, source, candidate));
    const selected = source.addresses.filter((candidate) => candidate.selected).length;
    elements.currentSourceTitle.textContent = `${source.label} 候选地址`;
    const rows = [];
    const warning = createSourceErrorWarning(source);
    if (warning) rows.push(warning);
    if (!visible.length) {
      rows.push(createEmptyState({
        label: source.addresses.some((candidate) => candidate.weak) ? "仅有待核实结果" : "无候选",
        title: "当前来源没有可显示地址",
        message: source.addresses.some((candidate) => candidate.weak)
          ? "开启“显示待核实候选”后人工确认。"
          : "调整关键词或检查授权、代理后重新搜索。",
      }));
    }
    visible.forEach((candidate, visibleIndex) => {
      const checkbox = createElement("input", {
        attributes: {
          type: "checkbox",
          checked: candidate.selected ? "" : null,
          "aria-label": `选择 ${candidate.label}`,
        },
        dataset: { crawlCandidateToggle: candidate.key },
      });
      checkbox.checked = candidate.selected;
      const label = createElement("label", { className: "crawl-address-main" }, [checkbox]);
      if (candidate.thumbnailUrl) {
        label.append(createElement("img", {
          className: "crawl-address-thumbnail",
          attributes: {
            src: candidate.thumbnailUrl,
            alt: `${candidate.label} 封面`,
            loading: "lazy",
            decoding: "async",
            referrerpolicy: "no-referrer",
          },
        }));
      }
      label.append(createElement("div", { className: "crawl-address-copy" }, [
        createElement("strong", { text: candidate.label }),
        createElement("span", { text: candidate.displayEndpoint }),
        createElement("div", { className: "crawl-address-badges" }, [
          createStatusBadge(candidate.weak ? "warning" : "ready", CONFIDENCE_LABELS[candidate.confidence], { compact: true }),
          ...(candidate.mediaCount ? [createElement("span", { text: `媒体 ${candidate.mediaCount}` })] : []),
          ...(candidate.relatedProfileCount ? [createElement("span", { text: `关联主页 ${candidate.relatedProfileCount}` })] : []),
          ...candidate.evidence.map((text) => createElement("span", { text })),
        ]),
      ]));
      const row = createElement("article", {
        className: `crawl-address-row${candidate.selected ? " crawl-address-row--selected" : ""}`,
        dataset: { sourceKey: source.key, candidateKey: candidate.key },
      }, [
        label,
        createElement("div", { className: "crawl-order-actions crawl-address-actions" }, [
          button("candidate-up", "上移地址", {
            small: true,
            title: `将 ${candidate.label} 上移`,
            ariaLabel: `将地址 ${candidate.label} 上移一位`,
          }),
          button("candidate-down", "下移地址", {
            small: true,
            title: `将 ${candidate.label} 下移`,
            ariaLabel: `将地址 ${candidate.label} 下移一位`,
          }),
        ]),
      ]);
      row.querySelector('[data-crawl-action="candidate-up"]').disabled = visibleIndex === 0;
      row.querySelector('[data-crawl-action="candidate-down"]').disabled = visibleIndex === visible.length - 1;
      rows.push(row);
    });
    elements.sourceHost.replaceChildren(...rows);
    renderProfiles(snapshot.relatedProfiles);
    queueMicrotask(() => restoreCrawlFocus(
      root,
      token,
      elements.leftSourceHost.querySelector('[aria-current="page"]'),
    ));
    elements.resultSummary.textContent = `${visible.length} 个当前显示 · ${selected} 个已选 · 尝试 ${source.attempts}`;
  };

  const renderSummary = (snapshot) => {
    const staleReason = snapshot.sources.length && !operationalAvailable
      ? "操作地址已安全清理，需要重新搜索后才能创建批次。"
      : "";
    const presentation = deriveCrawlSubmitPresentation(snapshot, {
      busy,
      staleReason,
      invalidReason: crawlValidation.reason,
    });
    elements.selectionSummary.replaceChildren(
      createElement("strong", { text: `${presentation.selectedSourceCount} 个来源` }),
      createElement("span", { text: `${presentation.selectedAddressCount} 个地址` }),
    );
    const order = [];
    let ordinal = 0;
    for (const source of snapshot.sources) {
      const selected = source.addresses.filter((candidate) => candidate.selected);
      if (!selected.length) continue;
      ordinal += 1;
      order.push(createElement("li", { className: "crawl-execution-source" }, [
        createElement("strong", { text: `${ordinal}. ${source.label}` }),
        createElement("ol", {}, selected.map((candidate, index) => createElement("li", {
          text: `${ordinal}.${index + 1} ${candidate.label} · ${candidate.displayEndpoint}`,
        }))),
      ]));
    }
    elements.executionPreview.replaceChildren(...(order.length ? order : [
      createElement("li", { className: "crawl-execution-empty", text: "选择候选后在此预览精确执行顺序。" }),
    ]));
    elements.startButton.disabled = presentation.state !== "ready";
    elements.startButton.title = presentation.reason;
    elements.submitBadge.dataset.status = presentation.state === "ready"
      ? "ready"
      : presentation.state === "busy"
        ? "running"
        : ["invalid", "stale"].includes(presentation.state)
          ? "error"
          : "disabled";
    elements.submitBadge.replaceChildren(
      createElement("span", { text: presentation.state === "ready" ? "✓" : presentation.state === "busy" ? "…" : "—", attributes: { "aria-hidden": "true" } }),
      createElement("span", { text: presentation.state === "ready" ? "可以创建" : presentation.state === "busy" ? "操作进行中" : "暂不可创建" }),
    );
    elements.submitReason.textContent = presentation.reason;
    elements.ehOptions.hidden = !snapshot.sources.some((source) =>
      source.site === "exhentai" && source.addresses.some((candidate) => candidate.selected));
  };

  const renderSearchState = (snapshot) => {
    const presentation = deriveCrawlSearchPresentation({ snapshot, phase: searchPhase });
    const [label, message, status] = SEARCH_STATE_COPY[presentation.state];
    elements.searchState.dataset.crawlSearchState = presentation.state;
    elements.searchStateBadge.dataset.status = status;
    elements.searchStateBadge.replaceChildren(
      createElement("span", { text: status === "ready" ? "✓" : status === "running" ? "…" : status === "warning" ? "!" : status === "error" ? "×" : "—", attributes: { "aria-hidden": "true" } }),
      createElement("span", { text: label }),
    );
    elements.searchStateMessage.textContent = message;
  };

  const render = (snapshot) => {
    const token = captureCrawlFocusToken(root);
    normalizeActiveSource(snapshot);
    elements.weakToggle.checked = snapshot.showWeakEvidence;
    renderSearchState(snapshot);
    renderSourceNavigation(snapshot);
    renderCurrentSource(snapshot);
    renderEhFilter(snapshot);
    renderSummary(snapshot);
    renderPreconditions();
    queueMicrotask(() => restoreCrawlFocus(
      root,
      token,
      elements.leftSourceHost.querySelector('[aria-current="page"]') || elements.keyword,
    ));
  };

  const setFieldValidity = (control, invalid, messageId) => {
    if (!(control instanceof HTMLElement)) return;
    control.setAttribute("aria-invalid", invalid ? "true" : "false");
    if (messageId) control.setAttribute("aria-describedby", messageId);
  };

  const markValidationField = (validation, formKind) => {
    const searchControls = [elements.keyword, elements.searchLimit, elements.searchProxy];
    const crawlControls = [
      elements.concurrency,
      elements.maxTasks,
      elements.crawlProxy,
      elements.outputDir,
      elements.imageOriginal,
      elements.imageResample,
      elements.gpPolicy,
    ];
    for (const control of formKind === "search" ? searchControls : crawlControls) {
      setFieldValidity(control, false, formKind === "search" ? "crawl-search-validation" : "crawl-submit-reason");
    }
    for (const select of elements.sitePicker.querySelectorAll('select[name^="source-"]')) {
      setFieldValidity(select, false, formKind === "search" ? "crawl-search-validation" : "crawl-submit-reason");
    }
    for (const checkbox of elements.sitePicker.querySelectorAll('input[name="crawl-site"]')) {
      setFieldValidity(checkbox, false, "crawl-search-validation");
    }
    const fieldName = validation.field;
    const control = fieldName === "sites"
      ? elements.sitePicker.querySelector('input[name="crawl-site"]')
      : elements.sitePicker.querySelector(`[name="${fieldName}"]`)
        || root.querySelector(`[name="${fieldName}"]`);
    setFieldValidity(control, !validation.valid, formKind === "search" ? "crawl-search-validation" : "crawl-submit-reason");
  };

  const refreshValidation = (formKind = "all", { announce = false } = {}) => {
    let searchValidation = validationResultForView();
    if (formKind === "all" || formKind === "search") {
      searchValidation = validateSearchDraft({
        keyword: elements.keyword.value,
        sites: selectedSites(elements),
        limit: Number(elements.searchLimit.value),
        proxyMode: elements.searchProxy.value,
        sourceOptions: readCrawlSourceOptions(elements),
      });
      markValidationField(searchValidation, "search");
      elements.searchValidation.hidden = searchValidation.valid;
      elements.searchValidation.textContent = searchValidation.valid ? "" : searchValidation.reason;
      elements.searchButton.disabled = Boolean(busy) || !searchValidation.valid;
      if (announce && !searchValidation.valid) setOperationMessage(searchValidation.reason);
    }
    if (formKind === "all" || formKind === "crawl") {
      crawlValidation = validateCrawlDraft({
        concurrency: Number(elements.concurrency.value),
        maxTasks: Number(elements.maxTasks.value),
        proxyMode: elements.crawlProxy.value,
        outputDir: elements.outputDir.value,
        outputDirInvalid: Boolean(elements.outputDir.dataset.crawlControlInvalid),
        sourceOptions: readCrawlSourceOptions(elements),
        ehDownload: {
          image_mode: elements.imageResample.checked ? "resample" : "original",
          gp_policy: elements.gpPolicy.value,
        },
      });
      markValidationField(crawlValidation, "crawl");
      renderSummary(store.getState().crawl);
      if (announce && !crawlValidation.valid) setOperationMessage(crawlValidation.reason);
    }
    return formKind === "crawl" ? crawlValidation : searchValidation;
  };

  const handleInvalid = (target) => {
    const formKind = target?.closest?.('[data-crawl-form="submit"]') ? "crawl" : "search";
    const validation = refreshValidation(formKind, { announce: true });
    if (!validation.valid) return validation;
    const fallback = formKind === "crawl"
      ? { valid: false, field: target?.name || "", reason: "批次设置无效，请修正标记项。" }
      : { valid: false, field: target?.name || "", reason: "搜索设置无效，请修正标记项。" };
    markValidationField(fallback, formKind);
    if (formKind === "search") {
      elements.searchValidation.hidden = false;
      elements.searchValidation.textContent = fallback.reason;
    } else {
      crawlValidation = fallback;
      renderSummary(store.getState().crawl);
    }
    setOperationMessage(fallback.reason);
    return fallback;
  };

  function validationResultForView() {
    return { valid: true, reason: "", field: "" };
  }

  const unsubscribe = store.subscribe((state) => ({
    crawl: state.crawl,
    readinessProxy: state.system.readiness?.proxy || null,
    authBySite: state.auth.bySite,
  }), ({ crawl }) => render(crawl), {
    fireImmediately: true,
    equality: (left, right) => Boolean(
      left && right
      && left.crawl === right.crawl
      && left.readinessProxy === right.readinessProxy
      && left.authBySite === right.authBySite
    ),
  });

  return Object.freeze({
    elements,
    readSearchDraft() {
      return {
        keyword: elements.keyword.value,
        sites: selectedSites(elements),
        limit: Number(elements.searchLimit.value),
        proxyMode: elements.searchProxy.value,
        sourceOptions: readCrawlSourceOptions(elements),
      };
    },
    readCrawlDraft() {
      return {
        concurrency: Number(elements.concurrency.value),
        maxTasks: Number(elements.maxTasks.value),
        proxyMode: elements.crawlProxy.value,
        outputDir: elements.outputDir.value,
        outputDirInvalid: Boolean(elements.outputDir.dataset.crawlControlInvalid),
        sourceOptions: readCrawlSourceOptions(elements),
        ehDownload: {
          image_mode: elements.imageResample.checked ? "resample" : "original",
          gp_policy: elements.gpPolicy.value,
        },
      };
    },
    visibleCandidateKeys() {
      const snapshot = store.getState().crawl;
      return visibleKeysForSource(snapshot, activeSource(snapshot));
    },
    sourceVisibleKeys(sourceKey) {
      const snapshot = store.getState().crawl;
      return visibleKeysForSource(snapshot, snapshot.sources.find((source) => source.key === sourceKey));
    },
    sourceCandidateKeys(sourceKey) {
      const source = store.getState().crawl.sources.find((item) => item.key === sourceKey);
      return source ? source.addresses.map((candidate) => candidate.key) : [];
    },
    validateSearchDraft() {
      return validateSearchDraft({
        keyword: elements.keyword.value,
        sites: selectedSites(elements),
        limit: Number(elements.searchLimit.value),
        proxyMode: elements.searchProxy.value,
        sourceOptions: readCrawlSourceOptions(elements),
      });
    },
    validateCrawlDraft() {
      return validateCrawlDraft({
        concurrency: Number(elements.concurrency.value),
        maxTasks: Number(elements.maxTasks.value),
        proxyMode: elements.crawlProxy.value,
        outputDir: elements.outputDir.value,
        outputDirInvalid: Boolean(elements.outputDir.dataset.crawlControlInvalid),
        sourceOptions: readCrawlSourceOptions(elements),
        ehDownload: {
          image_mode: elements.imageResample.checked ? "resample" : "original",
          gp_policy: elements.gpPolicy.value,
        },
      });
    },
    refreshValidation,
    handleInvalid,
    setOperationalAvailability(available) {
      operationalAvailable = Boolean(available);
      renderSummary(store.getState().crawl);
    },
    normalizeActiveSource,
    activeSourceKey() {
      return normalizeActiveSource(store.getState().crawl);
    },
    setActiveSource(sourceKey) {
      const snapshot = store.getState().crawl;
      if (!snapshot.sources.some((source) => source.key === sourceKey)) return false;
      activeSourceKey = sourceKey;
      render(snapshot);
      return true;
    },
    renderPreconditions,
    setSuggestions(items) {
      if (!items.length) {
        elements.suggestions.hidden = true;
        elements.suggestions.replaceChildren();
        elements.keyword.setAttribute("aria-expanded", "false");
        elements.keyword.removeAttribute("aria-activedescendant");
        return;
      }
      elements.suggestions.replaceChildren(...items.map((item, index) => createElement("button", {
        className: "crawl-suggestion",
        attributes: {
          id: `crawl-suggestion-${index}`,
          type: "button",
          role: "option",
          tabindex: "-1",
          "aria-selected": "false",
          title: `使用建议 ${item.label}`,
        },
        dataset: {
          crawlAction: "suggestion",
          suggestionValue: item.value,
          suggestionIndex: index,
        },
      }, [
        createElement("strong", { text: CATEGORY_LABELS[item.category] || "标签" }),
        createElement("span", { text: item.label }),
        ...(item.antecedent ? [createElement("small", { text: `别名 ${item.antecedent}` })] : []),
        ...(item.postCount ? [createElement("small", { text: `${item.postCount} 图` })] : []),
      ])));
      elements.suggestions.hidden = false;
      elements.keyword.setAttribute("aria-expanded", "true");
    },
    hideSuggestions() {
      elements.suggestions.hidden = true;
      elements.suggestions.replaceChildren();
      elements.keyword.setAttribute("aria-expanded", "false");
      elements.keyword.removeAttribute("aria-activedescendant");
    },
    moveSuggestionFocus(command) {
      const options = [...elements.suggestions.querySelectorAll('[role="option"]')];
      if (!options.length || elements.suggestions.hidden) return false;
      let index = options.indexOf(document.activeElement);
      if (command === "first") index = 0;
      else if (command === "last") index = options.length - 1;
      else if (command === "next") index = Math.min(options.length - 1, Math.max(0, index + 1));
      else if (command === "previous") index = Math.max(0, index < 0 ? options.length - 1 : index - 1);
      else return false;
      for (const [itemIndex, option] of options.entries()) {
        option.setAttribute("aria-selected", itemIndex === index ? "true" : "false");
      }
      options[index].focus({ preventScroll: true });
      elements.keyword.setAttribute("aria-activedescendant", options[index].id);
      return true;
    },
    activeSuggestionValue() {
      const active = document.activeElement;
      return active instanceof HTMLElement && elements.suggestions.contains(active)
        ? active.dataset.suggestionValue || ""
        : "";
    },
    setEhQuery(value) {
      const token = captureCrawlFocusToken(root);
      ehQuery = String(value || "").slice(0, 160);
      renderEhFilter(store.getState().crawl);
      queueMicrotask(() => restoreCrawlFocus(root, token, elements.ehTagQuery));
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      elements.searchButton.textContent = kind === "search" ? "正在搜索…" : "搜索来源";
      elements.startButton.textContent = kind === "crawl" ? "正在创建批次…" : "创建批次";
      refreshValidation("all");
    },
    setSearchState(phase) {
      if (!["initial", "loading", "settled", "error", "recovery"].includes(phase)) {
        throw new TypeError("搜索状态无效");
      }
      searchPhase = phase;
      renderSearchState(store.getState().crawl);
    },
    clearOutputInput() {
      elements.outputDir.value = "";
      delete elements.outputDir.dataset.crawlControlInvalid;
      refreshValidation("crawl");
    },
    clearError,
    showError,
    setOperationMessage,
    destroy() {
      unsubscribe();
      clearError();
      elements.outputDir.value = "";
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
