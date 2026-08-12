import { APPLICATION_GROUPS } from "../core/app-definitions.js";
import { createElement, setElementInert } from "../core/dom.js";
import { createIcon } from "./icons.js";
import { createStatusBadge } from "./status.js";

const AVAILABILITY_PRESENTATION = Object.freeze({
  ready: Object.freeze({ status: "ready", label: "可用", launchable: true }),
  preview: Object.freeze({ status: "warning", label: "前端预览", launchable: true }),
  placeholder: Object.freeze({ status: "disabled", label: "不可用", launchable: false }),
});

function projectDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("应用中心定义无效");
  }
  const availability = AVAILABILITY_PRESENTATION[definition.availability];
  if (!availability) throw new TypeError("应用中心 availability 无效");
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    icon: definition.icon,
    description: definition.description,
    applicationCenterOrder: definition.applicationCenterOrder,
    availability: definition.availability,
    availabilityLabel: availability.label,
    availabilityStatus: availability.status,
    launchable: availability.launchable,
  });
}

export function deriveApplicationCenterGroups(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError("应用中心来源必须是数组");
  const grouped = new Map(APPLICATION_GROUPS.map((group) => [group.id, []]));
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition?.id)) throw new TypeError("应用中心包含重复应用");
    if (!grouped.has(definition?.group)) throw new TypeError("应用中心分组无效");
    seen.add(definition.id);
    grouped.get(definition.group).push(projectDefinition(definition));
  }
  return Object.freeze(APPLICATION_GROUPS.map((group) => Object.freeze({
    id: group.id,
    title: group.title,
    items: Object.freeze(grouped.get(group.id).toSorted((left, right) => (
      left.applicationCenterOrder - right.applicationCenterOrder
    ))),
  })));
}

export function createApplicationCenter({
  host,
  definitions,
  onLaunch,
  documentObject = globalThis.document,
}) {
  if (!(host instanceof HTMLElement)) throw new TypeError("应用中心宿主无效");
  if (typeof onLaunch !== "function") throw new TypeError("应用中心需要启动委托");
  if (!documentObject || typeof documentObject.addEventListener !== "function") {
    throw new TypeError("应用中心需要可用 document");
  }

  const groups = deriveApplicationCenterGroups(definitions);
  const panel = createElement("section", {
    className: "application-center",
    attributes: {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "application-center-title",
      tabindex: "-1",
    },
    dataset: { applicationCenterPanel: "" },
  });
  const header = createElement("header", { className: "application-center__header" });
  const title = createElement("h2", {
    text: "应用中心",
    attributes: { id: "application-center-title" },
  });
  const closeButton = createElement("button", {
    className: "application-center__close",
    text: "关闭",
    attributes: { type: "button", "aria-label": "关闭应用中心", title: "关闭应用中心" },
    dataset: { applicationCenterClose: "" },
  });
  header.append(title, closeButton);
  panel.append(header);

  for (const group of groups) {
    const headingId = `application-center-group-${group.id}`;
    const section = createElement("section", {
      className: "application-center__group",
      attributes: { "aria-labelledby": headingId },
      dataset: { applicationCenterGroup: group.id },
    });
    section.append(createElement("h3", {
      text: group.title,
      attributes: { id: headingId },
    }));
    const list = createElement("ul", { className: "application-center__list" });
    for (const app of group.items) {
      const button = createElement("button", {
        className: "application-center__item",
        attributes: {
          type: "button",
          ...(app.launchable ? {} : { disabled: "", "aria-disabled": "true" }),
          "aria-label": `${app.label}，${app.availabilityLabel}。${app.description}`,
          title: app.launchable ? `打开${app.label}` : `${app.label}当前不可用`,
        },
        dataset: { applicationCenterApp: app.id },
      });
      button.append(
        createIcon(app.icon, { size: 24, strokeWidth: 1.7 }),
        createElement("span", { className: "application-center__item-copy" }, [
          createElement("strong", { text: app.label }),
          createElement("span", { text: app.description }),
        ]),
        createStatusBadge(app.availabilityStatus, app.availabilityLabel, { compact: true }),
      );
      const item = createElement("li");
      item.append(button);
      list.append(item);
    }
    section.append(list);
    panel.append(section);
  }
  host.replaceChildren(panel);
  host.hidden = true;
  setElementInert(panel, true);

  let open = false;
  let returnFocus = null;
  let destroyed = false;

  const close = ({ restoreFocus = true } = {}) => {
    if (!open || destroyed) return false;
    open = false;
    host.hidden = true;
    setElementInert(panel, true);
    if (restoreFocus && returnFocus instanceof HTMLElement && returnFocus.isConnected !== false) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
    return true;
  };

  const focusableElements = () => [...panel.querySelectorAll("button:not([disabled])")];

  const openCenter = (trigger = documentObject.activeElement) => {
    if (destroyed) return false;
    returnFocus = trigger instanceof HTMLElement ? trigger : null;
    open = true;
    host.hidden = false;
    setElementInert(panel, false);
    const launchTarget = panel.querySelector("[data-application-center-app]:not([disabled])");
    (launchTarget || closeButton || panel).focus({ preventScroll: true });
    return true;
  };

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-application-center-close]")) {
      close();
      return;
    }
    const button = event.target.closest("[data-application-center-app]");
    if (!(button instanceof HTMLButtonElement) || button.disabled || !panel.contains(button)) return;
    const appId = button.dataset.applicationCenterApp;
    close({ restoreFocus: false });
    onLaunch(appId, button);
  };
  const onKeyDown = (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && documentObject.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && documentObject.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  panel.addEventListener("click", onClick);
  documentObject.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    open: openCenter,
    close,
    render() {},
    isOpen: () => open,
    destroy() {
      if (destroyed) return;
      close({ restoreFocus: false });
      destroyed = true;
      panel.removeEventListener("click", onClick);
      documentObject.removeEventListener("keydown", onKeyDown);
      host.replaceChildren();
    },
  });
}
