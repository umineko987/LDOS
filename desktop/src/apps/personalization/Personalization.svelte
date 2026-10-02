<script lang="ts">
  import { onMount, untrack } from "svelte";

  import { createMotionController } from "../../core/motion/controller";
  import { BUILT_IN_SCENES, type SceneId } from "../../core/personalization/scenes";
  import { PERSONALIZATION_DEFAULTS } from "./model";
  import type { PersistenceService, UiPreferences } from "../../core/persistence/service";
  import { createPersonalizationController } from "./controller";
  import { createPersonalizationService } from "./service";
  import { createPersonalizationStore } from "./state";
  import "./personalization.css";

  let { persistence, registerUnsavedChanges }: {
    persistence: PersistenceService;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void) => () => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createPersonalizationStore({ initial: persistence.readUiPreferences() });
    const motion = createMotionController({ storage: persistence });
    const controller = createPersonalizationController({ store, service: createPersonalizationService(persistence), motion });
    return { store, controller };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  function sceneLabel(scene: SceneId): string { return BUILT_IN_SCENES.find(({ id }) => id === scene)?.label ?? "夜航石墨"; }
  function sceneDescription(scene: SceneId): string { return BUILT_IN_SCENES.find(({ id }) => id === scene)?.description ?? "内置夜景场景。"; }
  function sceneCanvasClass(scene: SceneId): string { return `personalization-scene-canvas wallpaper--${scene} desktop-wallpaper--${scene}`; }
  function chooseScene(scene: SceneId): void { controller.preview({ wallpaperColor: scene }); }
  function chooseMotion(animations: UiPreferences["animations"]): void { controller.preview({ animations }); }
  function restoreDefaults(): void {
    const alreadyDefault = snapshot.draft.animations === PERSONALIZATION_DEFAULTS.animations && snapshot.draft.wallpaperColor === PERSONALIZATION_DEFAULTS.wallpaperColor;
    controller.preview(PERSONALIZATION_DEFAULTS, alreadyDefault ? "当前已经使用默认设置。" : "已预览默认设置，点击“应用”后保存。");
  }
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!snapshot.dirty && !snapshot.busy) return;
    event.preventDefault();
    event.returnValue = "";
  }

  onMount(() => {
    const unregister = registerUnsavedChanges?.(() => snapshot.dirty || snapshot.busy, () => { controller.cancel(); }) ?? (() => {});
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    controller.activate();
    return () => {
      unregister();
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      controller.destroy();
    };
  });
</script>

<section class="personalization-app" data-personalization-app data-domain-owner="personalization" aria-labelledby="personalization-heading" aria-busy={snapshot.busy} data-personalization-state={snapshot.presentation.state}>
  <header class="personalization-header">
    <h1 id="personalization-heading">外观</h1>
    <span class="personalization-status" data-kind={snapshot.presentation.kind}>{snapshot.presentation.label}</span>
  </header>
  <p class="personalization-live" aria-live="polite">{snapshot.message}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable personalization workspace) -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard-scrollable personalization workspace) -->
  <section class="personalization-workspace" tabindex="0" aria-label="外观设置；可纵向滚动">
    <div class="personalization-workspace-track">
      <section class="personalization-column" aria-labelledby="personalization-scenes-heading">
        <header class="personalization-column-header"><h2 id="personalization-scenes-heading">工作台配色</h2></header>
        <div class="personalization-column-scroll">
          <fieldset class="personalization-panel personalization-scenes"><legend>选择配色</legend>
            {#each BUILT_IN_SCENES as scene (scene.id)}
              {@const selected = snapshot.draft.wallpaperColor === scene.id}
              {@const current = snapshot.committed.wallpaperColor === scene.id}
              {@const stateId = `personalization-scene-${scene.id}-state`}
              {@const descriptionId = `personalization-scene-${scene.id}-description`}
              <label class="personalization-choice personalization-scene-choice" data-personalization-scene={scene.id} data-personalization-selected={selected} data-personalization-current={current}>
                <input type="radio" name="personalization-scene" value={scene.id} checked={selected} disabled={snapshot.busy} aria-describedby={`${descriptionId} ${stateId}`} onchange={() => chooseScene(scene.id)} />
                <span class="personalization-choice__scene-preview" aria-hidden="true"><span class={sceneCanvasClass(scene.id)}></span></span>
                <strong>{scene.label}</strong><span id={descriptionId} class="personalization-choice__description">{scene.description}</span><span id={stateId} class="personalization-choice__selection" aria-live="polite">{selected ? current ? "已选择 · 当前应用" : "已选择" : current ? "当前应用" : ""}</span>
              </label>
            {/each}
          </fieldset>
          <p id="personalization-scene-help" class="personalization-help" aria-live="polite">{sceneLabel(snapshot.draft.wallpaperColor)}：{sceneDescription(snapshot.draft.wallpaperColor)}</p>
        </div>
      </section>

      <section class="personalization-column" aria-labelledby="personalization-motion-heading">
        <header class="personalization-column-header"><h2 id="personalization-motion-heading">界面动效</h2></header>
        <div class="personalization-column-scroll">
          <fieldset class="personalization-panel personalization-motion-controls"><legend>动效开关</legend>
            {#if snapshot.draft.animations === "on"}
              <label class="personalization-choice" data-personalization-motion="on" data-personalization-selected="true" data-personalization-current={snapshot.committed.animations === "on"}>
                <input type="radio" name="personalization-motion" value="on" checked disabled={snapshot.busy} aria-describedby="personalization-motion-on-description personalization-motion-on-state" onchange={() => chooseMotion("on")} />
                <strong>开启动效</strong><span id="personalization-motion-on-description" class="personalization-choice__description">使用界面过渡；系统减少动态效果仍优先。</span><span id="personalization-motion-on-state" class="personalization-choice__selection" aria-live="polite">{snapshot.committed.animations === "on" ? "已选择 · 当前应用" : "已选择"}</span>
              </label>
            {:else}
              <label class="personalization-choice" data-personalization-motion="on" data-personalization-selected="false" data-personalization-current={snapshot.committed.animations === "on"}>
                <input type="radio" name="personalization-motion" value="on" checked={false} disabled={snapshot.busy} aria-describedby="personalization-motion-on-description personalization-motion-on-state" onchange={() => chooseMotion("on")} />
                <strong>开启动效</strong><span id="personalization-motion-on-description" class="personalization-choice__description">使用界面过渡；系统减少动态效果仍优先。</span><span id="personalization-motion-on-state" class="personalization-choice__selection" aria-live="polite">{snapshot.committed.animations === "on" ? "当前应用" : ""}</span>
              </label>
            {/if}
            {#if snapshot.draft.animations === "off"}
              <label class="personalization-choice" data-personalization-motion="off" data-personalization-selected="true" data-personalization-current={snapshot.committed.animations === "off"}>
                <input type="radio" name="personalization-motion" value="off" checked disabled={snapshot.busy} aria-describedby="personalization-motion-off-description personalization-motion-off-state" onchange={() => chooseMotion("off")} />
                <strong>关闭动效</strong><span id="personalization-motion-off-description" class="personalization-choice__description">关闭非必要过渡，直接操作反馈保持可用。</span><span id="personalization-motion-off-state" class="personalization-choice__selection" aria-live="polite">{snapshot.committed.animations === "off" ? "已选择 · 当前应用" : "已选择"}</span>
              </label>
            {:else}
              <label class="personalization-choice" data-personalization-motion="off" data-personalization-selected="false" data-personalization-current={snapshot.committed.animations === "off"}>
                <input type="radio" name="personalization-motion" value="off" checked={false} disabled={snapshot.busy} aria-describedby="personalization-motion-off-description personalization-motion-off-state" onchange={() => chooseMotion("off")} />
                <strong>关闭动效</strong><span id="personalization-motion-off-description" class="personalization-choice__description">关闭非必要过渡，直接操作反馈保持可用。</span><span id="personalization-motion-off-state" class="personalization-choice__selection" aria-live="polite">{snapshot.committed.animations === "off" ? "当前应用" : ""}</span>
              </label>
            {/if}
          </fieldset>
          <p class="personalization-motion-limit" hidden={!snapshot.motion.limitedBySystem} role="status" aria-live="polite">已开启动效，但系统“减少动态效果”正在限制部分效果。</p>
        </div>
      </section>

      <section class="personalization-column personalization-column--apply" aria-labelledby="personalization-preview-heading">
        <header class="personalization-column-header"><h2 id="personalization-preview-heading">工作台预览</h2><span>选择后即时预览，点击“应用”保存；“取消”恢复原设置。</span></header>
        <div class="personalization-column-scroll">
          <div class="personalization-preview-desktop wallpaper--{snapshot.draft.wallpaperColor}" role="img" aria-label="工作台配色只读预览；左侧导航和单内容区" data-personalization-scene={snapshot.draft.wallpaperColor} data-personalization-motion={snapshot.motion.limitedBySystem ? "system-limited" : snapshot.draft.animations}>
            <span class={sceneCanvasClass(snapshot.draft.wallpaperColor)} aria-hidden="true"></span>
            <div class="personalization-preview-layout" aria-hidden="true">
              <div class="personalization-preview-sidebar"><strong>LDOS</strong><span>采集</span><span>任务</span><span class="active">图库</span><span>设置</span></div>
              <div class="personalization-preview-content"><strong>图库</strong><div class="personalization-preview-toolbar"></div><div class="personalization-preview-images"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
            </div>
          </div>
          <p class="personalization-preview-fact" aria-live="polite">配色：{sceneLabel(snapshot.draft.wallpaperColor)}</p><p class="personalization-preview-fact" aria-live="polite">动效：{snapshot.motion.limitedBySystem ? "已开启动效，但系统“减少动态效果”正在限制部分效果。" : snapshot.draft.animations === "on" ? "界面动效已开启并生效。" : "界面动效已关闭。"}</p>
          <form class="personalization-actions" autocomplete="off" onsubmit={(event) => { event.preventDefault(); void controller.commit(); }}>
            <button type="submit" class="personalization-button personalization-button--primary" disabled={!snapshot.dirty || snapshot.busy}>{snapshot.busy ? "正在保存…" : "应用"}</button><button type="button" class="personalization-button" disabled={!snapshot.dirty || snapshot.busy} onclick={() => controller.cancel()}>取消</button><button type="button" class="personalization-button" disabled={snapshot.busy} onclick={restoreDefaults}>恢复默认</button>
          </form>
          <p class="personalization-save-status" data-personalization-status={snapshot.presentation.state} role="status" aria-live="polite">{snapshot.message}</p>
        </div>
      </section>
    </div>
  </section>
</section>
