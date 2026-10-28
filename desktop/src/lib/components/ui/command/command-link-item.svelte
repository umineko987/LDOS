<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.ts";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.LinkItemProps = $props();
</script>


<CommandPrimitive.LinkItem
	bind:ref
	data-slot="command-item"
	class={cn(
		"group/command-item relative flex h-[34px] cursor-default items-center gap-2.5 rounded-md px-3 text-sm text-fg2 outline-hidden select-none data-selected:bg-bg3 data-selected:text-fg data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
		"data-disabled:pointer-events-none data-disabled:opacity-50",
		className
	)}
	{...restProps}
/>
