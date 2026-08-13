import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

export function policyButton(action, label, pendingLabel = label, {
  primary = false,
  dangerous = false,
  type = "button",
  className = "",
} = {}) {
  return createElement("button", {
    className: [
      "policy-button",
      primary ? "policy-button--primary" : "",
      dangerous ? "policy-button--dangerous" : "",
      className,
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type },
    dataset: {
      policyAction: action,
      operationKind: action,
      defaultLabel: label,
      pendingLabel,
    },
  });
}

function fieldHelp(id, text) {
  return createElement("p", {
    className: "policy-field-help",
    text,
    attributes: { id },
  });
}

function numericField({ id, name, label, min, max, step = "1", help }) {
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const input = createElement("input", {
    attributes: {
      id,
      name,
      type: "number",
      min: String(min),
      max: String(max),
      step,
      required: "",
      inputmode: step === "1" ? "numeric" : "decimal",
      "aria-describedby": `${helpId} ${errorId} policy-error-host`,
      "aria-errormessage": errorId,
    },
    dataset: { policyField: name },
  });
  const error = createElement("p", {
    className: "policy-field-error",
    attributes: { id: errorId, role: "alert" },
  });
  return {
    input,
    error,
    element: createElement("div", { className: "policy-field" }, [
      createElement("label", { text: label, attributes: { for: id } }),
      input,
      fieldHelp(helpId, help),
      error,
    ]),
  };
}

function createColumn(tagName, className, kicker, heading, headingId, summary, children) {
  return createElement(tagName, {
    className: `policy-column ${className}`,
    attributes: { "aria-labelledby": headingId },
  }, [
    createElement("header", { className: "policy-column-header" }, [
      createElement("p", { className: "policy-column-kicker", text: kicker }),
      createElement("h2", { text: heading, attributes: { id: headingId } }),
      createElement("p", { text: summary }),
    ]),
    createElement("div", { className: "policy-column-scroll" }, children),
  ]);
}

export function buildPolicyDom(context) {
  const { root, app } = context;
  const headingId = "policy-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载");
  const waitingHost = createElement("div", {
    className: "policy-waiting-host",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { policyWorkspaceState: "loading" },
  });
  const errorHost = createElement("div", {
    className: "policy-error-host",
    attributes: { id: "policy-error-host", "aria-live": "assertive" },
  });
  const sourceHost = createElement("nav", {
    className: "policy-source-options",
    attributes: { "aria-label": "五个站点的设置状态" },
    dataset: { policySiteNavigation: "" },
  });
  const navigationColumn = createColumn(
    "aside",
    "policy-column--navigation",
    "01 · 站点",
    "站点设置来源",
    "policy-sites-heading",
    "固定顺序查看五个站点的继承、自定义或不可编辑安全状态。",
    [waitingHost, errorHost, sourceHost],
  );

  const maxConcurrency = numericField({
    id: "policy-max-concurrency",
    name: "max_concurrency",
    label: "最大并发数",
    min: 1,
    max: 128,
    help: "范围：1–128。实际并发数仍受系统总上限限制。",
  });
  const retryLimit = numericField({
    id: "policy-retry-limit",
    name: "retry_limit",
    label: "重试次数",
    min: 0,
    max: 20,
    help: "范围：0–20。0 表示不自动重试。",
  });
  const backoff = numericField({
    id: "policy-backoff-base",
    name: "backoff_base_seconds",
    label: "首次重试等待（秒）",
    min: 0,
    max: 3600,
    step: "0.1",
    help: "范围：0–3600 秒；后续等待会随连续失败增加。",
  });
  const proxyModeError = createElement("p", {
    className: "policy-field-error",
    attributes: { id: "policy-proxy-mode-error", role: "alert" },
  });
  const proxyMode = createElement("select", {
    attributes: {
      id: "policy-proxy-mode",
      name: "proxy_mode",
      "aria-describedby": "policy-proxy-mode-help policy-proxy-mode-error policy-error-host",
      "aria-errormessage": "policy-proxy-mode-error",
    },
    dataset: { policyField: "proxy_mode" },
  }, [
    createElement("option", { text: "直连", attributes: { value: "direct" } }),
    createElement("option", {
      text: "优先代理（不可用时直连）",
      attributes: { value: "prefer" },
    }),
    createElement("option", {
      text: "仅代理（不可用时失败）",
      attributes: { value: "required" },
    }),
  ]);
  const proxyModeField = createElement("div", { className: "policy-field" }, [
    createElement("label", { text: "连接方式", attributes: { for: "policy-proxy-mode" } }),
    proxyMode,
    fieldHelp("policy-proxy-mode-help", "单次搜索或批次中的显式连接设置优先。"),
    proxyModeError,
  ]);
  const validation = createElement("p", {
    className: "policy-validation",
    attributes: { id: "policy-validation", role: "alert", "aria-live": "assertive" },
  });
  const editorHeading = createElement("h3", {
    text: "站点设置",
    attributes: { id: "policy-editor-heading" },
  });
  const form = createElement("form", {
    className: "policy-form",
    attributes: {
      autocomplete: "off",
      novalidate: "",
      "aria-labelledby": "policy-editor-heading",
    },
    dataset: { policyForm: "site" },
  }, [
    createElement("div", { className: "policy-editor-heading" }, [
      editorHeading,
      createElement("p", { text: "四个字段组成完整设置；保存始终提交全部四项。" }),
    ]),
    createElement("div", { className: "policy-field-grid" }, [
      maxConcurrency.element,
      retryLimit.element,
      backoff.element,
      proxyModeField,
    ]),
    validation,
  ]);
  const editorColumn = createColumn(
    "main",
    "policy-column--editor",
    "02 · 当前站点",
    "完整四字段编辑器",
    "policy-editor-column-heading",
    "编辑并发、重试、退避和连接方式；无效草稿不会发出请求。",
    [form],
  );

  const sourceTitle = createElement("p", { className: "policy-source-title" });
  const sourceMessage = createElement("p", { className: "policy-source-message" });
  const sourceSummary = createElement("section", {
    className: "policy-panel policy-source-summary",
    attributes: { "aria-labelledby": "policy-source-summary-heading" },
  }, [
    createElement("h3", { text: "当前来源", attributes: { id: "policy-source-summary-heading" } }),
    sourceTitle,
    sourceMessage,
  ]);
  const dirtyLive = createElement("p", {
    className: "policy-dirty-live",
    text: "设置正在加载。",
    attributes: {
      id: "policy-dirty-state",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  const operationLive = createElement("p", {
    className: "policy-operation-live",
    text: "正在加载站点设置……",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const saveButton = policyButton("save", "保存设置", "正在保存…", {
    primary: true,
    type: "submit",
  });
  saveButton.removeAttribute("data-policy-action");
  form.setAttribute("id", "policy-site-form");
  saveButton.setAttribute("form", "policy-site-form");
  const resetButton = policyButton("reset", "恢复默认设置", "正在恢复…", {
    dangerous: true,
  });
  for (const button of [saveButton, resetButton]) {
    button.setAttribute("aria-describedby", "policy-dirty-state policy-action-reason policy-impact-scope");
  }
  const actionReason = createElement("p", {
    className: "policy-action-reason",
    attributes: { id: "policy-action-reason", "aria-live": "polite" },
  });
  const actionPanel = createElement("section", {
    className: "policy-panel policy-action-panel",
    attributes: { "aria-labelledby": "policy-actions-heading" },
  }, [
    createElement("h3", { text: "保存与危险恢复", attributes: { id: "policy-actions-heading" } }),
    dirtyLive,
    operationLive,
    createElement("div", { className: "policy-form-actions" }, [saveButton, resetButton]),
    actionReason,
  ]);
  const impactPanel = createElement("section", {
    className: "policy-panel policy-impact-panel",
    attributes: { "aria-labelledby": "policy-impact-heading" },
  }, [
    createElement("h3", { text: "影响范围", attributes: { id: "policy-impact-heading" } }),
    createElement("p", {
      className: "policy-impact-scope",
      text: "保存或恢复仅影响后续新建的搜索请求与采集任务；已创建、运行中和完成的任务不变。",
      attributes: { id: "policy-impact-scope" },
    }),
    createElement("p", {
      className: "policy-danger-note",
      text: "有自定义覆盖时，恢复默认会先要求危险确认，再删除覆盖并重新读取权威设置。",
    }),
  ]);
  const actionColumn = createColumn(
    "aside",
    "policy-column--actions",
    "03 · 状态与操作",
    "来源、草稿与保存",
    "policy-actions-column-heading",
    "查看继承/覆盖来源、validation、saving、saved、readonly、error 与影响范围。",
    [sourceSummary, actionPanel, impactPanel],
  );

  const workspaceTrack = createElement("div", {
    className: "policy-workspace-track",
  }, [navigationColumn, editorColumn, actionColumn]);
  const workspace = createElement("section", {
    className: "policy-workspace",
    attributes: {
      "aria-label": "站点设置三栏工作区，可横向滚动查看站点导航、完整编辑器与保存恢复操作",
      tabindex: "0",
    },
    dataset: { policyWorkspace: "" },
  }, [workspaceTrack]);

  root.classList.add("app-view", "policy-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header policy-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      headerBadge,
    ]),
    workspace,
  );

  return {
    workspace,
    headerBadge,
    waitingHost,
    operationLive,
    errorHost,
    sourceHost,
    editorHeading,
    form,
    fields: {
      max_concurrency: maxConcurrency.input,
      retry_limit: retryLimit.input,
      backoff_base_seconds: backoff.input,
      proxy_mode: proxyMode,
    },
    fieldErrors: {
      max_concurrency: maxConcurrency.error,
      retry_limit: retryLimit.error,
      backoff_base_seconds: backoff.error,
      proxy_mode: proxyModeError,
    },
    validation,
    dirtyLive,
    sourceTitle,
    sourceMessage,
    saveButton,
    resetButton,
    actionReason,
  };
}
