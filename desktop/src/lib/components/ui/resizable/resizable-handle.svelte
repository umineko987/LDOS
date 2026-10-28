<script lang="ts">
	import * as ResizablePrimitive from "paneforge";
	import { cn, type WithoutChildrenOrChild } from "#lib/utils.ts";

	let {
		ref = $bindable(null),
		class: className,
		withHandle = false,
		...restProps
	}: WithoutChildrenOrChild<ResizablePrimitive.PaneResizerProps> & {
		withHandle?: boolean;
	} = $props();
</script>

<ResizablePrimitive.PaneResizer
	bind:ref
	data-slot="resizable-handle"
	class={cn(
		"relative flex w-px items-center justify-center bg-line transition-colors hover:bg-fg3 data-active:bg-fg3 after:absolute after:inset-y-0 after:left-1/2 after:w-[7px] after:-translate-x-1/2 focus-visible:outline-offset-0 data-[direction=vertical]:h-px data-[direction=vertical]:w-full data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-[7px] data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2 [&[data-direction=vertical]>div]:rotate-90",
		className
	)}
	{...restProps}
>
	{#if withHandle}
		<div class="z-10 flex h-6 w-1 shrink-0 rounded-full bg-line2"></div>
	{/if}
</ResizablePrimitive.PaneResizer>
