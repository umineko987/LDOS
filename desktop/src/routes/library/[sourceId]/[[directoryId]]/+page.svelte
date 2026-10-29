<script lang="ts">
  import { page } from "$app/state";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import PagePlaceholder from "#lib/components/shell/page-placeholder.svelte";
  import { m } from "#lib/paraglide/messages.js";

  const source = $derived(page.params.sourceId ?? "");
  const directory = $derived(page.params.directoryId);
</script>

<PageHeader
  title={m.page_library_source({ source })}
  subtitle={directory ? m.page_library_directory({ directory }) : undefined}
/>
<PagePlaceholder title={m.nav_library()} header={false} />
