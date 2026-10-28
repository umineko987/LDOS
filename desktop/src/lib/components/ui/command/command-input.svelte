<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import SearchIcon from '@lucide/svelte/icons/search';
	import { cn } from "#lib/utils.ts";

	let {
		ref = $bindable(null),
		class: className,
		value = $bindable(""),
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<div data-slot="command-input-wrapper" class="flex h-[46px] items-center gap-2.5 border-b border-line px-[18px]">
	<SearchIcon class="size-4 shrink-0 text-fg3" />
	<CommandPrimitive.Input
		data-slot="command-input"
		class={cn(
			"h-full w-full min-w-0 bg-transparent text-base text-fg outline-none placeholder:text-fg3 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
			className
		)}
		bind:value
		bind:ref
		{...restProps}
	/>
</div>
