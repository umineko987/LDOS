import {
  nextKeyboardResizeRect,
  nextPointerInteractionRect,
  sameWindowRect,
} from "./window-policy.js";

export function createWindowInteractionController({
  actions,
  applyRect,
  displayedRect,
  effectivelyMaximized,
  getRecord,
  getViewport,
  getGeometryOptions,
  isMobileViewport,
  isUnavailable,
  isDestroying,
  normalRect,
}) {
  const finish = (instance, event = null, { commit = true } = {}) => {
    const interaction = instance.interaction;
    if (!interaction) return false;
    if (event && event.pointerId !== interaction.pointerId) return false;
    // 先清空交互对象，releasePointerCapture 紧随触发的 lostpointercapture 才会幂等退出。
    instance.interaction = null;
    try {
      if (interaction.control.hasPointerCapture?.(interaction.pointerId)) {
        interaction.control.releasePointerCapture(interaction.pointerId);
      }
    } catch {
      // 指针可能已由浏览器释放；最终矩形仍按同一收尾路径处理。
    }

    const record = getRecord(instance.appId);
    try {
      if (
        commit
        && record
        && record.windowState !== "minimized"
        && !effectivelyMaximized(record)
        && !sameWindowRect(interaction.rect, record.rect)
      ) {
        // 保持交互样式直至同步渲染完成，避免最终矩形参与恢复后的 transition。
        actions.moveWindow(instance.appId, interaction.rect);
      } else if (record && !isDestroying()) {
        applyRect(instance.element, displayedRect(record));
      }
    } finally {
      instance.element.removeAttribute("data-window-interacting");
      actions.endWindowInteraction?.();
    }
    return true;
  };

  const start = (instance, event, type, resizeDirection = "") => {
    const record = getRecord(instance.appId);
    if (
      isUnavailable()
      || instance.interaction
      || event.button !== 0
      || event.isPrimary === false
      || !record
      || record.windowState === "minimized"
      || effectivelyMaximized(record)
    ) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    actions.beginWindowInteraction?.();
    const rect = normalRect(record);
    instance.interaction = {
      type,
      resizeDirection,
      pointerId: event.pointerId,
      control: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: rect,
      rect,
    };
    instance.element.setAttribute("data-window-interacting", type);
  };

  const move = (instance, event) => {
    const interaction = instance.interaction;
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    if (isMobileViewport()) {
      finish(instance, event, { commit: false });
      return;
    }
    const viewport = getViewport();
    interaction.rect = nextPointerInteractionRect(
      interaction,
      event,
      viewport,
      getGeometryOptions(viewport),
    );
    // 高频路径只触碰当前实例的样式；store 与 storage 留到统一收尾。
    applyRect(instance.element, interaction.rect);
  };

  const resizeFromKeyboard = (instance, direction, event) => {
    const record = getRecord(instance.appId);
    if (!record || record.windowState === "minimized" || effectivelyMaximized(record)) return;
    const viewport = getViewport();
    const rect = nextKeyboardResizeRect(
      record,
      direction,
      event.key,
      viewport,
      getGeometryOptions(viewport),
    );
    if (!rect) return;
    event.preventDefault();
    if (!sameWindowRect(rect, record.rect)) actions.moveWindow(instance.appId, rect);
  };

  return Object.freeze({ finish, move, resizeFromKeyboard, start });
}
