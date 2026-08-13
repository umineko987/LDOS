import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

export function createEmptyState({
  status = "disabled",
  label = "暂无数据",
  title = "暂无可显示内容",
  message = "请刷新后重试。",
} = {}) {
  const element = createElement("section", {
    className: "empty-state",
    attributes: { role: status === "error" ? "alert" : "status" },
  });
  element.append(
    createStatusBadge(status, label),
    createElement("h3", { text: title }),
    createElement("p", { text: message }),
  );
  return element;
}
