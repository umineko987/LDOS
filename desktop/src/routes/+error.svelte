<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { m } from "#lib/paraglide/messages.js";
</script>

<PageHeader title={m.page_not_found()} subtitle={page.status === 404 ? undefined : String(page.status)} />
<div class="px-7 py-5" data-testid="not-found">
  <Button href={resolve("/")} variant="outline" size="sm">{m.page_not_found_back()}</Button>
</div>
