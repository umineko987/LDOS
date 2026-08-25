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
  function scrollWorkspace(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    const distance = Math.max(240, element.clientWidth * 0.72);
    element.scrollBy({ left: event.key === "ArrowRight" ? distance : -distance });
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
    <div><p>外观设置</p><h1 id="personalization-heading">夜航桌面与动效</h1></div>
    <span class="personalization-status" data-kind={snapshot.presentation.kind}>{snapshot.presentation.label}</span>
  </header>
  <p class="personalization-live" aria-live="polite">{snapshot.message}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable personalization workspace) -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard-scrollable personalization workspace) -->
  <section class="personalization-workspace" tabindex="0" onkeydown={scrollWorkspace} aria-label="外观设置三栏工作区，可横向滚动查看场景、动效与应用预览">
    <div class="personalization-workspace-track">
      <section class="personalization-column" aria-labelledby="personalization-scenes-heading">
        <header class="personalization-column-header"><p>01 · 场景</p><h2 id="personalization-scenes-heading">内置夜景场景</h2><span>只提供六个安全内置场景，不读取本地文件或远程资源。</span></header>
        <div class="personalization-column-scroll">
          <fieldset class="personalization-panel"><legend>选择桌面场景</legend>
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
        <header class="personalization-column-header"><p>02 · 动效</p><h2 id="personalization-motion-heading">界面动效</h2><span>系统“减少动态效果”始终优先于用户开启动效。</span></header>
        <div class="personalization-column-scroll">
          <fieldset class="personalization-panel"><legend>动效开关</legend>
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
          <section class="personalization-panel"><h3>当前状态</h3><p class="personalization-preview-fact" aria-live="polite">{snapshot.motion.limitedBySystem ? "系统限制部分动效" : snapshot.draft.animations === "on" ? "界面动效已开启并生效" : "界面动效已关闭"}</p><p class="personalization-preview-fact" aria-live="polite">{snapshot.dirty ? "有未应用的更改" : "当前预览与已保存设置一致"}</p></section>
        </div>
      </section>

      <section class="personalization-column personalization-column--apply" aria-labelledby="personalization-preview-heading">
        <header class="personalization-column-header"><p>03 · 应用</p><h2 id="personalization-preview-heading">桌面预览与应用</h2><span>预览即时投影到桌面；应用后只写入现有 UI 偏好键。</span></header>
        <div class="personalization-column-scroll">
          <div class="personalization-preview-desktop wallpaper--{snapshot.draft.wallpaperColor}" role="img" aria-label="夜航玻璃桌面只读预览；场景、玻璃和动效均不可在预览内编辑" data-personalization-scene={snapshot.draft.wallpaperColor} data-personalization-motion={snapshot.motion.limitedBySystem ? "system-limited" : snapshot.draft.animations}>
            <span class={sceneCanvasClass(snapshot.draft.wallpaperColor)} aria-hidden="true"></span>
            <div class="personalization-preview-menu"><strong>ImageWeave</strong><span>夜航</span></div><div class="personalization-preview-window"><span>夜航玻璃</span><i></i><i></i></div><div class="personalization-preview-dock"><i></i><i></i><i></i></div>
          </div>
          <p class="personalization-preview-fact" aria-live="polite">场景：{sceneLabel(snapshot.draft.wallpaperColor)}（{sceneDescription(snapshot.draft.wallpaperColor)}）</p><p class="personalization-preview-fact" aria-live="polite">外观：深色夜航玻璃；窗口使用固定低透明玻璃表面。</p><p class="personalization-preview-fact" aria-live="polite">动效：{snapshot.motion.limitedBySystem ? "已开启动效，但系统“减少动态效果”正在限制部分效果。" : snapshot.draft.animations === "on" ? "界面动效已开启并生效。" : "界面动效已关闭。"}</p>
          <form class="personalization-actions" autocomplete="off" onsubmit={(event) => { event.preventDefault(); void controller.commit(); }}>
            <button type="submit" class="personalization-button personalization-button--primary" disabled={!snapshot.dirty || snapshot.busy}>{snapshot.busy ? "正在保存…" : "应用"}</button><button type="button" class="personalization-button" disabled={!snapshot.dirty || snapshot.busy} onclick={() => controller.cancel()}>取消</button><button type="button" class="personalization-button" disabled={snapshot.busy} onclick={restoreDefaults}>恢复默认</button>
          </form>
          <p class="personalization-save-status" data-personalization-status={snapshot.presentation.state} role="status" aria-live="polite">{snapshot.message}</p>
        </div>
      </section>
    </div>
  </section>
</section>
