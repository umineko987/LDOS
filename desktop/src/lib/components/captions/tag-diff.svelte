<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 一张图的标签改动：去掉的划线标红，加上的标绿。太多时只列前几个，其余合成「还有 N 个」。
  let {
    added,
    removed,
    limit = 12,
    class: className,
  }: {
    added: readonly string[];
    removed: readonly string[];
    limit?: number;
    class?: string;
  } = $props();

  const shownRemoved = $derived(removed.slice(0, limit));
  const shownAdded = $derived(added.slice(0, Math.max(0, limit - shownRemoved.length)));
  const rest = $derived(added.length + removed.length - shownRemoved.length - shownAdded.length);
</script>

<p class={cn("flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-2xs", className)}>
  {#each shownRemoved as tag (tag)}
    <span class="text-danger line-through" data-diff="removed">−{tag}</span>
  {/each}
  {#each shownAdded as tag (tag)}
    <span class="text-ok" data-diff="added">+{tag}</span>
  {/each}
  {#if rest > 0}<span class="text-fg3">{m.captions_diff_more({ count: rest })}</span>{/if}
  {#if !added.length && !removed.length}<span class="text-fg3">{m.captions_diff_none()}</span>{/if}
</p>
