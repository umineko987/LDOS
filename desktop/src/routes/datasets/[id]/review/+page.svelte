<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  // Keep old bookmarks usable; manual review now lives on gallery sources.
  onMount(() => {
    if (page.params.id) void goto(resolve("/datasets/[id]/export", { id: page.params.id }), { replace: true });
  });
</script>
