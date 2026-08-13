import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

export function vaultButton(action, label, pendingLabel = label, {
  dangerous = false,
  primary = false,
  className = "",
} = {}) {
  return createElement("button", {
    className: [
      "vault-button",
      dangerous ? "vault-button--dangerous" : "",
      primary ? "vault-button--primary" : "",
      className,
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button" },
    dataset: {
      vaultAction: action,
      operationKind: action,
      defaultLabel: label,
      pendingLabel,
    },
  });
}

export function vaultDefinitionList(items, className = "vault-definition-list") {
  const list = createElement("dl", { className });
  for (const [term, value] of items) {
    list.append(createElement("div", {}, [
      createElement("dt", { text: term }),
      createElement("dd", { text: value }),
    ]));
  }
  return list;
}

function createColumn(tagName, className, kicker, heading, headingId, summary, children) {
  return createElement(tagName, {
    className: `vault-column ${className}`,
    attributes: { "aria-labelledby": headingId },
  }, [
    createElement("header", { className: "vault-column-header" }, [
      createElement("p", { className: "vault-column-kicker", text: kicker }),
      createElement("h2", { text: heading, attributes: { id: headingId } }),
      createElement("p", { text: summary }),
    ]),
    createElement("div", { className: "vault-column-scroll" }, children),
  ]);
}

export function buildVaultDom(context) {
  const { root, app } = context;
  const headingId = "vault-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载授权状态");
  const refreshButton = vaultButton("refresh", "刷新授权状态", "正在刷新…");
  const operationLive = createElement("p", {
    className: "vault-operation-live",
    text: "等待操作。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const errorHost = createElement("div", {
    className: "vault-error-host",
    attributes: { id: "vault-error-host", "aria-live": "assertive" },
  });
  const waitingHost = createElement("div", {
    className: "vault-waiting-host",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { vaultWorkspaceState: "loading" },
  });

  const siteNav = createElement("nav", {
    className: "vault-site-nav",
    attributes: { "aria-label": "五个授权站点" },
    dataset: { vaultSiteNavigation: "" },
  });
  const navigationColumn = createColumn(
    "aside",
    "vault-column--navigation",
    "01 · 站点",
    "授权目标",
    "vault-sites-heading",
    "固定顺序查看五个站点；切换站点会清空登录代理输入。",
    [waitingHost, errorHost, siteNav],
  );

  const siteDetailHost = createElement("div", { className: "vault-site-detail" });
  const materialColumn = createColumn(
    "main",
    "vault-column--material",
    "02 · 材料与会话",
    "当前站点",
    "vault-material-heading",
    "查看安全的材料事实，并开始、完成或关闭托管浏览器 / OAuth 会话。",
    [operationLive, siteDetailHost],
  );

  const profileStatusHost = createElement("div", { className: "vault-profile-status" });
  const profileClearButton = vaultButton(
    "profile-clear",
    "清除共享授权浏览器数据",
    "正在清空…",
    { dangerous: true },
  );
  const profileReasons = createElement("p", {
    className: "vault-control-reason",
    attributes: { id: "vault-profile-reason", "aria-live": "polite" },
  });
  profileClearButton.setAttribute("aria-describedby", "vault-profile-impact vault-profile-reason");
  const profileSection = createElement("section", {
    className: "vault-panel vault-profile-panel",
    attributes: { "aria-labelledby": "vault-profile-heading" },
  }, [
    createElement("div", { className: "vault-panel-heading" }, [
      createElement("h3", { text: "共享授权浏览器数据", attributes: { id: "vault-profile-heading" } }),
      profileClearButton,
    ]),
    createElement("p", {
      className: "vault-impact-note",
      text: "X、Pixiv 与 EH 共用独立浏览器资料。清除会关闭活动授权并删除浏览器登录状态，但不会删除已导出的站点材料。",
      attributes: { id: "vault-profile-impact" },
    }),
    profileReasons,
    profileStatusHost,
  ]);

  const proxyStatusHost = createElement("div", { className: "vault-proxy-status" });
  const proxyInput = createElement("input", {
    className: "vault-secret-input",
    attributes: {
      id: "vault-proxy-input",
      name: "authorization-proxy-replacement",
      type: "text",
      maxlength: "300",
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "none",
      inputmode: "url",
      placeholder: "协议://主机:端口；留空表示直连",
      "aria-describedby": "vault-proxy-help vault-proxy-validation vault-error-host",
      "aria-errormessage": "vault-proxy-validation",
    },
    dataset: { vaultSecret: "" },
  });
  const proxyValidation = createElement("p", {
    className: "vault-field-error",
    attributes: { id: "vault-proxy-validation", role: "alert" },
  });
  const proxySaveButton = vaultButton(
    "proxy-save",
    "保存登录代理设置",
    "正在保存…",
    { primary: true },
  );
  proxySaveButton.type = "submit";
  proxySaveButton.removeAttribute("data-vault-action");
  const proxyResetButton = vaultButton(
    "proxy-reset",
    "恢复默认设置",
    "正在恢复…",
    { dangerous: true },
  );
  const proxyReasons = createElement("p", {
    className: "vault-control-reason",
    attributes: { id: "vault-proxy-reason", "aria-live": "polite" },
  });
  proxySaveButton.setAttribute("aria-describedby", "vault-proxy-help vault-proxy-reason");
  proxyResetButton.setAttribute("aria-describedby", "vault-proxy-reset-help vault-proxy-reason");
  const proxyForm = createElement("form", {
    className: "vault-proxy-form",
    attributes: { autocomplete: "off", novalidate: "" },
    dataset: { vaultForm: "proxy" },
  }, [
    createElement("label", {
      text: "完整新登录代理地址",
      attributes: { for: "vault-proxy-input" },
    }),
    proxyInput,
    createElement("p", {
      className: "vault-field-help",
      text: "支持 HTTP(S)、SOCKS4、SOCKS5 与 SOCKS5H。输入在提交、失败、取消、换站和离开时清空；页面不会回填原值。",
      attributes: { id: "vault-proxy-help" },
    }),
    proxyValidation,
    createElement("div", { className: "vault-form-actions" }, [proxySaveButton, proxyResetButton]),
    createElement("p", {
      className: "vault-field-help",
      text: "留空保存表示始终直连；恢复默认设置则重新采用服务配置。",
      attributes: { id: "vault-proxy-reset-help" },
    }),
    proxyReasons,
  ]);
  const proxySection = createElement("section", {
    className: "vault-panel vault-proxy-panel",
    attributes: { "aria-labelledby": "vault-proxy-heading" },
  }, [
    createElement("h3", { text: "登录代理", attributes: { id: "vault-proxy-heading" } }),
    createElement("p", {
      className: "vault-panel-copy",
      text: "仅用于授权浏览器与 Pixiv Token 交换，不改变采集代理池。状态只显示协议、主机、端口和隐藏事实。",
    }),
    proxyStatusHost,
    proxyForm,
  ]);
  const dangerSection = createElement("section", {
    className: "vault-danger-zone",
    attributes: { "aria-labelledby": "vault-danger-heading" },
  }, [
    createElement("h3", { text: "危险操作", attributes: { id: "vault-danger-heading" } }),
    createElement("p", {
      text: "清除浏览器数据、恢复代理默认值、关闭会话和删除站点材料都会先要求确认。",
    }),
  ]);
  const recoveryColumn = createColumn(
    "aside",
    "vault-column--recovery",
    "03 · 共享与恢复",
    "共享配置与危险恢复",
    "vault-recovery-heading",
    "管理共享授权浏览器数据、authorization proxy 与受确认保护的恢复动作。",
    [profileSection, proxySection, dangerSection],
  );

  const workspaceTrack = createElement("div", {
    className: "vault-workspace-track",
  }, [navigationColumn, materialColumn, recoveryColumn]);
  const workspace = createElement("section", {
    className: "vault-workspace",
    attributes: {
      "aria-label": "授权管理三段工作区，可横向滚动查看站点导航、当前材料与会话、共享配置与危险恢复",
      tabindex: "0",
    },
    dataset: { vaultWorkspace: "" },
  }, [workspaceTrack]);

  root.classList.add("app-view", "vault-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header vault-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      createElement("div", { className: "vault-header-actions" }, [headerBadge, refreshButton]),
    ]),
    workspace,
  );

  return {
    headerBadge,
    refreshButton,
    operationLive,
    errorHost,
    waitingHost,
    siteNav,
    siteDetailHost,
    profileStatusHost,
    profileClearButton,
    profileReasons,
    proxyStatusHost,
    proxyForm,
    proxyInput,
    proxyValidation,
    proxySaveButton,
    proxyResetButton,
    proxyReasons,
    workspace,
    workspaceTrack,
  };
}
