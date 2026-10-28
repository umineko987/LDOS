<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "#lib/utils.ts";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "textarea",
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		"flex field-sizing-content min-h-16 w-full resize-none rounded-md border border-input bg-bg1 px-[9px] py-[7px] text-sm leading-[1.55] text-fg transition-colors outline-none placeholder:text-fg3 focus-visible:border-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	bind:value
	{...restProps}></textarea>
