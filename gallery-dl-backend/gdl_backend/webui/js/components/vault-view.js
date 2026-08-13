import { createElement } from "../core/dom.js";
import {
  deriveVaultControls,
  deriveVaultWorkspacePresentation,
  formatAuthorizationProxy,
  formatBrowserProfile,
  formatVaultSite,
  getVaultSiteDefinition,
  validateAuthorizationProxyInput,
  VAULT_SITE_IDS,
  vaultErrorGuidance,
} from "../core/vault-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { buildVaultDom, vaultButton, vaultDefinitionList } from "./vault-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

function setControl(button, model) {
  button.disabled = model.disabled;
  button.setAttribute("aria-disabled", String(model.disabled));
  button.textContent = model.label;
  if (model.reason) button.dataset.disabledReason = model.reason;
  else delete button.dataset.disabledReason;
}

export function createVaultView(context) {
  const { root, store } = context;
  const elements = buildVaultDom(context);
  let busy = "";
  let workspacePhase = "idle";
  let selectedSiteId = VAULT_SITE_IDS[0];
  let renderedError = null;
  let proxyInputTouched = false;

  const currentSnapshot = () => ({
    bySite: store.getState().auth.bySite,
    browserProfile: store.getState().auth.browserProfile,
    authorizationProxy: store.getState().auth.authorizationProxy,
  });

  const currentValidation = () => validateAuthorizationProxyInput(elements.proxyInput.value);

  const vaultFocusToken = () => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || !root.contains(target)) return null;
    return Object.freeze({
      action: target.dataset.vaultAction || "",
      siteId: target.dataset.vaultSite || "",
      secret: target.hasAttribute("data-vault-secret"),
    });
  };

  const restoreVaultFocus = (token) => {
    if (!token) return;
    const candidates = [...root.querySelectorAll("button, input, [tabindex]")];
    const available = (element) => !element.disabled && !element.closest("[hidden]");
    let target = candidates.find((element) => available(element) && (
      (token.action && element.dataset.vaultAction === token.action) ||
      (token.siteId && element.dataset.vaultSite === token.siteId) ||
      (token.secret && element.hasAttribute("data-vault-secret"))
    ));
    target ||= candidates.find((element) => available(element) &&
      element.dataset.vaultSite === selectedSiteId) ||
      candidates.find((element) => available(element) && element.dataset.vaultAction === "refresh") ||
      elements.workspace;
    target?.focus({ preventScroll: true });
  };

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (error) => {
    clearError();
    const guidance = vaultErrorGuidance(error);
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
      details: null,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const renderBusyAttributes = () => {
    root.toggleAttribute("aria-busy", Boolean(busy));
    for (const button of root.querySelectorAll("[data-operation-kind]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const current = Boolean(busy && button.dataset.operationKind === busy);
      button.setAttribute("aria-busy", String(current));
      const label = current ? button.dataset.pendingLabel : button.dataset.defaultLabel;
      if (label) button.textContent = label;
    }
  };

  const renderWaiting = () => {
    const presentation = deriveVaultWorkspacePresentation({
      snapshot: currentSnapshot(),
      siteId: selectedSiteId,
      phase: workspacePhase,
    });
    elements.waitingHost.replaceChildren(
      createStatusBadge(presentation.kind, presentation.label),
      createElement("p", { text: presentation.message }),
    );
    elements.waitingHost.dataset.vaultWorkspaceState = presentation.state;
    updateStatusBadge(elements.headerBadge, presentation.kind, presentation.label);
  };

  const renderSiteNavigation = () => {
    const focusToken = vaultFocusToken();
    const fragment = document.createDocumentFragment();
    for (const siteId of VAULT_SITE_IDS) {
      const definition = getVaultSiteDefinition(siteId);
      const status = store.getState().auth.bySite.get(siteId) || null;
      const model = formatVaultSite(status, siteId);
      const button = vaultButton(`site:${siteId}`, definition.label, definition.label, {
        className: "vault-site-nav-button",
      });
      button.dataset.vaultSite = siteId;
      button.dataset.siteState = model.badge.status;
      button.setAttribute("aria-current", String(siteId === selectedSiteId));
      button.setAttribute("aria-label", `${definition.label}：${model.badge.label}`);
      button.replaceChildren(
        createElement("span", { className: "vault-site-mark", text: model.mark, attributes: { "aria-hidden": "true" } }),
        createElement("span", { className: "vault-site-nav-copy" }, [
          createElement("strong", { text: definition.label }),
          createElement("small", { text: model.badge.label }),
        ]),
      );
      fragment.append(button);
    }
    elements.siteNav.replaceChildren(fragment);
    restoreVaultFocus(focusToken);
  };

  const renderSiteDetail = () => {
    const focusToken = vaultFocusToken();
    const snapshot = currentSnapshot();
    const definition = getVaultSiteDefinition(selectedSiteId);
    const status = snapshot.bySite.get(selectedSiteId) || null;
    const model = formatVaultSite(status, selectedSiteId);
    const controls = deriveVaultControls(snapshot, {
      busy,
      proxyInputValid: currentValidation().valid,
    }).sites[selectedSiteId];
    const actionHost = createElement("div", { className: "vault-site-actions" });
    if (controls.showAuthorize) {
      const authorize = vaultButton(`authorize:${selectedSiteId}`, controls.authorize.label, "正在打开…", { primary: true });
      setControl(authorize, controls.authorize);
      actionHost.append(authorize);
    }
    if (controls.showCancel) {
      const cancel = vaultButton(`cancel:${selectedSiteId}`, controls.cancel.label, "正在关闭…", { dangerous: true });
      setControl(cancel, controls.cancel);
      actionHost.append(cancel);
    }
    if (controls.showClear) {
      const clear = vaultButton(`clear:${selectedSiteId}`, controls.clear.label, "正在删除…", { dangerous: true });
      setControl(clear, controls.clear);
      actionHost.append(clear);
    }
    const reasons = [controls.authorize.reason, controls.cancel.reason, controls.clear.reason].filter(Boolean);
    const content = createElement("article", {
      className: "vault-site-card",
      attributes: { "aria-label": `${definition.label} 材料与授权会话` },
      dataset: { siteState: model.badge.status },
    }, [
      createElement("div", { className: "vault-site-heading" }, [
        createElement("div", { className: "vault-site-identity" }, [
          createElement("span", { className: "vault-site-mark", text: model.mark, attributes: { "aria-hidden": "true" } }),
          createElement("h3", { text: model.label }),
        ]),
        createStatusBadge(model.badge.status, model.badge.label),
      ]),
      createElement("p", { className: "vault-site-headline", text: model.headline }),
      ...(model.proof ? [createElement("p", { className: "vault-proof-note", text: model.proof })] : []),
      vaultDefinitionList([
        ["凭证材料", model.material],
        ["授权会话", model.session],
        ["材料来源", model.source],
        ["最近更新", model.updatedAt],
      ]),
      actionHost,
      createElement("p", {
        className: "vault-control-reason",
        text: reasons[0] || (definition.method === "anonymous"
          ? "该站点无需登录材料或授权动作。"
          : "所有关闭会话与删除材料动作都会先要求确认。"),
      }),
    ]);
    elements.siteDetailHost.replaceChildren(content);
    renderBusyAttributes();
    restoreVaultFocus(focusToken);
  };

  const renderProfile = (profile) => {
    const model = formatBrowserProfile(profile);
    if (!profile) {
      elements.profileStatusHost.replaceChildren(createEmptyState({
        status: "error",
        label: "状态不可用",
        title: "共享授权浏览器数据尚未加载",
        message: "站点材料会保留上次安全状态；请手动刷新。",
      }));
    } else {
      elements.profileStatusHost.replaceChildren(
        createStatusBadge(model.badge.status, model.badge.label),
        vaultDefinitionList([
          ["共享范围", "X / Twitter、Pixiv、EH"],
          ["磁盘状态", model.presence],
          ["运行状态", model.runtime],
          ["站点材料", "独立保存，不随浏览器数据自动删除"],
        ]),
      );
    }
    renderControls();
  };

  const renderProxy = (proxy) => {
    const model = formatAuthorizationProxy(proxy);
    if (!proxy) {
      elements.proxyStatusHost.replaceChildren(createEmptyState({
        status: "error",
        label: "状态不可用",
        title: "登录代理状态尚未加载",
        message: "输入框不会回填任何旧值；请刷新后再提交。",
      }));
    } else {
      elements.proxyStatusHost.replaceChildren(
        createStatusBadge(model.badge.status, model.badge.label),
        vaultDefinitionList([
          ["地址", model.endpoint],
          ["设置来源", model.source],
          ["生效说明", model.runtime],
          ["最近更新", model.updatedAt],
          ["凭据显示", proxy.credentialsRedacted ? "账号信息已隐藏" : "响应未包含账号信息"],
        ]),
      );
    }
    renderControls();
  };

  const renderControls = () => {
    const controls = deriveVaultControls(currentSnapshot(), {
      busy,
      proxyInputValid: currentValidation().valid,
    });
    setControl(elements.refreshButton, controls.refresh);
    setControl(elements.profileClearButton, controls.profileClear);
    setControl(elements.proxySaveButton, controls.proxySave);
    setControl(elements.proxyResetButton, controls.proxyReset);
    elements.proxyInput.disabled = Boolean(busy);
    elements.proxyInput.setAttribute("aria-disabled", String(Boolean(busy)));
    elements.profileReasons.textContent = controls.profileClear.reason ||
      "清除前会再次确认；已保存的单站材料不会随共享浏览器数据删除。";
    elements.proxyReasons.textContent = controls.proxySave.reason || controls.proxyReset.reason ||
      "保存后仅影响后续授权，不会更改图片采集使用的代理池。";
    renderBusyAttributes();
  };

  const validateProxyInput = ({ announce = false } = {}) => {
    if (announce) proxyInputTouched = true;
    const validation = currentValidation();
    elements.proxyInput.setAttribute("aria-invalid", String(proxyInputTouched && !validation.valid));
    elements.proxyValidation.textContent = proxyInputTouched && !validation.valid ? validation.error : "";
    renderControls();
    return validation.valid;
  };

  const clearSensitiveInputs = () => {
    elements.proxyInput.value = "";
    elements.proxyInput.type = "text";
    elements.proxyInput.setAttribute("autocomplete", "off");
    elements.proxyInput.setAttribute("aria-invalid", "false");
    elements.proxyValidation.textContent = "";
    proxyInputTouched = false;
    renderControls();
  };

  const selectSite = (siteId, { focus = false } = {}) => {
    if (!getVaultSiteDefinition(siteId)) return false;
    selectedSiteId = siteId;
    clearSensitiveInputs();
    renderSiteNavigation();
    renderSiteDetail();
    renderWaiting();
    if (focus) {
      const target = [...elements.siteNav.querySelectorAll("[data-vault-site]")]
        .find((button) => button.dataset.vaultSite === siteId);
      target?.focus({ preventScroll: true });
    }
    return true;
  };

  const unsubscribeSites = store.subscribe(selectors.authSites, () => {
    renderSiteNavigation();
    renderSiteDetail();
    renderWaiting();
  }, { fireImmediately: true });
  const unsubscribeProfile = store.subscribe(selectors.authBrowserProfile, (profile) => {
    renderProfile(profile);
    renderWaiting();
  }, { fireImmediately: true });
  const unsubscribeProxy = store.subscribe(selectors.authAuthorizationProxy, (proxy) => {
    renderProxy(proxy);
    renderWaiting();
  }, { fireImmediately: true });

  return Object.freeze({
    elements,
    selectedSite: () => selectedSiteId,
    selectSite,
    clearSensitiveInputs,
    clearError,
    showError,
    setOperationMessage,
    validateProxyInput,
    setBusy(kind) {
      busy = kind;
      renderSiteDetail();
      renderControls();
      renderWaiting();
    },
    setWorkspacePhase(phase) {
      workspacePhase = phase;
      renderWaiting();
    },
    destroy() {
      clearSensitiveInputs();
      unsubscribeSites();
      unsubscribeProfile();
      unsubscribeProxy();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
