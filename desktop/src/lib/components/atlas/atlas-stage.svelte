<script lang="ts">
  import { onMount } from "svelte";

  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { FLAG_HIDDEN, FLAG_REMOVED, type AtlasModel, type SelectMode } from "#lib/domain/atlas-model.ts";
  import type { AtlasTool } from "#lib/domain/atlas-ops.ts";
  import {
    focusOn,
    HOME_CAMERA,
    keyPan,
    lodMode,
    panBy,
    pixelsPerUnit,
    POINT_RADIUS,
    screenToWorld,
    SPRITE_ZOOM_EXIT,
    spriteSize,
    visibleWorldRect,
    wheelFactor,
    worldToScreen,
    zoomAt,
    type Camera,
    type LodMode,
    type Viewport,
  } from "#lib/domain/atlas-view.ts";
  import { appendLassoPoint, selectInPolygon, simplifyPolyline, type Point } from "#lib/domain/lasso.ts";
  import { buildQuadtree } from "#lib/domain/quadtree.ts";
  import { createCanvas2DAtlas } from "#lib/gfx/atlas/canvas2d.ts";
  import {
    CLUSTER_PALETTE,
    clusterColorIndex,
    neededSheets,
    readSceneColors,
    rgbCss,
    spriteOrder,
    type SceneColors,
  } from "#lib/gfx/atlas/scene.ts";
  import { createSheetCache, fetchBitmap, type SheetCache } from "#lib/gfx/atlas/sheets.ts";
  import { createWebGL2Atlas } from "#lib/gfx/atlas/webgl2.ts";
  import { createGfxHost, type GfxHost } from "#lib/gfx/host.ts";
  import { readPreference, type RendererChoice, type RendererReason } from "#lib/gfx/renderer.ts";
  import type { AtlasScene } from "#lib/gfx/atlas/scene.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 地图画布：渲染器、平移缩放、悬停、点选和套索。选择状态由页面持有，这里只报告“选了哪些点”。
  // 没有每帧循环：相机、数据、状态位或雪碧图有变化时才排一帧。悬停圈、套索和提示是 DOM 叠层，不触发重画。

  interface Props {
    model: AtlasModel;
    flags: Uint8Array;
    tool: AtlasTool;
    ontool: (tool: AtlasTool) => void;
    onselect: (indices: number[], mode: SelectMode) => void;
    /** 把雪碧图的 API 路径变成完整 URL。 */
    resolveUrl: (path: string) => string;
    thumbnailUrl: (index: number) => string;
    clusterLabel: (cluster: number) => string;
  }

  let { model, flags, tool, ontool, onselect, resolveUrl, thumbnailUrl, clusterLabel }: Props = $props();

  const EMPTY = new Int32Array(0);
  const HOVER_SLOP = 3;
  const DRAG_THRESHOLD = 3;

  let stage: HTMLDivElement;
  let layer: HTMLDivElement;
  let host: GfxHost<AtlasScene> | null = null;
  let colors: SceneColors | null = null;
  let sheets: SheetCache | null = null;
  let sheetsKey = "";
  let raf = 0;

  let camera = $state.raw<Camera>(HOME_CAMERA);
  let viewport = $state.raw<Viewport>({ width: 0, height: 0 });
  let mode = $state<LodMode>("points");
  let choice = $state<RendererChoice | null>(null);
  let frames = $state(0);
  let hover = $state(-1);
  let lasso = $state.raw<Point[] | null>(null);
  let dragging = $state(false);

  let drag: {
    readonly id: number;
    readonly x: number;
    readonly y: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    readonly lasso: boolean;
    readonly mode: SelectMode;
  } | null = null;

  const tree = $derived(buildQuadtree(model.positions));
  const visibleCount = $derived.by(() => {
    let visible = 0;
    for (const flag of flags) if (!(flag & FLAG_HIDDEN)) visible += 1;
    return visible;
  });

  const REASONS: Record<RendererReason, () => string> = {
    auto: m.gfx_reason_auto,
    forced: m.gfx_reason_forced,
    unsupported: m.gfx_reason_unsupported,
    software: m.gfx_reason_software,
    context_lost: m.gfx_reason_context_lost,
    init_failed: m.gfx_reason_init_failed,
  };

  const shown = (index: number) => !(flags[index]! & FLAG_HIDDEN);

  function sheetCache(): SheetCache | null {
    const key = model.sheets?.urls.join("\n") ?? "";
    if (key !== sheetsKey) {
      sheets?.destroy();
      sheetsKey = key;
      sheets = model.sheets
        ? createSheetCache({
            urls: model.sheets.urls.map(resolveUrl),
            load: (url, signal) => fetchBitmap(url, signal),
            onLoad: schedule,
            onError: (error) => console.warn("[atlas] sprite sheet failed", error),
          })
        : null;
    }
    return sheets;
  }

  function schedule() {
    if (!raf && host) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (!host || !colors || viewport.width <= 0 || viewport.height <= 0) return;
    const cache = sheetCache();
    const size = spriteSize(camera.k);
    let next: LodMode = "points";
    let sprites: Int32Array = EMPTY;
    // 只有放大到阈值附近才查视野：缩小时整张图都在视野里，没必要每帧列一遍。
    if (model.sheets && camera.k >= SPRITE_ZOOM_EXIT) {
      const rect = visibleWorldRect(camera, viewport, size);
      const visible = tree.queryRect(rect.minX, rect.minY, rect.maxX, rect.maxY).filter(shown);
      next = lodMode(camera.k, mode, visible.length, true);
      if (next === "sprites") {
        sprites = spriteOrder(model, flags, visible);
        cache?.request(neededSheets(model, sprites));
      }
    }
    mode = next;
    host.draw({
      model,
      flags,
      camera,
      mode: next,
      sprites,
      spriteSize: size,
      sheet: (index) => cache?.get(index) ?? null,
      sheetsVersion: cache?.version ?? 0,
      palette: CLUSTER_PALETTE,
      colors,
    });
    frames += 1;
  }

  $effect(() => {
    void camera;
    void viewport;
    void model;
    void flags;
    schedule();
  });

  function local(event: { clientX: number; clientY: number }): [number, number] {
    const bounds = stage.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  function hit(x: number, y: number): number {
    const [wx, wy] = screenToWorld(camera, viewport, x, y);
    const reach = mode === "sprites" ? spriteSize(camera.k) / 2 : POINT_RADIUS + HOVER_SLOP;
    return tree.nearest(wx, wy, reach / pixelsPerUnit(camera, viewport), shown);
  }

  function selectMode(event: PointerEvent): SelectMode {
    if (event.shiftKey) return "add";
    return event.ctrlKey || event.metaKey ? "toggle" : "replace";
  }

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0) return;
    // 按键注册表在输入框里不响应单键；点画布时让输入框（如“保留 N 张”）失焦，V、L、X 才能用。
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    const [x, y] = local(event);
    const lassoing = tool === "lasso" || event.shiftKey;
    drag = { id: event.pointerId, x, y, lastX: x, lastY: y, moved: false, lasso: lassoing, mode: selectMode(event) };
    stage.setPointerCapture?.(event.pointerId);
    if (lassoing) lasso = [[x, y]];
    hover = -1;
  }

  function onpointermove(event: PointerEvent) {
    const [x, y] = local(event);
    if (!drag) {
      hover = hit(x, y);
      return;
    }
    if (event.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < DRAG_THRESHOLD) return;
    drag.moved = true;
    if (drag.lasso) {
      const points = [...(lasso ?? [])];
      if (appendLassoPoint(points, [x, y])) lasso = points;
    } else {
      dragging = true;
      camera = panBy(camera, viewport, x - drag.lastX, y - drag.lastY);
    }
    drag.lastX = x;
    drag.lastY = y;
  }

  function onpointerup(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const [x, y] = local(event);
    const done = drag;
    drag = null;
    dragging = false;
    const path = lasso;
    lasso = null;
    if (done.lasso && done.moved && path && path.length >= 3) {
      const polygon = simplifyPolyline(path, 1.5).map(([sx, sy]) => screenToWorld(camera, viewport, sx, sy));
      onselect(selectInPolygon(polygon, tree, model.positions, shown), done.mode);
    } else if (!done.moved) {
      const index = hit(x, y);
      if (index >= 0) onselect([index], done.mode === "replace" ? "replace" : "toggle");
      else if (done.mode === "replace") onselect([], "replace");
    }
    hover = hit(x, y);
  }

  function onpointercancel() {
    drag = null;
    dragging = false;
    lasso = null;
  }

  function onwheel(event: WheelEvent) {
    event.preventDefault();
    const [x, y] = local(event);
    camera = zoomAt(camera, viewport, x, y, wheelFactor(event.deltaY, event.deltaMode));
    hover = -1;
  }

  export function reset() {
    camera = HOME_CAMERA;
  }

  export function zoom(factor: number) {
    camera = zoomAt(camera, viewport, viewport.width / 2, viewport.height / 2, factor);
  }

  export function pan(dx: number, dy: number) {
    camera = keyPan(camera, viewport, dx, dy);
  }

  /** 把视图移到某张图上，放大到能看清缩略图。 */
  export function focus(index: number) {
    if (index < 0 || index >= model.count) return;
    camera = focusOn(model.positions[index * 2]!, model.positions[index * 2 + 1]!, Math.max(4, camera.k));
  }

  onMount(() => {
    const styles = getComputedStyle(document.documentElement);
    colors = readSceneColors((name) => styles.getPropertyValue(name));
    const gfx = createGfxHost<AtlasScene>({
      container: layer,
      backends: { webgl2: createWebGL2Atlas, canvas2d: createCanvas2DAtlas },
      preference: readPreference(),
      // 只在有变化时重画，所以要保留绘制缓冲：合成器随时可能再读它。
      webgl2Attributes: {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      },
      createCanvas: () => {
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
        return canvas;
      },
      onChange(next) {
        choice = next;
        schedule();
      },
      onError: (error) => console.warn("[atlas] WebGL2 backend failed", error),
    });
    host = gfx;

    const resize = () => {
      const { width, height } = stage.getBoundingClientRect();
      gfx.resize(width, height, window.devicePixelRatio || 1);
      viewport = { width, height };
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    stage.addEventListener("wheel", onwheel, { passive: false });
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      stage.removeEventListener("wheel", onwheel);
      gfx.destroy();
      host = null;
      sheets?.destroy();
      sheets = null;
      sheetsKey = "";
    };
  });

  const hoverAt = $derived.by(() => {
    if (hover < 0 || hover >= model.count || lasso || dragging) return null;
    const [x, y] = worldToScreen(camera, viewport, model.positions[hover * 2]!, model.positions[hover * 2 + 1]!);
    return { x, y, index: hover };
  });
  const ringSize = $derived(mode === "sprites" ? spriteSize(camera.k) + 6 : (POINT_RADIUS + 3) * 2);
  // 提示框放在指向的点右下方，靠近右边或底边时翻到另一侧。
  const TIP_WIDTH = 168;
  const TIP_HEIGHT = 212;
  const tipX = $derived(hoverAt ? (hoverAt.x + 16 + TIP_WIDTH > viewport.width ? hoverAt.x - 16 - TIP_WIDTH : hoverAt.x + 16) : 0);
  const tipY = $derived(
    hoverAt ? Math.max(8, Math.min(viewport.height - TIP_HEIGHT - 8, hoverAt.y + 16)) : 0,
  );
  const lassoPath = $derived(lasso ? lasso.map(([x, y]) => `${x},${y}`).join(" ") : "");
</script>

<div
  bind:this={stage}
  role="application"
  aria-label={m.atlas_stage_label()}
  aria-roledescription={m.atlas_title()}
  class="relative min-h-0 min-w-0 touch-none overflow-hidden bg-bg0 outline-none select-none {tool === 'lasso'
    ? 'cursor-crosshair'
    : dragging
      ? 'cursor-grabbing'
      : 'cursor-grab'}"
  data-testid="atlas-stage"
  data-mode={mode}
  data-tool={tool}
  data-frames={frames}
  data-visible={visibleCount}
  data-zoom={camera.k.toFixed(2)}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onpointercancel}
  onpointerleave={() => {
    if (!drag) hover = -1;
  }}
>
  <div bind:this={layer} class="absolute inset-0"></div>

  {#if hoverAt}
    <div
      class="pointer-events-none absolute top-0 left-0 border border-fg {mode === 'sprites' ? 'rounded-sm' : 'rounded-full'}"
      style:width="{ringSize}px"
      style:height="{ringSize}px"
      style:transform="translate({hoverAt.x - ringSize / 2}px, {hoverAt.y - ringSize / 2}px)"
      aria-hidden="true"
    ></div>
    <div
      class="pointer-events-none absolute top-0 left-0 flex w-[168px] flex-col gap-1.5 rounded-md border border-line2 bg-bg2 p-1.5 shadow-over"
      style:transform="translate({tipX}px, {tipY}px)"
      data-testid="atlas-tooltip"
      data-asset={model.ids[hoverAt.index]}
    >
      <img
        src={thumbnailUrl(hoverAt.index)}
        alt=""
        class="aspect-square w-full rounded-sm bg-bg3 object-cover"
        onerror={(event) => ((event.currentTarget as HTMLImageElement).style.visibility = "hidden")}
      />
      <div class="flex items-center gap-1.5 px-0.5 text-2xs">
        <span
          class="inline-block size-2 shrink-0 rounded-full"
          style:background={rgbCss(CLUSTER_PALETTE[clusterColorIndex(model.clusters[hoverAt.index]!, CLUSTER_PALETTE.length)]!)}
        ></span>
        <span class="truncate text-fg2">{clusterLabel(model.clusters[hoverAt.index]!)}</span>
        <span class="grow"></span>
        {#if flags[hoverAt.index]! & FLAG_REMOVED}
          <span class="text-fg3">{m.atlas_removed_badge()}</span>
        {:else}
          <span class="text-fg3 tabular-nums">{m.atlas_outlier_score({ score: model.outlier[hoverAt.index]!.toFixed(2) })}</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if lasso}
    <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
      <polygon points={lassoPath} class="fill-gold-12 stroke-gold" stroke-width="1" stroke-dasharray="4 3" />
    </svg>
  {/if}

  <div class="absolute top-3 left-3.5 flex items-center gap-1.5" onpointerdown={(event) => event.stopPropagation()} role="toolbar" tabindex="-1" aria-label={m.atlas_tools()}>
    <Segmented
      size="sm"
      class="bg-bg1"
      label={m.atlas_tools()}
      value={tool}
      options={[
        { value: "pan", label: `${m.atlas_tool_pan()} · V` },
        { value: "lasso", label: `${m.atlas_tool_lasso()} · L` },
      ]}
      onchange={ontool}
      data-testid="atlas-tool"
    />
    <Button variant="ghost" size="sm" onclick={reset} data-testid="atlas-reset">
      {m.atlas_reset()}
      <Kbd>0</Kbd>
    </Button>
  </div>

  <div class="pointer-events-none absolute bottom-3 left-3.5 text-2xs text-fg3 tabular-nums" data-testid="atlas-zoom">
    {mode === "sprites"
      ? m.atlas_zoom_sprites({ zoom: camera.k.toFixed(1) })
      : m.atlas_zoom_points({ zoom: camera.k.toFixed(1) })}
  </div>

  {#if choice}
    <div
      class="pointer-events-none absolute right-3.5 bottom-3 text-2xs text-fg3"
      data-testid="atlas-renderer"
      data-kind={choice.kind}
      data-reason={choice.reason}
      title={REASONS[choice.reason]()}
    >
      {m.atlas_renderer({ kind: choice.kind === "webgl2" ? m.gfx_pref_webgl2() : m.gfx_pref_canvas2d() })}
      {#if choice.reason !== "auto" && choice.reason !== "forced"}<span>· {REASONS[choice.reason]()}</span>{/if}
    </div>
  {/if}
</div>
