<script lang="ts">
  import type { SceneId } from "../core/persistence/service";

  let { scene }: { scene: SceneId } = $props();
</script>

<div class="wallpaper wallpaper--{scene}" data-wallpaper data-scene={scene} aria-hidden="true">
</div>
