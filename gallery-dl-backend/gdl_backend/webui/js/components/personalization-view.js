import { createElement } from "../core/dom.js";
import {
  derivePersonalizationPreview,
  PERSONALIZATION_DEFAULTS,
  projectPersonalizationPreferences,
} from "../core/personalization-model.js";

export const MOTION_LIMITATION_MESSAGE =
  "已开启界面动效，但系统“减少动态效果”设置会限制部分效果。";

export const PERSONALIZATION_SCENE_CHOICES = Object.freeze([
  Object.freeze({ id: "graphite", label: "夜航石墨", description: "右上月光、左下深蓝与中央微金远光。" }),
  Object.freeze({ id: "slate", label: "月岩", description: "右上冷灰蓝与左下墨蓝光井。" }),
  Object.freeze({ id: "deep-ocean", label: "深海", description: "右上海蓝、左下深青与微金远光。" }),
  Object.freeze({ id: "forest", label: "深林", description: "右上柔绿、左下墨绿与中央微金光。" }),
  Object.freeze({ id: "plum-gray", label: "雾褐", description: "右上暖灰、左下深褐与克制冷月光。" }),
  Object.freeze({ id: "warm-paper", label: "暖夜", description: "右上琥珀、左下深棕与克制月光。" }),
]);

const STATUS_KINDS = new Set(["clean", "dirty", "saving", "success", "error"]);

function choiceStateLabel(selected, current) {
  if (selected && current) return "已选择 · 当前应用";
  if (selected) return "已选择";
  if (current) return "当前应用";
  return "";
}

function sceneCanvasClass(sceneId) {
  return `personalization-scene-canvas desktop-wallpaper--${sceneId}`;
}

export function deriveMotionLimitationState(userMode, motionState) {
  if (userMode !== "on" && userMode !== "off") {
    throw new TypeError("动效模式必须是 on 或 off");
  }
  const limited = userMode === "on" && motionState?.systemReduced === true;
  return Object.freeze({
    limited,
    message: limited ? MOTION_LIMITATION_MESSAGE : "",
  });
}

function createRadioChoice({
  group,
  value,
  label,
  description = "",
  datasetName,
  scenePreview = false,
}) {
  const id = `personalization-${group}-${value}`;
  const descriptionId = description ? `${id}-description` : null;
  const stateId = `${id}-state`;
  const input = createElement("input", {
    attributes: {
      id,
      type: "radio",
      name: `personalization-${group}`,
      value,
      "aria-describedby": [descriptionId, stateId].filter(Boolean).join(" "),
    },
    dataset: { [datasetName]: value },
  });
  const sceneCanvas = scenePreview
    ? createElement("span", {
      className: sceneCanvasClass(value),
      attributes: { "aria-hidden": "true" },
    })
    : null;
  const scenePreviewElement = sceneCanvas
    ? createElement("span", {
      className: "personalization-choice__scene-preview",
      attributes: { "aria-hidden": "true" },
    }, [sceneCanvas])
    : null;
  const selection = createElement("span", {
    className: "personalization-choice__selection",
    attributes: { id: stateId },
  });
  const children = [input];
  if (scenePreviewElement) children.push(scenePreviewElement);
  children.push(createElement("strong", { text: label }));
  if (description) {
    children.push(createElement("span", {
      className: "personalization-choice__description",
      text: description,
      attributes: { id: descriptionId },
    }));
  }
  children.push(selection);
  const element = createElement("label", {
    className: `personalization-choice personalization-${group}-choice`,
    attributes: { for: id },
    dataset: {
      personalizationSelected: "false",
      personalizationCurrent: "false",
    },
  }, children);
  return Object.freeze({ input, sceneCanvas, selection, element });
}

function createColumn(index, title, description, content, modifier = "") {
  const headingId = `personalization-column-${index}`;
  return createElement("section", {
    className: `personalization-column${modifier ? ` ${modifier}` : ""}`,
    attributes: { "aria-labelledby": headingId },
  }, [
    createElement("header", { className: "personalization-column-header" }, [
      createElement("p", {
        className: "personalization-column-index",
        text: `0${index}`,
        attributes: { "aria-hidden": "true" },
      }),
      createElement("h2", { text: title, attributes: { id: headingId } }),
      createElement("p", { text: description }),
    ]),
    createElement("div", { className: "personalization-column-scroll" }, content),
  ]);
}

function actionButton(action, label, modifier = "") {
  return createElement("button", {
    className: `personalization-button${modifier ? ` ${modifier}` : ""}`,
    text: label,
    attributes: { type: action === "apply" ? "submit" : "button" },
    dataset: { personalizationAction: action },
  });
}

export function createPersonalizationView({ root, app }) {
  if (!root || typeof root.replaceChildren !== "function") {
    throw new TypeError("外观设置需要有效根节点");
  }

  const sceneChoices = new Map(PERSONALIZATION_SCENE_CHOICES.map((choice) => [
    choice.id,
    createRadioChoice({
      group: "scene",
      value: choice.id,
      label: choice.label,
      description: choice.description,
      datasetName: "personalizationScene",
      scenePreview: true,
    }),
  ]));
  const motionChoices = new Map([
    ["on", createRadioChoice({
      group: "motion",
      value: "on",
      label: "开启动效",
      description: "使用界面过渡；系统减少动态效果仍优先。",
      datasetName: "personalizationMotion",
    })],
    ["off", createRadioChoice({
      group: "motion",
      value: "off",
      label: "关闭动效",
      description: "关闭非必要过渡，直接操作反馈保持可用。",
      datasetName: "personalizationMotion",
    })],
  ]);

  const previewSceneCanvas = createElement("span", {
    className: sceneCanvasClass(PERSONALIZATION_DEFAULTS.wallpaperColor),
    attributes: { "aria-hidden": "true" },
  });
  const previewDesktop = createElement("div", {
    className: "personalization-preview-desktop",
    attributes: {
      role: "img",
      "aria-label": "夜航玻璃桌面只读预览；场景、玻璃和动效均不可在预览内编辑",
    },
    dataset: {
      personalizationScene: PERSONALIZATION_DEFAULTS.wallpaperColor,
      personalizationMotion: PERSONALIZATION_DEFAULTS.animations,
    },
  }, [
    previewSceneCanvas,
    createElement("div", { className: "personalization-preview-menu" }, [
      createElement("strong", { text: "ImageWeave" }),
      createElement("span", { text: "夜航" }),
    ]),
    createElement("div", { className: "personalization-preview-window" }, [
      createElement("div", { className: "personalization-preview-window__title", text: "夜航玻璃" }),
      createElement("span", { className: "personalization-preview-window__line" }),
      createElement("span", { className: "personalization-preview-window__line personalization-preview-window__line--short" }),
    ]),
    createElement("div", { className: "personalization-preview-dock" }, [
      createElement("span"),
      createElement("span"),
      createElement("span"),
    ]),
  ]);

  const previewSceneFact = createElement("p", {
    className: "personalization-preview-fact",
    attributes: { "aria-live": "polite", "aria-atomic": "true" },
  });
  const previewToneFact = createElement("p", {
    className: "personalization-preview-fact",
    attributes: { "aria-live": "polite", "aria-atomic": "true" },
  });
  const previewMotionFact = createElement("p", {
    className: "personalization-preview-fact",
    attributes: { "aria-live": "polite", "aria-atomic": "true" },
  });
  const previewState = createElement("p", {
    className: "personalization-preview-state",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { personalizationPreviewState: "clean" },
  });
  const motionLimit = createElement("p", {
    className: "personalization-motion-limit",
    attributes: {
      id: "personalization-motion-limit",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  const status = createElement("p", {
    className: "personalization-save-status",
    text: "设置已保存。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { personalizationStatus: "clean" },
  });

  const applyButton = actionButton("apply", "应用", "personalization-button--primary");
  const cancelButton = actionButton("cancel", "取消");
  const resetButton = actionButton("reset", "恢复默认");

  const scenePanel = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset",
    attributes: { "aria-describedby": "personalization-scene-help" },
  }, [
    createElement("legend", { text: "内置夜景场景" }),
    createElement("p", {
      className: "personalization-help",
      text: "选择一个同源内置场景；不读取本地文件或远程资源。",
      attributes: { id: "personalization-scene-help" },
    }),
    createElement("div", { className: "personalization-scene-options" }, [
      ...[...sceneChoices.values()].map((choice) => choice.element),
    ]),
  ]);

  const motionPanel = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset",
    attributes: { "aria-describedby": "personalization-motion-help personalization-motion-limit" },
  }, [
    createElement("legend", { text: "界面动效" }),
    createElement("p", {
      className: "personalization-help",
      text: "开关会实时预览；系统辅助功能设置始终优先。",
      attributes: { id: "personalization-motion-help" },
    }),
    createElement("div", { className: "personalization-motion-options" }, [
      ...[...motionChoices.values()].map((choice) => choice.element),
    ]),
    motionLimit,
  ]);

  const previewPanel = createElement("section", {
    className: "personalization-panel personalization-preview-panel",
    attributes: { "aria-labelledby": "personalization-preview-heading" },
  }, [
    createElement("h3", { text: "夜航玻璃预览", attributes: { id: "personalization-preview-heading" } }),
    createElement("p", {
      className: "personalization-help",
      text: "预览只显示场景和动效状态；深色玻璃与界面配色固定。",
    }),
    previewDesktop,
    createElement("div", { className: "personalization-preview-facts" }, [
      previewSceneFact,
      previewToneFact,
      previewMotionFact,
      previewState,
    ]),
  ]);

  const actionsPanel = createElement("section", {
    className: "personalization-panel personalization-apply-panel",
    attributes: { "aria-labelledby": "personalization-apply-heading" },
  }, [
    createElement("h3", { text: "应用设置", attributes: { id: "personalization-apply-heading" } }),
    createElement("p", {
      className: "personalization-help",
      text: "应用会保存当前场景和动效；取消会恢复上次保存的状态。",
    }),
    createElement("div", { className: "personalization-actions" }, [
      applyButton,
      cancelButton,
      resetButton,
    ]),
    status,
  ]);

  const workspaceTrack = createElement("div", { className: "personalization-workspace-track" }, [
    createColumn(1, "场景", "选择六个内置夜景之一。", [scenePanel]),
    createColumn(2, "动效", "控制非必要界面过渡。", [motionPanel]),
    createColumn(3, "应用", "检查只读预览并保存。", [previewPanel, actionsPanel], "personalization-column--apply"),
  ]);
  const workspace = createElement("section", {
    className: "personalization-workspace",
    attributes: {
      tabindex: "0",
      "aria-label": "外观设置横向工作区；使用左右方向键滚动",
    },
  }, [workspaceTrack]);
  const form = createElement("form", { className: "personalization-form" }, [workspace]);
  const titleId = "personalization-app-title";
  const header = createElement("header", { className: "personalization-app-header" }, [
    createElement("div", {}, [
      createElement("h1", { text: app?.label || "外观设置", attributes: { id: titleId } }),
      createElement("p", {
        className: "app-executable",
        text: app?.windowTitle || "外观设置",
      }),
    ]),
    createElement("p", {
      className: "app-summary",
      text: "六个内置夜景、动效与固定深色夜航玻璃。",
    }),
  ]);

  root.className = "app-view personalization-app";
  root.setAttribute("aria-labelledby", titleId);
  root.replaceChildren(header, form);

  let latestState = null;
  let viewBusy = false;

  const renderState = (state) => {
    const preview = derivePersonalizationPreview(state);
    latestState = state;
    for (const [value, choice] of sceneChoices) {
      const selected = value === state.draft.wallpaperColor;
      const current = value === state.committed.wallpaperColor;
      choice.input.checked = selected;
      choice.element.dataset.personalizationSelected = String(selected);
      choice.element.dataset.personalizationCurrent = String(current);
      choice.selection.textContent = choiceStateLabel(selected, current);
    }
    for (const [value, choice] of motionChoices) {
      const selected = value === state.draft.animations;
      const current = value === state.committed.animations;
      choice.input.checked = selected;
      choice.element.dataset.personalizationSelected = String(selected);
      choice.element.dataset.personalizationCurrent = String(current);
      choice.selection.textContent = choiceStateLabel(selected, current);
    }

    previewDesktop.dataset.personalizationScene = preview.scene.id;
    previewSceneCanvas.className = sceneCanvasClass(preview.scene.id);
    previewDesktop.dataset.personalizationMotion = preview.motion.statusId;
    previewSceneFact.textContent = `场景：${preview.scene.label}（${preview.scene.description}）`;
    previewToneFact.textContent = `外观：${preview.appearance.toneLabel}；${preview.appearance.surfaceLabel}`;
    previewMotionFact.textContent = `动效：${preview.motion.message}`;
    previewState.dataset.personalizationPreviewState = preview.status.id;
    previewState.textContent = preview.status.message;
    const limitation = deriveMotionLimitationState(state.draft.animations, state.motion);
    motionLimit.textContent = limitation.message;
    motionLimit.hidden = !limitation.limited;

    const busy = viewBusy || state.busy === true;
    for (const choice of [...sceneChoices.values(), ...motionChoices.values()]) {
      choice.input.disabled = busy;
    }
    applyButton.disabled = busy || !state.dirty;
    cancelButton.disabled = busy || !state.dirty;
    resetButton.disabled = busy;
    applyButton.setAttribute("aria-busy", String(busy));
    root.dataset.dirty = String(state.dirty);
    return preview;
  };

  renderState({
    committed: PERSONALIZATION_DEFAULTS,
    draft: PERSONALIZATION_DEFAULTS,
    dirty: false,
    busy: false,
    motion: {
      userMode: "on",
      systemReduced: false,
      effective: true,
      limitedBySystem: false,
    },
  });

  return Object.freeze({
    elements: Object.freeze({
      form,
      workspace,
      workspaceTrack,
      sceneInputs: Object.freeze(Object.fromEntries(
        [...sceneChoices].map(([value, choice]) => [value, choice.input]),
      )),
      sceneChoiceElements: Object.freeze(Object.fromEntries(
        [...sceneChoices].map(([value, choice]) => [value, choice.element]),
      )),
      scenePreviewCanvases: Object.freeze(Object.fromEntries(
        [...sceneChoices].map(([value, choice]) => [value, choice.sceneCanvas]),
      )),
      motionInputs: Object.freeze(Object.fromEntries(
        [...motionChoices].map(([value, choice]) => [value, choice.input]),
      )),
      motionChoiceElements: Object.freeze(Object.fromEntries(
        [...motionChoices].map(([value, choice]) => [value, choice.element]),
      )),
      previewDesktop,
      previewSceneCanvas,
      previewSceneFact,
      previewToneFact,
      previewMotionFact,
      previewState,
      motionLimit,
      applyButton,
      cancelButton,
      resetButton,
      status,
    }),
    readDraft(currentDraft) {
      const animations = [...motionChoices].find(([, choice]) => choice.input.checked)?.[0]
        ?? currentDraft.animations;
      const wallpaperColor = [...sceneChoices].find(([, choice]) => choice.input.checked)?.[0]
        ?? currentDraft.wallpaperColor;
      return { ...projectPersonalizationPreferences({ animations, wallpaperColor }) };
    },
    isDirty(state = latestState) {
      return state?.dirty === true;
    },
    renderState,
    scrollWorkspace(direction) {
      if (direction !== -1 && direction !== 1) return false;
      const amount = Math.max(240, Math.round((workspace.clientWidth || 720) * 0.72));
      try {
        workspace.scrollBy({ left: direction * amount, behavior: "smooth" });
      } catch {
        try {
          workspace.scrollLeft += direction * amount;
        } catch {
          return false;
        }
      }
      return true;
    },
    setBusy(value) {
      viewBusy = value === true;
      if (latestState) renderState(latestState);
    },
    setStatus(kind, message) {
      if (!STATUS_KINDS.has(kind)) throw new TypeError("外观设置状态类型无效");
      status.dataset.personalizationStatus = kind;
      status.textContent = message;
    },
    focusAfter(action) {
      const preferred = {
        apply: applyButton,
        cancel: cancelButton,
        reset: resetButton,
      }[action];
      if (preferred instanceof HTMLButtonElement && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
      }
      sceneChoices.get("graphite")?.input.focus({ preventScroll: true });
    },
    destroy() {
      latestState = null;
      viewBusy = false;
      root.replaceChildren();
      root.removeAttribute("aria-labelledby");
      root.removeAttribute("data-dirty");
      root.removeAttribute("aria-busy");
    },
  });
}
