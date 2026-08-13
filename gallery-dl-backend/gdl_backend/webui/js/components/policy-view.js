import { createElement } from "../core/dom.js";
import {
  derivePolicyControls,
  derivePolicyEditorPresentation,
  derivePolicyWorkspacePresentation,
  formatPolicySource,
  getPolicySiteDefinition,
  isPolicyDirty,
  POLICY_SITE_IDS,
  policyConfigToDraft,
  policyErrorGuidance,
  validatePolicyDraft,
} from "../core/policy-model.js";
import { selectors } from "../core/store.js";
import { createErrorView } from "./error-view.js";
import { buildPolicyDom, policyButton } from "./policy-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const FIELD_NAMES = Object.freeze({
  policy: "站点设置",
  max_concurrency: "最大并发数",
  retry_limit: "重试次数",
  backoff_base_seconds: "首次重试等待",
  proxy_mode: "连接方式",
});

const REASON_TEXT = Object.freeze({
  not_number: "需要填写数字",
  not_integer: "需要填写整数",
  empty_number: "不能留空",
  out_of_range: "超出允许范围",
  invalid_enum: "不是可选的连接方式",
  missing_field: "缺少必填内容",
  unknown_field: "包含不支持的项目",
  dangerous_key: "包含不安全的内容",
  invalid_value: "内容无效",
  request_too_large: "提交内容异常过大",
});

function setControl(button, model) {
  button.disabled = model.disabled;
  button.setAttribute("aria-disabled", String(model.disabled));
  button.textContent = model.label;
  button.title = model.reason || model.label;
  if (model.reason) button.dataset.disabledReason = model.reason;
  else delete button.dataset.disabledReason;
}

function validationText(validation) {
  if (validation.valid) return "";
  const field = FIELD_NAMES[validation.field] || "站点设置";
  const reason = REASON_TEXT[validation.reason] || "内容不正确";
  return `${field}：${reason}。`;
}

export function createPolicyView(context) {
  const { root, store } = context;
  const elements = buildPolicyDom(context);
  let busy = "";
  let workspacePhase = "loading";
  let selectedSite = POLICY_SITE_IDS[0];
  let renderedError = null;
  let formLoaded = false;
  let validationAnnounced = false;

  const currentSnapshot = () => store.getState().policy.config;
  const currentItem = () => currentSnapshot()?.bySite.get(selectedSite) || null;

  const policyFocusToken = () => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || !root.contains(target)) return null;
    return Object.freeze({
      siteId: target.dataset.policySite || selectedSite,
      field: target.dataset.policyField || "",
      action: target.dataset.policyAction || target.dataset.operationKind || "",
    });
  };

  const restorePolicyFocus = (token) => {
    if (!token) return;
    const candidates = [...root.querySelectorAll("button, input, select, [tabindex]")];
    const available = (element) => !element.disabled && !element.closest("[hidden]");
    let target = candidates.find((element) => available(element) && (
      (token.field && element.dataset.policyField === token.field) ||
      (token.action && (
        element.dataset.policyAction === token.action || element.dataset.operationKind === token.action
      )) ||
      (token.siteId && element.dataset.policySite === token.siteId)
    ));
    target ||= candidates.find((element) => available(element) &&
      element.dataset.policySite === selectedSite) || elements.workspace;
    target?.focus({ preventScroll: true });
  };

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (error) => {
    clearError();
    const guidance = policyErrorGuidance(error);
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
      details: null,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
    });
    if (guidance.detail) {
      renderedError.element.append(createElement("p", {
        className: "policy-error-detail",
        text: guidance.detail,
      }));
    }
    elements.errorHost.replaceChildren(renderedError.element);
    workspacePhase = "error";
    renderFormState();
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const readDraft = () => ({
    max_concurrency: elements.fields.max_concurrency.value,
    retry_limit: elements.fields.retry_limit.value,
    backoff_base_seconds: elements.fields.backoff_base_seconds.value,
    proxy_mode: elements.fields.proxy_mode.value,
  });

  const currentValidation = () => {
    const item = currentItem();
    if (!formLoaded || !item?.editable || !item.policy) {
      return Object.freeze({
        valid: false,
        payload: null,
        field: "policy",
        index: null,
        reason: "invalid_value",
      });
    }
    return validatePolicyDraft(readDraft());
  };

  const dirty = () => {
    const item = currentItem();
    return Boolean(
      formLoaded && item?.editable && item.policy && isPolicyDirty(item.policy, readDraft())
    );
  };

  const renderBusyAttributes = () => {
    root.toggleAttribute("aria-busy", Boolean(busy));
    for (const button of root.querySelectorAll("[data-operation-kind]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.setAttribute(
        "aria-busy",
        String(Boolean(busy && button.dataset.operationKind === busy)),
      );
    }
  };

  const renderWorkspaceState = (validation = currentValidation(), isDirty = dirty()) => {
    const presentation = derivePolicyWorkspacePresentation({
      snapshot: currentSnapshot(),
      item: currentItem(),
      phase: workspacePhase,
      busy,
      dirty: isDirty,
      valid: validation.valid,
    });
    elements.waitingHost.replaceChildren(
      createStatusBadge(presentation.kind, presentation.label),
      createElement("p", { text: presentation.message }),
    );
    elements.waitingHost.dataset.policyWorkspaceState = presentation.state;
    updateStatusBadge(elements.headerBadge, presentation.kind, presentation.label);
  };

  const renderSources = () => {
    const focusToken = policyFocusToken();
    const snapshot = currentSnapshot();
    const controls = derivePolicyControls(currentItem(), {
      busy,
      dirty: dirty(),
      valid: currentValidation().valid,
    });
    const fragment = document.createDocumentFragment();
    for (const siteId of POLICY_SITE_IDS) {
      const definition = getPolicySiteDefinition(siteId);
      const item = snapshot?.bySite.get(siteId) || null;
      const model = formatPolicySource(item);
      const button = policyButton(`site:${siteId}`, definition.label, definition.label, {
        className: "policy-source-option",
      });
      button.dataset.policySite = siteId;
      button.dataset.policyState = model.badge.status;
      button.setAttribute("aria-current", String(siteId === selectedSite));
      button.setAttribute("aria-label", `${definition.label}：${model.badge.label}`);
      button.disabled = Boolean(!snapshot || controls.siteSelect.disabled);
      button.replaceChildren(
        createElement("span", {
          className: "policy-source-mark",
          text: definition.mark,
          attributes: { "aria-hidden": "true" },
        }),
        createElement("span", { className: "policy-source-copy" }, [
          createElement("strong", { text: definition.label }),
          createElement("small", { text: model.policyState }),
        ]),
        createStatusBadge(model.badge.status, model.badge.label, { compact: true }),
      );
      fragment.append(button);
    }
    elements.sourceHost.replaceChildren(fragment);
    restorePolicyFocus(focusToken);
  };

  const setFormValues = (draft) => {
    for (const [name, element] of Object.entries(elements.fields)) {
      element.value = draft[name] ?? "";
      element.setCustomValidity("");
      element.setAttribute("aria-invalid", "false");
    }
  };

  const clearValidation = () => {
    elements.validation.textContent = "";
    for (const [name, element] of Object.entries(elements.fields)) {
      element.setCustomValidity("");
      element.setAttribute("aria-invalid", "false");
      elements.fieldErrors[name].textContent = "";
    }
  };

  const clearDraft = () => {
    for (const element of Object.values(elements.fields)) element.value = "";
    formLoaded = false;
    validationAnnounced = false;
    clearValidation();
    elements.dirtyLive.dataset.dirty = "false";
    elements.dirtyLive.textContent = "设置正在加载。";
  };

  const loadSelectedDraft = () => {
    const item = currentItem();
    validationAnnounced = false;
    elements.editorHeading.textContent = item ? `${item.label} 设置` : "站点设置";
    if (!item?.editable || !item.policy) {
      clearDraft();
      renderFormState();
      return false;
    }
    setFormValues(policyConfigToDraft(item.policy));
    formLoaded = true;
    renderFormState();
    return true;
  };

  const renderValidation = (validation) => {
    clearValidation();
    if (!validationAnnounced || validation.valid) return;
    const message = validationText(validation);
    elements.validation.textContent = message;
    const field = elements.fields[validation.field];
    if (field) {
      field.setCustomValidity(message);
      field.setAttribute("aria-invalid", "true");
      elements.fieldErrors[validation.field].textContent = message;
    }
  };

  const renderEditorSource = () => {
    const presentation = derivePolicyEditorPresentation(currentItem());
    elements.sourceTitle.textContent = presentation.source;
    elements.sourceMessage.textContent = `${presentation.message} ${presentation.scope}`;
  };

  const renderFormState = () => {
    const item = currentItem();
    const validation = currentValidation();
    const isDirty = dirty();
    const controls = derivePolicyControls(item, {
      busy,
      dirty: isDirty,
      valid: validation.valid,
    });
    setControl(elements.saveButton, controls.save);
    setControl(elements.resetButton, controls.reset);
    for (const input of Object.values(elements.fields)) {
      input.disabled = Boolean(busy || !item?.editable);
      input.setAttribute("aria-disabled", String(input.disabled));
    }
    elements.dirtyLive.dataset.dirty = String(isDirty);
    elements.dirtyLive.textContent = !formLoaded
      ? item?.hasOverride && !item.editable
        ? "该站点的自定义设置无法安全读取；可恢复默认设置。"
        : "该站点设置暂时无法编辑。"
      : !validation.valid
        ? "草稿无效：请修正标记字段，尚未发送请求。"
        : isDirty
          ? "有未保存的更改。离开、最小化或关闭前会要求确认。"
          : item?.hasOverride
            ? "正在使用站点自定义设置；所有更改均已保存。"
            : "正在继承默认设置；所有更改均已保存。";
    elements.actionReason.textContent = controls.save.reason || controls.reset.reason ||
      "保存会提交完整四字段；恢复默认只影响当前站点。";
    renderValidation(validation);
    renderEditorSource();
    renderBusyAttributes();
    renderWorkspaceState(validation, isDirty);
  };

  const renderSnapshot = () => {
    const focusToken = policyFocusToken();
    const snapshot = currentSnapshot();
    if (snapshot && !snapshot.bySite.has(selectedSite)) selectedSite = POLICY_SITE_IDS[0];
    renderSources();
    loadSelectedDraft();
    restorePolicyFocus(focusToken);
  };

  const unsubscribe = store.subscribe(selectors.policyConfig, renderSnapshot, {
    fireImmediately: true,
  });

  return Object.freeze({
    elements,
    getSelectedSite: () => selectedSite,
    getCurrentItem: currentItem,
    readDraft,
    validateDraft({ announce = false } = {}) {
      if (announce) validationAnnounced = true;
      const validation = currentValidation();
      renderFormState();
      return validation;
    },
    isDirty: dirty,
    captureFocusToken: policyFocusToken,
    restoreFocusToken: restorePolicyFocus,
    selectSite(siteId) {
      if (!getPolicySiteDefinition(siteId)) throw new TypeError("站点无效");
      const focusToken = { siteId, field: "", action: "" };
      selectedSite = siteId;
      renderSources();
      loadSelectedDraft();
      restorePolicyFocus(focusToken);
    },
    restoreSourceSelection() {
      for (const button of elements.sourceHost.querySelectorAll("[data-policy-site]")) {
        button.setAttribute("aria-current", String(button.dataset.policySite === selectedSite));
      }
    },
    focusAfterOperation(action) {
      const preferred = action === "save" ? elements.saveButton : elements.resetButton;
      if (preferred instanceof HTMLButtonElement && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
      }
      restorePolicyFocus({ siteId: selectedSite, field: "", action: "" });
    },
    reloadDraft() {
      return loadSelectedDraft();
    },
    restoreDraft(draft) {
      const item = currentItem();
      if (!item?.editable || !item.policy || !draft || typeof draft !== "object") return false;
      setFormValues(draft);
      formLoaded = true;
      validationAnnounced = true;
      renderFormState();
      return true;
    },
    clearDraft,
    clearError,
    showError,
    setOperationMessage,
    setBusy(kind) {
      busy = kind;
      renderSources();
      renderFormState();
    },
    setWorkspacePhase(phase) {
      workspacePhase = phase;
      renderFormState();
    },
    renderDraftState({ announce = false } = {}) {
      if (announce) validationAnnounced = true;
      if (workspacePhase === "saved" || workspacePhase === "error") workspacePhase = "ready";
      renderFormState();
    },
    destroy() {
      clearDraft();
      unsubscribe();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
