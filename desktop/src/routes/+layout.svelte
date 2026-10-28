<script lang="ts">
  import "../app.css";
  import { i18n, syncDocumentLang } from "#lib/i18n/locale.svelte.ts";

  let { children } = $props();

  syncDocumentLang(i18n.current);
</script>

{#key i18n.current}
  <div data-app-ready>
    {@render children()}
  </div>
{/key}
