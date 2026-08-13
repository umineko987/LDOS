import { createElement } from "../core/dom.js";
import { exportPresentation, exportSelectionFacts } from "../core/export-model.js";
import { createEmptyState } from "./empty-state.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const DISABLED_REASON = "数据集导出后端能力尚未接入，当前操作不可用。";

function button(action, label, { primary = false } = {}) {
  const element = createElement("button", {
    className: `export-button${primary ? " export-button--primary" : ""}`,
    text: label,
    attributes: { type: "button", "aria-describedby": "export-write-reason", title: DISABLED_REASON },
    dataset: { exportAction: action },
  });
  element.disabled = true;
  return element;
}

function sourceCard(source) {
  const checkbox = createElement("input", {
    attributes: { type: "checkbox", "aria-label": `选择来源 ${source.label}` },
    dataset: { exportAction: "toggle-source", exportSourceId: source.id },
  });
  checkbox.checked = source.selected;
  return createElement("label", { className: "export-source-card", dataset: { selected: String(source.selected) } }, [
    checkbox,
    createElement("span", { className: "export-source-card__copy" }, [
      createElement("strong", { text: source.label }),
      createElement("small", { text: `${source.itemCount} 项 · 已审核 ${source.reviewedCount} 项` }),
    ]),
    createStatusBadge(source.reviewedCount === source.itemCount ? "ready" : "warning", source.reviewedCount === source.itemCount ? "审核完成" : "部分审核", { compact: true }),
  ]);
}

function field(label, control) {
  return createElement("label", { className: "export-field" }, [createElement("span", { text: label }), control]);
}

function phaseState(state, presentation) {
  const message = state.phase === "error" && state.error
    ? `分类 ${state.error.category} · 代码 ${state.error.code} · 状态 ${state.error.status || "未连接"}`
    : presentation.message;
  return createEmptyState({ status: presentation.kind, label: presentation.label, title: presentation.label, message });
}

function progressCard(progress) {
  if (!progress) return null;
  const labels = {
    idle: ["disabled", "尚未开始", "等待正式导出能力接入。"],
    running: ["running", "正在导出", `夹具提供确定性进度 ${progress.completed} / ${progress.total}。`],
    success: ["ready", "导出完成", progress.resultLabel || "安全结果事实已提供。"],
    error: ["error", "导出失败", `${progress.category || "unknown"} · ${progress.code || "export_failed"}`],
  };
  const [kind, label, message] = labels[progress.state];
  const percent = progress.total > 0 ? Math.round(progress.completed * 100 / progress.total) : 0;
  return createElement("article", { className: `export-progress-card export-progress-card--${progress.state}`, dataset: { exportProgressState: progress.state } }, [
    createStatusBadge(kind, label),
    createElement("h3", { text: label }),
    createElement("p", { text: message }),
    createElement("div", { className: "export-progress-track", attributes: { role: "progressbar", "aria-label": "导出进度", "aria-valuemin": "0", "aria-valuemax": String(progress.total), "aria-valuenow": String(progress.completed) } }, [
      createElement("span", { className: "export-progress-fill", attributes: { style: `--export-progress: ${percent}%` } }),
    ]),
    createElement("strong", { className: "export-progress-count", text: `${progress.completed} / ${progress.total}` }),
  ]);
}

export function createExportView({ root, app }) {
  const headerBadge = createStatusBadge("disabled", "后端能力尚未接入");
  const workspaceBadge = createStatusBadge("disabled", "后端能力尚未接入");
  const workspaceMessage = createElement("p", { text: "数据集导出后端能力尚未接入。" });
  const workspaceState = createElement("section", { className: "export-workspace-state", attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" }, dataset: { exportWorkspaceState: "unavailable" } }, [workspaceBadge, workspaceMessage]);
  const phaseHost = createElement("div", { className: "export-phase-host", dataset: { exportPhaseHost: "" } });
  const sourceHost = createElement("div", { className: "export-source-list", dataset: { exportSourceList: "" } });
  const sourceFacts = createElement("p", { className: "export-selection-facts", text: "未选择来源。", attributes: { role: "status", "aria-live": "polite" } });

  const formatSelect = createElement("select", { className: "export-select", dataset: { exportField: "format" } }, [
    createElement("option", { text: "Manifest", attributes: { value: "manifest" } }),
    createElement("option", { text: "COCO", attributes: { value: "coco" } }),
    createElement("option", { text: "WebDataset", attributes: { value: "webdataset" } }),
  ]);
  const shardInput = createElement("input", { className: "export-input", attributes: { type: "number", min: "1", max: "100000", step: "1" }, dataset: { exportField: "shardSize" } });
  const metadataInput = createElement("input", { attributes: { type: "checkbox" }, dataset: { exportField: "includeMetadata" } });
  const rejectedInput = createElement("input", { attributes: { type: "checkbox" }, dataset: { exportField: "includeRejected" } });
  const destination = createElement("p", { className: "export-destination", text: "目标摘要不可用。", dataset: { exportDestination: "" } });
  const configPanel = createElement("section", { className: "export-config-panel" }, [
    field("导出格式", formatSelect),
    field("每分片项目数", shardInput),
    createElement("label", { className: "export-check" }, [metadataInput, createElement("span", { text: "包含安全元数据" })]),
    createElement("label", { className: "export-check" }, [rejectedInput, createElement("span", { text: "包含拒绝项" })]),
    createElement("section", { className: "export-destination-card" }, [createElement("h3", { text: "目标摘要" }), destination, button("choose-destination", "选择目标")]),
  ]);
  const reason = createElement("p", { className: "export-disabled-reason", text: DISABLED_REASON, attributes: { id: "export-write-reason" } });
  const actionPanel = createElement("div", { className: "export-actions" }, [
    button("start", "开始导出", { primary: true }),
    button("cancel", "取消导出"),
    button("open-result", "打开结果"),
  ]);
  const progressHost = createElement("div", { className: "export-progress-host", dataset: { exportProgressHost: "" } });

  const sourceColumn = createElement("aside", { className: "export-column export-column--sources", attributes: { "aria-labelledby": "export-sources-heading" } }, [
    createElement("header", { className: "export-column-header" }, [
      createElement("p", { className: "export-column-kicker", text: "01 · 来源" }),
      createElement("h2", { text: "安全来源选择", attributes: { id: "export-sources-heading" } }),
      createElement("p", { text: "只显示合成标签和计数，不显示文件或目录事实。" }),
    ]),
    createElement("div", { className: "export-column-scroll" }, [workspaceState, phaseHost, sourceHost, sourceFacts]),
  ]);
  const configColumn = createElement("main", { className: "export-column export-column--config", attributes: { "aria-labelledby": "export-config-heading" } }, [
    createElement("header", { className: "export-column-header" }, [
      createElement("p", { className: "export-column-kicker", text: "02 · 配置" }),
      createElement("h2", { text: "格式与目标", attributes: { id: "export-config-heading" } }),
      createElement("p", { text: "配置交互是纯前端状态，不访问文件系统。" }),
    ]),
    createElement("div", { className: "export-column-scroll" }, [configPanel, actionPanel, reason]),
  ]);
  const progressColumn = createElement("aside", { className: "export-column export-column--progress", attributes: { "aria-labelledby": "export-progress-heading" } }, [
    createElement("header", { className: "export-column-header" }, [
      createElement("p", { className: "export-column-kicker", text: "03 · 进度与结果" }),
      createElement("h2", { text: "确定性运行事实", attributes: { id: "export-progress-heading" } }),
      createElement("p", { text: "进度只由夹具状态提供，不使用计时器或模拟运行。" }),
    ]),
    createElement("div", { className: "export-column-scroll" }, [progressHost]),
  ]);
  const track = createElement("div", { className: "export-workspace-track" }, [sourceColumn, configColumn, progressColumn]);
  const workspace = createElement("section", { className: "export-workspace", attributes: { tabindex: "0", "aria-label": "数据集导出三栏工作区；普通窗口可横向滚动" }, dataset: { exportWorkspace: "" } }, [track]);
  root.classList.add("app-view", "export-app");
  root.setAttribute("aria-labelledby", "export-heading");
  root.replaceChildren(
    createElement("header", { className: "app-header export-app-header" }, [
      createElement("div", {}, [createElement("p", { className: "app-executable", text: app.windowTitle }), createElement("h1", { text: app.label, attributes: { id: "export-heading" } })]),
      headerBadge,
    ]),
    workspace,
  );

  let currentState = { phase: "unavailable", sources: [], config: null, progress: null, error: null };
  const render = (state = currentState) => {
    currentState = state;
    const presentation = exportPresentation(state);
    workspaceState.dataset.exportWorkspaceState = presentation.state;
    updateStatusBadge(workspaceBadge, presentation.kind, presentation.label);
    updateStatusBadge(headerBadge, presentation.kind, presentation.label);
    workspaceMessage.textContent = presentation.message;
    phaseHost.replaceChildren(...(state.phase === "content" ? [] : [phaseState(state, presentation)]));
    sourceHost.replaceChildren(...(state.phase === "content" ? state.sources.map(sourceCard) : []));
    const content = state.phase === "content";
    for (const control of [formatSelect, shardInput, metadataInput, rejectedInput]) control.disabled = !content;
    if (content) {
      formatSelect.value = state.config.format;
      shardInput.value = String(state.config.shardSize);
      metadataInput.checked = state.config.includeMetadata;
      rejectedInput.checked = state.config.includeRejected;
      destination.textContent = state.config.destinationLabel;
      const facts = exportSelectionFacts(state);
      sourceFacts.textContent = facts.sourceCount
        ? `已选择 ${facts.sourceCount} 个来源，共 ${facts.itemCount} 项，其中 ${facts.reviewedCount} 项已审核。`
        : "未选择来源。";
      progressHost.replaceChildren(progressCard(state.progress));
    } else {
      destination.textContent = "目标摘要不可用；不会读取路径。";
      sourceFacts.textContent = "未选择来源。";
      progressHost.replaceChildren(createEmptyState({ label: presentation.label, title: "暂无进度事实", message: presentation.message }));
    }
  };

  return Object.freeze({
    elements: { workspace, sourceHost, formatSelect, shardInput, metadataInput, rejectedInput, destination, progressHost },
    render,
    getState: () => currentState,
    destroy() { root.replaceChildren(); },
  });
}
