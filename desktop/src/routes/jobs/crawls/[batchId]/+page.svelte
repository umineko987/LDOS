<script lang="ts">
  import { page } from "$app/state";
  import PagePlaceholder from "#lib/components/shell/page-placeholder.svelte";
  import { m } from "#lib/paraglide/messages.js";

  const batch = $derived(page.params.batchId ?? "");
</script>

<PagePlaceholder title={m.page_crawl_batch({ batch })} />
