import { setElementInert } from "../core/dom.js";
import {
  createExportUnavailableAdapter,
  projectExportState,
  toggleExportSource,
  updateExportConfig,
} from "../core/export-model.js";
import { createExportView } from "../components/export-view.js";

function adapterContract(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || typeof adapter.read !== "function") throw new TypeError("数据集导出适配器无效");
  return adapter;
}

export function createExportController(context, {
  adapter = createExportUnavailableAdapter(),
  createView = createExportView,
  initialState = null,
} = {}) {
  const { root } = context;
  const source = adapterContract(adapter);
  let state = initialState ? projectExportState(initialState) : projectExportState({ phase: "unavailable" });
  let active = false;
  let destroyed = false;
  let lifecycle = 0;
  const view = createView(context);
  if (!view || typeof view !== "object" || typeof view.render !== "function") throw new TypeError("数据集导出视图无效");
  const setState = (next) => {
    state = projectExportState(next);
    view.render(state);
    return state;
  };
  const read = async () => {
    const ticket = lifecycle;
    const next = await source.read();
    if (!active || destroyed || ticket !== lifecycle) return false;
    setState(next);
    return true;
  };

  const onChange = (event) => {
    if (!active || destroyed || !(event.target instanceof HTMLElement) || state.phase !== "content") return;
    if (event.target.dataset.exportAction === "toggle-source") {
      state = toggleExportSource(state, event.target.dataset.exportSourceId);
      view.render(state);
      return;
    }
    const field = event.target.dataset.exportField;
    if (!field) return;
    let value;
    if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") value = event.target.checked;
    else if (field === "shardSize") value = Number(event.target.value);
    else value = event.target.value;
    state = updateExportConfig(state, { [field]: value });
    view.render(state);
    const replacement = root.querySelector(`[data-export-field="${field}"]`);
    replacement?.focus({ preventScroll: true });
  };

  root.addEventListener("change", onChange);
  root.addEventListener("input", onChange);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycle += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.render(state);
      void read().catch(() => {
        if (active && !destroyed) setState({ phase: "error", error: { code: "adapter_failed", status: 0, requestId: "", category: "capability" } });
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    setState,
    getState: () => state,
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      lifecycle += 1;
      root.removeEventListener("change", onChange);
      root.removeEventListener("input", onChange);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("数据集导出已挂载");
    controller = createExportController(context);
  },
  activate() { controller?.activate(); },
  deactivate() { controller?.deactivate(); },
  unmount() { controller?.destroy(); controller = null; },
});
