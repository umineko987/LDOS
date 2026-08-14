import { createElement } from "../core/dom.js";
import {
  createScheduleUiState,
  schedulePresentation,
  selectSchedulePlan,
} from "../core/schedule-model.js";
import { createEmptyState } from "./empty-state.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const DISABLED_REASON = "定时任务后端能力尚未接入，当前操作不可用且不会发送业务请求。";
const VALIDATION_FIELD_BY_CONTROL = Object.freeze({
  name: "name",
  scheduleKind: "schedule-kind",
  scheduleLabel: "schedule-label",
  concurrency: "concurrency",
});

function button(action, label, { disabled = false, primary = false } = {}) {
  const element = createElement("button", {
    className: `schedule-button${primary ? " schedule-button--primary" : ""}`,
    text: label,
    attributes: {
      type: "button",
      "aria-describedby": disabled ? "schedule-write-reason" : null,
      title: disabled ? DISABLED_REASON : null,
    },
    dataset: { scheduleAction: action },
  });
  element.disabled = disabled;
  return element;
}

function statusForPlan(state) {
  const table = {
    enabled: ["ready", "已启用"],
    disabled: ["disabled", "已停用"],
    running: ["running", "正在运行"],
  };
  return table[state];
}

function planCard(plan, selected) {
  const [kind, label] = statusForPlan(plan.state);
  return createElement("button", {
    className: "schedule-plan-card",
    attributes: {
      type: "button",
      "aria-pressed": String(selected),
      "aria-label": `${plan.name}，${label}，${plan.scheduleLabel}`,
    },
    dataset: { scheduleAction: "select", schedulePlanId: plan.id, scheduleFocus: `plan:${plan.id}` },
  }, [
    createElement("span", { className: `schedule-state-symbol schedule-state-symbol--${plan.state}`, text: plan.state === "running" ? "▶" : plan.state === "enabled" ? "✓" : "—", attributes: { "aria-hidden": "true" } }),
    createElement("span", { className: "schedule-plan-card__copy" }, [
      createElement("strong", { text: plan.name }),
      createElement("small", { text: `${label} · ${plan.scheduleLabel}` }),
      createElement("small", { text: `${plan.sourceCount} 个来源 · 并发 ${plan.concurrency}` }),
    ]),
    createStatusBadge(kind, label, { compact: true }),
  ]);
}

function field(label, control) {
  return createElement("div", { className: "schedule-field" }, [
    createElement("label", { text: label, attributes: { for: control.id } }),
    control,
  ]);
}

function phaseContent(state, presentation) {
  const detail = state.phase === "error" && state.error
    ? `分类 ${state.error.category} · 代码 ${state.error.code} · 状态 ${state.error.status || "未连接"}`
    : presentation.message;
  return createEmptyState({ status: presentation.kind, label: presentation.label, title: presentation.label, message: detail });
}

export function createScheduleView({ root, app }) {
  const headerBadge = createStatusBadge("disabled", "后端能力尚未接入");
  const workspaceBadge = createStatusBadge("disabled", "后端能力尚未接入");
  const workspaceMessage = createElement("p", { text: "定时任务后端能力尚未接入。" });
  const workspaceState = createElement("section", {
    className: "schedule-workspace-state",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { scheduleWorkspaceState: "unavailable" },
  }, [workspaceBadge, workspaceMessage]);
  const planHost = createElement("div", { className: "schedule-plan-list", dataset: { schedulePlanList: "" } });
  const phaseHost = createElement("div", { className: "schedule-phase-host", dataset: { schedulePhaseHost: "" } });

  const nameInput = createElement("input", { className: "schedule-input", attributes: { id: "schedule-name", type: "text", maxlength: "72", autocomplete: "off", "aria-describedby": "schedule-validation schedule-write-reason" }, dataset: { scheduleField: "name", scheduleFocus: "field:name" } });
  const kindSelect = createElement("select", { className: "schedule-select", attributes: { id: "schedule-kind", "aria-describedby": "schedule-validation schedule-write-reason" }, dataset: { scheduleField: "scheduleKind", scheduleFocus: "field:scheduleKind" } }, [
    createElement("option", { text: "每天", attributes: { value: "daily" } }),
    createElement("option", { text: "每周", attributes: { value: "weekly" } }),
    createElement("option", { text: "固定间隔", attributes: { value: "interval" } }),
  ]);
  const scheduleInput = createElement("input", { className: "schedule-input", attributes: { id: "schedule-label", type: "text", maxlength: "80", autocomplete: "off", "aria-describedby": "schedule-validation schedule-write-reason" }, dataset: { scheduleField: "scheduleLabel", scheduleFocus: "field:scheduleLabel" } });
  const concurrencyInput = createElement("input", { className: "schedule-input", attributes: { id: "schedule-concurrency", type: "number", min: "1", max: "128", step: "1", "aria-describedby": "schedule-validation schedule-write-reason" }, dataset: { scheduleField: "concurrency", scheduleFocus: "field:concurrency" } });
  const validation = createElement("p", { className: "schedule-validation", text: "选择计划后可编辑并验证草稿。", attributes: { id: "schedule-validation", role: "status", "aria-live": "polite", "aria-atomic": "true" }, dataset: { scheduleValidation: "idle" } });
  const resetButton = button("reset", "重置草稿");
  const saveButton = button("save", "保存计划", { disabled: true, primary: true });
  const toggleButton = button("toggle", "启用 / 停用", { disabled: true });
  const runButton = button("run-now", "立即运行", { disabled: true });
  const reason = createElement("p", { className: "schedule-disabled-reason", text: DISABLED_REASON, attributes: { id: "schedule-write-reason" } });
  const editor = createElement("form", { className: "schedule-editor", attributes: { autocomplete: "off" }, dataset: { scheduleForm: "editor" } }, [
    field("计划名称", nameInput),
    field("计划类型", kindSelect),
    field("计划表达", scheduleInput),
    field("并发数", concurrencyInput),
    validation,
    createElement("div", { className: "schedule-editor-actions" }, [resetButton, saveButton, toggleButton, runButton]),
    reason,
  ]);
  const nextRunHost = createElement("div", { className: "schedule-next-run-host", dataset: { scheduleNextRun: "" } });

  const listColumn = createElement("aside", { className: "schedule-column schedule-column--list", attributes: { "aria-labelledby": "schedule-list-heading" } }, [
    createElement("header", { className: "schedule-column-header" }, [
      createElement("p", { className: "schedule-column-kicker", text: "01 · 计划" }),
      createElement("h2", { text: "自动采集计划", attributes: { id: "schedule-list-heading" } }),
      createElement("p", { text: "符号、文字与 badge 同时表达启用、停用和运行中。" }),
    ]),
    createElement("div", { className: "schedule-column-scroll" }, [workspaceState, phaseHost, planHost]),
  ]);
  const editorColumn = createElement("main", { className: "schedule-column schedule-column--editor", attributes: { "aria-labelledby": "schedule-editor-heading" } }, [
    createElement("header", { className: "schedule-column-header" }, [
      createElement("p", { className: "schedule-column-kicker", text: "02 · 编辑器" }),
      createElement("h2", { text: "计划草稿", attributes: { id: "schedule-editor-heading" } }),
      createElement("p", { text: "本地草稿可校验和重置；正式运行不保存。" }),
    ]),
    createElement("div", { className: "schedule-column-scroll" }, [editor]),
  ]);
  const summaryColumn = createElement("aside", { className: "schedule-column schedule-column--summary", attributes: { "aria-labelledby": "schedule-summary-heading" } }, [
    createElement("header", { className: "schedule-column-header" }, [
      createElement("p", { className: "schedule-column-kicker", text: "03 · 下次运行" }),
      createElement("h2", { text: "运行摘要", attributes: { id: "schedule-summary-heading" } }),
      createElement("p", { text: "只显示安全投影中的确定性事实，不计算或猜测运行时间。" }),
    ]),
    createElement("div", { className: "schedule-column-scroll" }, [nextRunHost]),
  ]);

  const track = createElement("div", { className: "schedule-workspace-track" }, [listColumn, editorColumn, summaryColumn]);
  const workspace = createElement("section", { className: "schedule-workspace", attributes: { tabindex: "0", "aria-label": "定时任务三栏工作区；普通窗口可横向滚动" }, dataset: { scheduleWorkspace: "" } }, [track]);
  root.classList.add("app-view", "schedule-app");
  root.setAttribute("aria-labelledby", "schedule-heading");
  root.replaceChildren(
    createElement("header", { className: "app-header schedule-app-header" }, [
      createElement("div", {}, [createElement("p", { className: "app-executable", text: app.windowTitle }), createElement("h1", { text: app.label, attributes: { id: "schedule-heading" } })]),
      headerBadge,
    ]),
    workspace,
  );

  let currentState = { phase: "unavailable", plans: [], error: null };
  let uiState = createScheduleUiState();

  const render = (state = currentState, nextUi = uiState) => {
    currentState = state;
    uiState = nextUi;
    const presentation = schedulePresentation(state);
    workspaceState.dataset.scheduleWorkspaceState = presentation.state;
    updateStatusBadge(workspaceBadge, presentation.kind, presentation.label);
    updateStatusBadge(headerBadge, presentation.kind, presentation.label);
    workspaceMessage.textContent = presentation.message;
    phaseHost.replaceChildren(...(state.phase === "content" ? [] : [phaseContent(state, presentation)]));
    planHost.replaceChildren(...(state.phase === "content" ? state.plans.map((plan) => planCard(plan, plan.id === uiState.selectedId)) : []));
    const plan = state.phase === "content" ? state.plans.find((item) => item.id === uiState.selectedId) : null;
    const draft = plan ? (uiState.draft || selectSchedulePlan(state, plan.id).draft) : null;
    const fields = [nameInput, kindSelect, scheduleInput, concurrencyInput];
    const fieldDescription = plan ? "schedule-validation" : "schedule-validation schedule-write-reason";
    for (const control of fields) {
      control.disabled = !plan;
      control.setAttribute("aria-describedby", fieldDescription);
    }
    resetButton.disabled = !plan;
    resetButton.setAttribute("aria-describedby", plan ? "schedule-validation" : "schedule-write-reason");
    resetButton.title = plan ? "将当前草稿恢复为当前计划事实" : DISABLED_REASON;
    editor.dataset.scheduleDirty = String(Boolean(plan && uiState.dirty));
    editor.dataset.scheduleValidity = draft && !uiState.validation.valid ? "invalid" : draft ? "valid" : "idle";
    if (draft) {
      nameInput.value = draft.name;
      kindSelect.value = draft.scheduleKind;
      scheduleInput.value = draft.scheduleLabel;
      concurrencyInput.value = String(draft.concurrency);
      validation.dataset.scheduleValidation = uiState.validation.valid ? (uiState.dirty ? "dirty" : "valid") : "invalid";
      validation.textContent = uiState.validation.valid
        ? uiState.dirty ? "草稿有效且有未保存更改；正式保存仍不可用。" : "草稿与当前计划事实一致。"
        : uiState.validation.reason;
      for (const control of fields) {
        const invalid = !uiState.validation.valid
          && VALIDATION_FIELD_BY_CONTROL[control.dataset.scheduleField] === uiState.validation.field;
        control.setAttribute("aria-invalid", String(invalid));
      }
    } else {
      nameInput.value = "";
      kindSelect.selectedIndex = 0;
      scheduleInput.value = "";
      concurrencyInput.value = "";
      for (const control of fields) control.setAttribute("aria-invalid", "false");
      validation.dataset.scheduleValidation = "idle";
      validation.textContent = state.phase === "unavailable"
        ? "后端未接入；表单已禁用且不会发送业务请求。"
        : "选择计划后可编辑并验证草稿。";
    }
    saveButton.disabled = true;
    toggleButton.disabled = true;
    runButton.disabled = true;
    nextRunHost.replaceChildren(...(plan ? [
      createElement("article", { className: "schedule-summary-card" }, [
        createStatusBadge(statusForPlan(plan.state)[0], statusForPlan(plan.state)[1]),
        createElement("h3", { text: plan.name }),
        createElement("dl", { className: "schedule-facts" }, [
          createElement("div", {}, [createElement("dt", { text: "下次运行" }), createElement("dd", { text: plan.nextRunLabel || "未提供" })]),
          createElement("div", {}, [createElement("dt", { text: "上次运行" }), createElement("dd", { text: plan.lastRunLabel || "未提供" })]),
          createElement("div", {}, [createElement("dt", { text: "来源" }), createElement("dd", { text: `${plan.sourceCount} 个安全来源标签` })]),
          createElement("div", {}, [createElement("dt", { text: "计划" }), createElement("dd", { text: plan.scheduleLabel })]),
        ]),
      ]),
      createElement("section", { className: "schedule-summary-card" }, [
        createElement("h3", { text: "能力边界" }),
        createElement("p", { text: "不会调用现有 Diagnostics 调度器状态，也不会据此伪造计划。" }),
      ]),
    ] : [createEmptyState({ label: presentation.label, title: "暂无运行摘要", message: presentation.message })]));
  };

  return Object.freeze({
    elements: { workspace, planHost, editor, nameInput, kindSelect, scheduleInput, concurrencyInput, validation, resetButton, saveButton, toggleButton, runButton },
    render,
    getUiState: () => uiState,
    getState: () => currentState,
    destroy() { root.replaceChildren(); },
  });
}
