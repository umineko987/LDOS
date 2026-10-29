<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  import PageHeader from "./page-header.svelte";

  // Phase 1 占位页：标题 + 一句说明。Wave 2 把整个文件换成真实页面。
  let { title, hint = m.page_placeholder(), header = true }: { title: string; hint?: string; header?: boolean } =
    $props();
</script>

{#if header}<PageHeader {title} />{/if}
<div class="flex-1 overflow-auto px-7 py-5" data-testid="page-placeholder" data-page-title={title}>
  <p class="max-w-[60ch] text-sm text-fg3">{hint}</p>
</div>
