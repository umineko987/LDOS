<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes } from "svelte/elements";

  import { cn } from "#lib/utils.ts";

  let {
    active = false,
    class: className,
    children,
    trailing,
    ...rest
  }: HTMLAnchorAttributes & { active?: boolean; children: Snippet; trailing?: Snippet } = $props();
</script>

<!-- data-dot-anchor 是 NavDot 的落点：紧跟在文字后面。 -->
<a
  data-active={active || undefined}
  aria-current={active ? "page" : undefined}
  class={cn(
    "flex h-[30px] items-center rounded-[5px] px-2.5 whitespace-nowrap text-fg2 transition-colors duration-(--t-color) hover:text-fg data-active:text-fg",
    className,
  )}
  {...rest}
>
  <span class="truncate">{@render children()}</span>
  <span data-dot-anchor class="ml-2.5 inline-block h-[7px] w-0 flex-none"></span>
  {@render trailing?.()}
</a>
