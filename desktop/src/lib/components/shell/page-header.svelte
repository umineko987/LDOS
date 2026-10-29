<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "#lib/utils.ts";

  // 页面标题栏。`actions` 放在右侧（主操作用 Button variant="primary"，每页至多一个）。
  let {
    title,
    subtitle,
    actions,
    children,
    class: className,
  }: { title: string; subtitle?: string; actions?: Snippet; children?: Snippet; class?: string } = $props();
</script>

<header class={cn("flex flex-col border-b border-line px-7 pt-4 pb-3.5", className)}>
  <div class="flex min-h-control items-center gap-3">
    <h1 class="truncate text-lg font-semibold tracking-[0.01em]">{title}</h1>
    {#if subtitle}<span class="truncate text-xs text-fg3">{subtitle}</span>{/if}
    {#if actions}<div class="ml-auto flex items-center gap-2">{@render actions()}</div>{/if}
  </div>
  {@render children?.()}
</header>
