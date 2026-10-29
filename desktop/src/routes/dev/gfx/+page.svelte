<script lang="ts">
  import { onMount } from "svelte";

  import Segmented from "#lib/components/segmented.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { createCanvas2DSprites } from "#lib/gfx/bench/canvas2d.ts";
  import {
    createSpriteField,
    parseHexColor,
    resizeSpriteField,
    stepSpriteField,
    type Rgb,
    type SpriteField,
  } from "#lib/gfx/bench/sprites.ts";
  import { createWebGL2Sprites } from "#lib/gfx/bench/webgl2.ts";
  import { createFpsMeter } from "#lib/gfx/fps.ts";
  import { createGfxHost, type GfxHost } from "#lib/gfx/host.ts";
  import {
    readPreference,
    writePreference,
    type RendererChoice,
    type RendererPreference,
    type RendererReason,
    type WebGL2Support,
  } from "#lib/gfx/renderer.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 开发用的渲染基准：5000 个方块，看两种渲染器在这台机器上的帧率，以及回退是否正常。
  const SPRITE_COUNT = 5000;
  // 不含金色：金色只给选中态和主操作。
  const PALETTE_VARS = ["--tag-copyright", "--tag-artist", "--tag-general", "--tag-rating", "--tag-meta"];
  const FALLBACK_COLOR: Rgb = [207, 204, 197];

  let stage: HTMLDivElement;
  let host: GfxHost<SpriteField> | null = null;
  let preference = $state<RendererPreference>(readPreference());
  let choice = $state<RendererChoice | null>(null);
  let support = $state<WebGL2Support | null>(null);
  let fps = $state<number | null>(null);
  let frameMs = $state<number | null>(null);

  const REASONS: Record<RendererReason, () => string> = {
    auto: m.gfx_reason_auto,
    forced: m.gfx_reason_forced,
    unsupported: m.gfx_reason_unsupported,
    software: m.gfx_reason_software,
    context_lost: m.gfx_reason_context_lost,
    init_failed: m.gfx_reason_init_failed,
  };

  const supportLevel = $derived(
    support === null ? null : support.accelerated ? "accelerated" : support.available ? "software" : "none",
  );
  const SUPPORT: Record<"accelerated" | "software" | "none", () => string> = {
    accelerated: m.gfx_support_accelerated,
    software: m.gfx_support_software,
    none: m.gfx_support_none,
  };

  const kindLabel = (kind: RendererChoice["kind"]) => (kind === "webgl2" ? m.gfx_pref_webgl2() : m.gfx_pref_canvas2d());

  function choose(next: RendererPreference) {
    preference = next;
    writePreference(next);
    host?.setPreference(next);
  }

  function loseContext() {
    host?.loseContext();
  }

  useBindings("page", () => [
    { id: "gfx.auto", keys: "1", label: m.gfx_use_auto, group: m.nav_gfx, run: () => choose("auto"), palette: true },
    { id: "gfx.webgl2", keys: "2", label: m.gfx_use_webgl2, group: m.nav_gfx, run: () => choose("webgl2"), palette: true },
    { id: "gfx.canvas2d", keys: "3", label: m.gfx_use_canvas2d, group: m.nav_gfx, run: () => choose("canvas2d"), palette: true },
    {
      id: "gfx.lose",
      label: m.gfx_lose_context,
      group: m.nav_gfx,
      run: loseContext,
      when: () => choice?.kind === "webgl2",
      palette: true,
      keywords: ["webglcontextlost"],
    },
  ]);

  onMount(() => {
    const styles = getComputedStyle(document.documentElement);
    const palette = PALETTE_VARS.map((name) => parseHexColor(styles.getPropertyValue(name)) ?? FALLBACK_COLOR);
    const bounds = stage.getBoundingClientRect();
    const field = createSpriteField({ count: SPRITE_COUNT, width: bounds.width, height: bounds.height, palette });
    const meter = createFpsMeter();

    const gfx = createGfxHost<SpriteField>({
      container: stage,
      backends: { webgl2: createWebGL2Sprites, canvas2d: createCanvas2DSprites },
      preference,
      onChange(next) {
        choice = next;
        meter.reset();
        fps = null;
        frameMs = null;
      },
      onError: (error) => console.warn("[gfx] WebGL2 backend failed", error),
    });
    host = gfx;
    support = gfx.support;

    const resize = () => {
      const { width, height } = stage.getBoundingClientRect();
      resizeSpriteField(field, width, height);
      gfx.resize(width, height, window.devicePixelRatio || 1);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    let last: number | null = null;
    let frame = 0;
    const loop = (now: number) => {
      stepSpriteField(field, last === null ? 0 : (now - last) / 1000);
      last = now;
      gfx.draw(field);
      if (meter.tick(now) !== null) {
        fps = meter.fps;
        frameMs = meter.frameMs;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      gfx.destroy();
      host = null;
    };
  });
</script>

<PageHeader title={m.nav_gfx()} subtitle={m.gfx_subtitle({ count: SPRITE_COUNT })}>
  {#snippet actions()}
    <Button
      variant="outline"
      size="sm"
      onclick={loseContext}
      disabled={choice?.kind !== "webgl2"}
      data-testid="gfx-lose"
    >
      {m.gfx_lose_context()}
    </Button>
  {/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-7 py-2.5 text-xs" data-testid="gfx-panel">
  <div class="flex items-center gap-2">
    <span class="text-fg2">{m.gfx_preference()}</span>
    <Segmented
      size="sm"
      label={m.gfx_preference()}
      data-testid="gfx-preference"
      value={preference}
      options={[
        { value: "auto", label: m.gfx_pref_auto() },
        { value: "webgl2", label: m.gfx_pref_webgl2() },
        { value: "canvas2d", label: m.gfx_pref_canvas2d() },
      ]}
      onchange={choose}
    />
  </div>
  <dl class="flex flex-wrap items-center gap-x-6 gap-y-1">
    <div class="flex gap-2">
      <dt class="text-fg3">{m.gfx_active()}</dt>
      <dd data-testid="gfx-renderer" data-kind={choice?.kind} data-reason={choice?.reason}>
        {#if choice}
          <span class="text-fg">{kindLabel(choice.kind)}</span>
          <span class="text-fg3">· {REASONS[choice.reason]()}</span>
        {/if}
      </dd>
    </div>
    <div class="flex gap-2">
      <dt class="text-fg3">{m.gfx_support()}</dt>
      <dd data-testid="gfx-support" data-support={supportLevel}>{supportLevel ? SUPPORT[supportLevel]() : ""}</dd>
    </div>
    {#if support?.renderer}
      <div class="flex min-w-0 gap-2">
        <dt class="text-fg3">{m.gfx_gpu()}</dt>
        <dd class="max-w-[42ch] truncate font-mono text-2xs leading-[18px]" title={support.renderer} data-testid="gfx-gpu">
          {support.renderer}
        </dd>
      </div>
    {/if}
    <div class="flex gap-2">
      <dt class="text-fg3">{m.gfx_fps()}</dt>
      <dd class="tabular-nums" data-testid="gfx-fps" data-fps={fps === null ? undefined : Math.round(fps)}>
        {fps === null || frameMs === null
          ? m.gfx_measuring()
          : m.gfx_fps_value({ fps: Math.round(fps), ms: frameMs.toFixed(1) })}
      </dd>
    </div>
    <div class="flex gap-2">
      <dt class="text-fg3">{m.gfx_sprites()}</dt>
      <dd class="tabular-nums" data-testid="gfx-count">{SPRITE_COUNT}</dd>
    </div>
  </dl>
  <p class="text-2xs text-fg3">{m.gfx_saved_hint()}</p>
</div>

<div
  bind:this={stage}
  class="relative min-h-0 flex-1 overflow-hidden [&>canvas]:absolute [&>canvas]:inset-0 [&>canvas]:block [&>canvas]:size-full"
  data-testid="gfx-stage"
></div>
