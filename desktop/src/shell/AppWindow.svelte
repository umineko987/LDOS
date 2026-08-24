<script lang="ts">
  import { getApplicationDefinition, type ApplicationId } from "../core/applications/definitions";
  import type { WindowRecord } from "../core/state/shell";
  import type { ResizeDirection } from "../core/windowing/geometry";
  import type { WindowInteractionMode } from "../core/windowing/interaction";
  import ApplicationPlaceholder from "./ApplicationPlaceholder.svelte";

  interface Props {
    record: WindowRecord;
    focused: boolean;
    onFocus: (appId: ApplicationId) => void;
    onMinimize: (appId: ApplicationId) => void;
    onToggleMaximized: (appId: ApplicationId) => void;
    onClose: (appId: ApplicationId) => void;
    onBeginInteraction: (appId: ApplicationId, mode: WindowInteractionMode, event: PointerEvent) => void;
    onKeyboardResize: (appId: ApplicationId, direction: ResizeDirection, event: KeyboardEvent) => void;
  }

  let {
    record,
    focused,
    onFocus,
    onMinimize,
    onToggleMaximized,
    onClose,
    onBeginInteraction,
    onKeyboardResize,
  }: Props = $props();
  const application = $derived(getApplicationDefinition(record.appId));
  const titleId = $derived(`window-title-${record.appId}`);
  const style = $derived(record.state === "maximized"
    ? "left:0;top:0;width:100%;height:100%"
    : `left:${record.rect.x}px;top:${record.rect.y}px;width:${record.rect.w}px;height:${record.rect.h}px`);

  function beginMove(event: PointerEvent): void {
    if (record.state !== "normal" || (event.target instanceof Element && event.target.closest(".traffic-lights"))) return;
    onBeginInteraction(record.appId, "move", event);
  }
</script>

<section
  class="app-window"
  data-app-window
  data-app-id={record.appId}
  data-window-state={record.state}
  data-window-focused={focused ? "" : undefined}
  data-maximized={record.state === "maximized" ? "" : undefined}
  style={style}
  role="group"
  aria-labelledby={titleId}
  onpointerdown={() => onFocus(record.appId)}
>
  <header
    class="app-window__titlebar"
    data-window-titlebar
    role="toolbar"
    aria-label={`${application.title} 窗口标题栏`}
    tabindex="-1"
    onpointerdown={beginMove}
  >
    <div class="traffic-lights" aria-label="窗口操作">
      <button
        type="button"
        class="traffic-light traffic-light--close"
        aria-label="关闭窗口"
        title="关闭窗口"
        onclick={() => onClose(record.appId)}
      ><span aria-hidden="true"></span></button>
      <button
        type="button"
        class="traffic-light traffic-light--minimize"
        aria-label="最小化窗口"
        title="最小化窗口"
        onclick={() => onMinimize(record.appId)}
      ><span aria-hidden="true"></span></button>
      <button
        type="button"
        class="traffic-light traffic-light--maximize"
        aria-label={record.state === "maximized" ? "还原窗口" : "最大化窗口"}
        aria-pressed={record.state === "maximized"}
        title={record.state === "maximized" ? "还原窗口" : "最大化窗口"}
        onclick={() => onToggleMaximized(record.appId)}
      ><span aria-hidden="true"></span></button>
    </div>
    <strong id={titleId}>{application.title}</strong>
    <span class="app-window__title-balance" aria-hidden="true"></span>
  </header>

  <main class="app-window__body" data-window-body tabindex="-1">
    <ApplicationPlaceholder {application} />
  </main>

  <button
    type="button"
    class="resize-handle resize-handle--right"
    data-resize="right"
    aria-label="调整窗口宽度；使用左右方向键微调"
    onpointerdown={(event) => onBeginInteraction(record.appId, "right", event)}
    onkeydown={(event) => onKeyboardResize(record.appId, "right", event)}
  ></button>
  <button
    type="button"
    class="resize-handle resize-handle--bottom"
    data-resize="bottom"
    aria-label="调整窗口高度；使用上下方向键微调"
    onpointerdown={(event) => onBeginInteraction(record.appId, "bottom", event)}
    onkeydown={(event) => onKeyboardResize(record.appId, "bottom", event)}
  ></button>
  <button
    type="button"
    class="resize-handle resize-handle--corner"
    data-resize="corner"
    aria-label="调整窗口宽度和高度；使用方向键微调"
    onpointerdown={(event) => onBeginInteraction(record.appId, "corner", event)}
    onkeydown={(event) => onKeyboardResize(record.appId, "corner", event)}
  ></button>
</section>
