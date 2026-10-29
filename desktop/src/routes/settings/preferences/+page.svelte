<script lang="ts">
  import Segmented from "#lib/components/segmented.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import type { RendererPreference } from "#lib/gfx/renderer.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import type { Locale } from "#lib/paraglide/runtime.js";
  import { prefs } from "#lib/prefs/prefs.svelte.ts";
  import type { Density, MotionPreference } from "#lib/prefs/prefs.ts";

  // 偏好：语言、减少动效、密度、地图渲染器。全部只存在本机，立即生效。
  const LOCALES: Record<Locale, () => string> = { "zh-CN": m.prefs_language_zh_cn, en: m.prefs_language_en };

  const motionOptions = $derived<{ value: MotionPreference; label: string }[]>([
    { value: "system", label: m.prefs_motion_system() },
    { value: "on", label: m.prefs_motion_on() },
    { value: "off", label: m.prefs_motion_off() },
  ]);
  const densityOptions = $derived<{ value: Density; label: string }[]>([
    { value: "compact", label: m.prefs_density_compact() },
    { value: "comfortable", label: m.prefs_density_comfortable() },
  ]);
  const rendererOptions = $derived<{ value: RendererPreference; label: string }[]>([
    { value: "auto", label: m.prefs_renderer_auto() },
    { value: "webgl2", label: "WebGL2" },
    { value: "canvas2d", label: "Canvas2D" },
  ]);

  const motionHint = $derived(
    prefs.motion === "system"
      ? prefs.systemReducedMotion
        ? m.prefs_motion_hint_system_reduced()
        : m.prefs_motion_hint_system_full()
      : prefs.motion === "on"
        ? m.prefs_motion_hint_on()
        : m.prefs_motion_hint_off(),
  );
</script>

<PageHeader title={m.nav_settings_preferences()} subtitle={m.prefs_subtitle()} />

<div class="flex max-w-[860px] flex-col px-7 py-5" data-testid="preferences">
  <dl class="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 border-t border-line">
    <dt class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2">{m.prefs_language()}</dt>
    <dd class="flex min-h-row flex-col justify-center gap-1 border-b border-line py-2.5">
      <Segmented
        size="sm"
        label={m.prefs_language()}
        data-pref="language"
        value={i18n.current}
        options={i18n.available.map((locale) => ({ value: locale, label: LOCALES[locale](), lang: locale }))}
        onchange={(locale) => i18n.set(locale)}
        class="self-start"
      />
    </dd>

    <dt class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2">{m.prefs_motion()}</dt>
    <dd class="flex min-h-row flex-col justify-center gap-1 border-b border-line py-2.5">
      <Segmented
        size="sm"
        label={m.prefs_motion()}
        data-pref="motion"
        value={prefs.motion}
        options={motionOptions}
        onchange={(value) => prefs.setMotion(value)}
        class="self-start"
      />
      <p class="text-2xs text-fg3" data-testid="prefs-motion-hint">{motionHint}</p>
    </dd>

    <dt class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2">{m.prefs_density()}</dt>
    <dd class="flex min-h-row flex-col justify-center gap-1 border-b border-line py-2.5">
      <Segmented
        size="sm"
        label={m.prefs_density()}
        data-pref="density"
        value={prefs.density}
        options={densityOptions}
        onchange={(value) => prefs.setDensity(value)}
        class="self-start"
      />
    </dd>

    <dt class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2">{m.prefs_renderer()}</dt>
    <dd class="flex min-h-row flex-col justify-center gap-1 border-b border-line py-2.5">
      <Segmented
        size="sm"
        label={m.prefs_renderer()}
        data-pref="renderer"
        value={prefs.renderer}
        options={rendererOptions}
        onchange={(value) => prefs.setRenderer(value)}
        class="self-start"
      />
      <p class="text-2xs text-fg3">{m.prefs_renderer_hint()}</p>
    </dd>
  </dl>
</div>
