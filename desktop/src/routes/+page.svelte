<script lang="ts">
  import LocaleSwitch from "#lib/components/shell/locale-switch.svelte";
  import { m } from "#lib/paraglide/messages.js";
</script>

<main class="flex items-baseline gap-2 p-7">
  <h1 class="text-lg font-semibold">{m.app_name()}</h1>
  <span class="text-2xs text-fg3">{m.app_tagline()}</span>
  <LocaleSwitch class="ml-auto" />
</main>
