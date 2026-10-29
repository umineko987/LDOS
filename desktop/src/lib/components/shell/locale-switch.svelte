<script lang="ts">
  import Segmented from "#lib/components/segmented.svelte";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import type { Locale } from "#lib/paraglide/runtime.js";

  let { class: className }: { class?: string } = $props();

  const labels: Record<Locale, () => string> = {
    "zh-CN": m.locale_zh_cn,
    en: m.locale_en,
  };
</script>

<Segmented
  label={m.locale_switch()}
  data-testid="locale-switch"
  class={className}
  value={i18n.current}
  options={i18n.available.map((locale) => ({ value: locale, label: labels[locale](), lang: locale }))}
  onchange={(locale) => i18n.set(locale)}
/>
