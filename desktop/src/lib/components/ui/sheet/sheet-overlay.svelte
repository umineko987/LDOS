<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "#lib/utils.ts";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.OverlayProps = $props();
</script>

<SheetPrimitive.Overlay
	bind:ref
	data-slot="sheet-overlay"
	class={cn(
		"fixed inset-0 isolate z-50 bg-scrim duration-(--t-over) ease-ldos data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
		className
	)}
	{...restProps}
/>
