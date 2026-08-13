import { createElement } from "../core/dom.js";
import {
  deriveDiagnosticsWorkspacePresentation,
  DIAGNOSTIC_DOMAIN_LABELS,
} from "../core/diagnostics-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

function button(action, label, { primary = false, small = false, token = action } = {}) {
  return createElement("button", {
    className: [
      "diagnostics-button",
      primary ? "diagnostics-button--primary" : "",
      small ? "diagnostics-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button", "aria-label": label },
    dataset: { diagnosticsAction: action, diagnosticsFocus: token },
  });
}

function metric(label, value, detail = "") {
  return createElement("div", { className: "diagnostics-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
    ...(detail ? [createElement("small", { text: detail })] : []),
  ]);
}

function definitionList(items) {
  const list = createElement("dl", { className: "diagnostics-definitions" });
  for (const [label, value] of items) {
    list.append(createElement("div", {}, [
      createElement("dt", { text: label }),
      createElement("dd", { text: String(value) }),
    ]));
  }
  return list;
}

function diagnosticsFocusToken(root) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !root.contains(target)) return "";
  return target.dataset.diagnosticsFocus || target.closest("[data-component-id]")?.dataset.componentId || "";
}

function restoreDiagnosticsFocus(root, token, workspace) {
  if (!token) return;
  const candidates = [...root.querySelectorAll("button, a, [tabindex]")];
  const available = (element) => !element.disabled && !element.closest("[hidden]");
  const target = candidates.find((element) => available(element) && (
    element.dataset.diagnosticsFocus === token ||
    element.closest("[data-component-id]")?.dataset.componentId === token
  )) || candidates.find((element) => available(element) && element.dataset.diagnosticsFocus === "refresh") || workspace;
  target?.focus({ preventScroll: true });
}

function columnHeader(kicker, title, id, description) {
  return createElement("header", { className: "diagnostics-column-header" }, [
    createElement("p", { className: "diagnostics-column-kicker", text: kicker }),
    createElement("h2", { text: title, attributes: { id } }),
    createElement("p", { text: description }),
  ]);
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "diagnostics-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载诊断");
  const refreshButton = button("refresh", "刷新诊断", { primary: true, token: "refresh" });
  const copyButton = button("copy", "复制诊断摘要", { token: "copy" });
  const docsLink = createElement("a", {
    className: "diagnostics-button diagnostics-button--small",
    text: "打开 API 文档",
    attributes: {
      href: "/docs",
      target: "_blank",
      rel: "noreferrer noopener",
      "aria-label": "在新窗口打开同源 API 文档",
    },
    dataset: { diagnosticsFocus: "docs" },
  });
  const operationLive = createElement("p", {
    className: "diagnostics-operation-live",
    text: "正在等待首次检查。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { diagnosticsLive: "" },
  });
  const workspaceBadge = createStatusBadge("disabled", "正在加载");
  const workspaceMessage = createElement("p", {
    text: "正在读取连接、就绪、安全配置和任务调度状态。",
    dataset: { diagnosticsWorkspaceMessage: "" },
  });
  const workspaceState = createElement("section", {
    className: "diagnostics-workspace-state",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { diagnosticsWorkspaceState: "loading" },
  }, [workspaceBadge, workspaceMessage]);
  const warningHost = createElement("div", {
    className: "diagnostics-warning-host",
    attributes: { "aria-live": "polite" },
    dataset: { diagnosticsWarnings: "" },
  });
  const metrics = createElement("div", { className: "diagnostics-metrics", dataset: { diagnosticsMetrics: "" } });
  const configHost = createElement("div", { dataset: { diagnosticsConfig: "" } });
  const schedulerHost = createElement("div", { dataset: { diagnosticsScheduler: "" } });
  const componentHost = createElement("div", { className: "diagnostics-components", dataset: { diagnosticsComponents: "" } });
  const emptyHost = createElement("div", { className: "diagnostics-empty-host", dataset: { diagnosticsEmpty: "" } });

  const summaryColumn = createElement("aside", {
    className: "diagnostics-column diagnostics-column--summary",
    attributes: { "aria-labelledby": "diagnostics-summary-heading" },
  }, [
    columnHeader("01 · 摘要", "连接与检查", "diagnostics-summary-heading", "手动刷新与自动轮询复用同一检查周期。"),
    createElement("div", { className: "diagnostics-column-scroll" }, [
      workspaceState,
      operationLive,
      warningHost,
      metrics,
      createElement("div", { className: "diagnostics-actions" }, [refreshButton, copyButton]),
      createElement("section", { className: "diagnostics-note" }, [
        createElement("h3", { text: "数据边界" }),
        createElement("p", { text: "仅显示白名单能力和计数；不显示路径、凭据、完整配置或错误正文。" }),
        docsLink,
      ]),
    ]),
  ]);

  const factsColumn = createElement("main", {
    className: "diagnostics-column diagnostics-column--facts",
    attributes: { "aria-labelledby": "diagnostics-facts-heading" },
  }, [
    columnHeader("02 · 服务事实", "安全配置与调度", "diagnostics-facts-heading", "配置与 scheduler 均来自 diagnostics 白名单投影。"),
    createElement("div", { className: "diagnostics-column-scroll" }, [
      createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-security-title" } }, [
        createElement("h3", { text: "安全配置", attributes: { id: "diagnostics-security-title" } }),
        configHost,
      ]),
      createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-scheduler-title" } }, [
        createElement("h3", { text: "任务调度", attributes: { id: "diagnostics-scheduler-title" } }),
        schedulerHost,
      ]),
    ]),
  ]);

  const componentsColumn = createElement("aside", {
    className: "diagnostics-column diagnostics-column--components",
    attributes: { "aria-labelledby": "diagnostics-components-heading" },
  }, [
    columnHeader("03 · 组件与恢复", "分领域诊断", "diagnostics-components-heading", "每个组件给出下一步；只有代理管理与批次管理是恢复入口。"),
    createElement("div", { className: "diagnostics-column-scroll" }, [emptyHost, componentHost]),
  ]);

  const workspaceTrack = createElement("div", {
    className: "diagnostics-workspace-track",
    dataset: { diagnosticsWorkspaceTrack: "" },
  }, [summaryColumn, factsColumn, componentsColumn]);
  const workspace = createElement("section", {
    className: "diagnostics-workspace",
    attributes: {
      tabindex: "0",
      "aria-label": "系统诊断三栏工作区；普通窗口可横向滚动",
    },
    dataset: { diagnosticsWorkspace: "" },
  }, [workspaceTrack]);

  root.classList.add("app-view", "diagnostics-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header diagnostics-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      headerBadge,
    ]),
    workspace,
  );

  return {
    headerBadge,
    refreshButton,
    copyButton,
    operationLive,
    workspaceBadge,
    workspaceMessage,
    workspaceState,
    warningHost,
    metrics,
    configHost,
    schedulerHost,
    componentHost,
    emptyHost,
    workspace,
  };
}

function checkedTime(value) {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function unavailableState(label, title, message) {
  return createEmptyState({ label, title, message });
}

function sectionIsStale(snapshot, section) {
  return snapshot.staleSections?.includes(section) === true;
}

function staleMarker(section) {
  return createElement("p", {
    className: "diagnostics-stale-marker",
    text: `${section}：显示上次成功读取的安全快照`,
  });
}

export function createDiagnosticsView(context) {
  const { root } = context;
  const elements = buildDom(context);
  let busy = false;
  let refreshing = false;
  let lastSnapshot = null;

  const renderPresentation = (snapshot = lastSnapshot) => {
    const presentation = deriveDiagnosticsWorkspacePresentation({ snapshot, refreshing });
    elements.workspaceState.dataset.diagnosticsWorkspaceState = presentation.state;
    updateStatusBadge(elements.workspaceBadge, presentation.kind, presentation.label);
    updateStatusBadge(elements.headerBadge, presentation.kind, presentation.label);
    elements.workspaceMessage.textContent = presentation.message;
  };

  const renderWarnings = (snapshot) => {
    const warnings = [];
    if (snapshot.offline) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("error", "服务离线"),
        createElement("p", { text: snapshot.staleSections.length
          ? "无法连接服务；所有可见旧分区均明确标记为陈旧。"
          : "无法连接服务，首次检查尚无可显示快照。" }),
      ]));
    } else if (snapshot.stale) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", snapshot.staleSections.length ? "部分快照陈旧" : "部分信息不可用"),
        createElement("p", { text: snapshot.staleSections.length
          ? `陈旧分区：${snapshot.staleSections.join("、")}。其余分区来自本次检查。`
          : "首次检查未取得全部分区；缺失部分不会被补造。" }),
      ]));
    }
    const failed = Object.entries(snapshot.errors).filter(([, error]) => error);
    if (failed.length) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", `${failed.length} 项检查异常`),
        createElement("p", {
          text: `安全错误码：${failed.map(([name, error]) => `${name}:${error.code}`).join(" · ")}。错误正文和请求标识不显示。`,
        }),
      ]));
    }
    elements.warningHost.replaceChildren(...warnings);
  };

  const renderFacts = (snapshot) => {
    elements.metrics.replaceChildren(
      metric("连接", snapshot.offline ? "离线" : "在线", snapshot.offline ? "上次事实可能陈旧" : "同源服务"),
      metric("健康", snapshot.health?.ok ? "正常" : "异常/未知", sectionIsStale(snapshot, "health") ? "陈旧" : "本次检查"),
      metric("就绪", snapshot.readiness?.ready ? "已就绪" : "未完全就绪", sectionIsStale(snapshot, "readiness") ? "陈旧" : "本次检查"),
      metric("检查时间", checkedTime(snapshot.lastCheckedAt), "本地显示时间"),
    );

    const config = snapshot.config;
    elements.configHost.replaceChildren(...(config ? [
      ...(sectionIsStale(snapshot, "config") ? [staleMarker("安全配置")] : []),
      definitionList([
        ["回环监听", config.loopbackOnly ? "是" : "否（异常）"],
        ["CORS", config.corsEnabled ? "已配置" : "未启用"],
        ["私网目标", config.privateTargetsEnabled ? "允许（需留意）" : "禁止"],
        ["授权缓存", config.managedAuthCache ? "启用" : "未知"],
        ["代理池", config.proxyEnabled ? `启用${config.proxyAutoStart ? " / 自动启动" : ""}` : "禁用"],
        ["Mihomo 传输核心", config.transportCoreEnabled ? "启用" : "禁用"],
        ["任务容量", config.schedulerCapacity],
        ["去重配置", config.dedupEnabled
          ? `${config.configuredDevice} · SSCD ${config.sscdEnabled ? "开" : "关"} · DINO ${config.dinoEnabled ? "开" : "关"}`
          : "禁用"],
      ]),
    ] : [unavailableState("无法读取安全配置", "安全配置不可用", "首次检查没有此分区；请刷新后重试。")]));

    const scheduler = snapshot.scheduler;
    elements.schedulerHost.replaceChildren(...(scheduler ? [
      ...(sectionIsStale(snapshot, "scheduler") ? [staleMarker("任务调度")] : []),
      definitionList([
        ["任务调度器", scheduler.tasksRunning ? "运行中" : "未运行"],
        ["活动任务", `${scheduler.activeTasks} / ${scheduler.maxConcurrent}`],
        ["活动来源数", scheduler.activeSiteCount],
        ["批次调度", scheduler.crawlsRunning ? "运行中" : "未运行"],
        ["活动批次", scheduler.activeBatches],
        ["执行方式", `${scheduler.executionOrder} / ${scheduler.addressParallelism}`],
      ]),
    ] : [unavailableState("无法读取任务调度", "任务调度状态不可用", "首次检查没有此分区；请刷新后重试。")]));
  };

  const renderComponents = (snapshot) => {
    const focusToken = diagnosticsFocusToken(root);
    const components = snapshot.readiness?.components || [];
    elements.emptyHost.replaceChildren(...(components.length ? [] : [unavailableState(
      "组件状态不可用",
      "尚未读取组件状态",
      "首次检查没有此分区；请刷新后重试。",
    )]));
    const grouped = new Map();
    for (const component of components) {
      if (!grouped.has(component.domain)) grouped.set(component.domain, []);
      grouped.get(component.domain).push(component);
    }
    const groups = [];
    for (const [domain, items] of grouped) {
      const cards = items.map((component) => {
        const children = [
          createElement("div", { className: "diagnostics-component-heading" }, [
            createElement("h4", { text: component.label }),
            createStatusBadge(component.uiStatus, component.statusLabel, { compact: true }),
          ]),
          ...(component.detail ? [createElement("p", { className: "diagnostics-component-detail", text: component.detail })] : []),
          createElement("div", { className: "diagnostics-next-step" }, [
            createElement("strong", { text: "下一步" }),
            createElement("p", { text: component.nextStep }),
          ]),
        ];
        if (component.targetApp === "proxy" || component.targetApp === "tasks") {
          children.push(button(
            "navigate",
            `打开 ${component.targetApp === "proxy" ? "代理管理" : "批次管理"}`,
            { small: true, token: `recover:${component.id}` },
          ));
        }
        return createElement("article", {
          className: "diagnostics-component",
          dataset: { componentId: component.id, targetApp: component.targetApp },
        }, children);
      });
      groups.push(createElement("section", {
        className: "diagnostics-domain",
        attributes: { "aria-labelledby": `diagnostics-domain-${domain}` },
      }, [
        createElement("h3", { text: DIAGNOSTIC_DOMAIN_LABELS[domain] || "其他组件", attributes: { id: `diagnostics-domain-${domain}` } }),
        ...cards,
      ]));
    }
    elements.componentHost.replaceChildren(...groups);
    restoreDiagnosticsFocus(root, focusToken, elements.workspace);
  };

  const render = (snapshot) => {
    const focusToken = diagnosticsFocusToken(root);
    lastSnapshot = snapshot;
    elements.copyButton.disabled = Boolean(busy || !snapshot);
    if (!snapshot) {
      elements.warningHost.replaceChildren();
      elements.metrics.replaceChildren(
        metric("连接", "检查中"), metric("健康", "—"), metric("就绪", "—"), metric("检查时间", "—"),
      );
      elements.configHost.replaceChildren(unavailableState("正在加载", "安全配置待加载", "页面激活后会立即读取。"));
      elements.schedulerHost.replaceChildren(unavailableState("正在加载", "任务调度待加载", "页面激活后会立即读取。"));
      elements.componentHost.replaceChildren();
      elements.emptyHost.replaceChildren(unavailableState("正在加载诊断", "组件状态待加载", "页面激活后会立即读取。"));
      renderPresentation(null);
      restoreDiagnosticsFocus(root, focusToken, elements.workspace);
      return;
    }
    renderWarnings(snapshot);
    renderFacts(snapshot);
    renderComponents(snapshot);
    renderPresentation(snapshot);
    restoreDiagnosticsFocus(root, focusToken, elements.workspace);
  };

  const unsubscribe = context.store.subscribe(selectors.diagnostics, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    setBusy(value) {
      busy = Boolean(value);
      refreshing = busy;
      root.toggleAttribute("aria-busy", busy);
      elements.refreshButton.disabled = busy;
      elements.refreshButton.setAttribute("aria-busy", String(busy));
      elements.refreshButton.textContent = busy ? "正在刷新…" : "刷新诊断";
      elements.copyButton.disabled = busy || !context.store.getState().diagnostics.snapshot;
      renderPresentation();
    },
    setWorkspacePhase(_phase, presentation = null) {
      if (presentation) {
        elements.workspaceState.dataset.diagnosticsWorkspaceState = presentation.state;
        updateStatusBadge(elements.workspaceBadge, presentation.kind, presentation.label);
        updateStatusBadge(elements.headerBadge, presentation.kind, presentation.label);
        elements.workspaceMessage.textContent = presentation.message;
      } else {
        renderPresentation();
      }
    },
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    render,
    destroy() {
      unsubscribe();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
