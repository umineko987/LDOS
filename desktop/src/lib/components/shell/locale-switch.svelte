<script lang="ts">
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import type { Locale } from "#lib/paraglide/runtime.js";
  import { cn } from "#lib/utils.ts";

  let { class: className }: { class?: string } = $props();

  const labels: Record<Locale, () => string> = {
    "zh-CN": m.locale_zh_cn,
    en: m.locale_en,
  };
</script>

<div
  role="group"
  aria-label={m.locale_switch()}
  data-testid="locale-switch"
  class={cn("inline-flex overflow-hidden rounded-[5px] border border-line", className)}
>
  {#each i18n.available as locale (locale)}
    <button
      type="button"
      lang={locale}
      aria-pressed={i18n.current === locale}
      class="px-2 py-0.5 text-2xs text-fg3 transition-colors hover:text-fg2 aria-pressed:bg-bg3 aria-pressed:text-fg"
      onclick={() => i18n.set(locale)}
    >
      {labels[locale]()}
    </button>
  {/each}
</div>
