<script lang="ts">
  import PagePlaceholder from "#lib/components/shell/page-placeholder.svelte";
  import { m } from "#lib/paraglide/messages.js";
</script>

<!-- 标题和阶段导航在 ../+layout.svelte；这里只放阶段内容。 -->
<PagePlaceholder title={m.stage_clean()} header={false} />
