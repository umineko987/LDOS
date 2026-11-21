<script lang="ts">
  import { page } from "$app/state";
  import GalleryStudio from "#lib/components/studio/gallery-studio.svelte";
  import { galleryStudioDirectory } from "#lib/components/studio/gallery-studio-state.ts";

  const sourceId = $derived(page.params.sourceId!);
  const directoryId = $derived(galleryStudioDirectory(page.url.hash));
</script>

{#key JSON.stringify([sourceId, directoryId])}
  <GalleryStudio {sourceId} {directoryId} />
{/key}
