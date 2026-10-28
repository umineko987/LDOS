<script lang="ts" module>
	export type Side = "top" | "right" | "bottom" | "left";
</script>

<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from "#lib/components/ui/button/index.ts";
	import { cn, type WithoutChildrenOrChild } from "#lib/utils.ts";
	import SheetOverlay from "./sheet-overlay.svelte";
	import SheetPortal from "./sheet-portal.svelte";
	import type { Snippet } from "svelte";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		side = "right",
		showCloseButton = true,
		portalProps,
		children,
		...restProps
	}: WithoutChildrenOrChild<SheetPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SheetPortal>>;
		side?: Side;
		showCloseButton?: boolean;
		children: Snippet;
	} = $props();
</script>

<SheetPortal {...portalProps}>
	<SheetOverlay />
	<SheetPrimitive.Content
		bind:ref
		data-slot="sheet-content"
		data-side={side}
		class={cn(
			"fixed z-50 flex flex-col bg-popover text-sm text-popover-foreground shadow-over outline-none duration-(--t-over) ease-ldos data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:w-[400px] data-[side=right]:max-w-[92vw] data-[side=right]:border-l data-[side=right]:border-line2 data-[side=right]:data-open:slide-in-from-right-6 data-[side=right]:data-closed:slide-out-to-right-6 data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:w-[400px] data-[side=left]:max-w-[92vw] data-[side=left]:border-r data-[side=left]:border-line2 data-[side=left]:data-open:slide-in-from-left-6 data-[side=left]:data-closed:slide-out-to-left-6 data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:border-b data-[side=top]:border-line2 data-[side=top]:data-open:slide-in-from-top-6 data-[side=top]:data-closed:slide-out-to-top-6 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:border-t data-[side=bottom]:border-line2 data-[side=bottom]:data-open:slide-in-from-bottom-6 data-[side=bottom]:data-closed:slide-out-to-bottom-6",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<SheetPrimitive.Close data-slot="sheet-close">
				{#snippet child({ props })}
					<Button variant="ghost" class="absolute top-3 right-3" size="icon-sm" {...props}>
						<XIcon  />
						<span class="sr-only">Close</span>
					</Button>
				{/snippet}
			</SheetPrimitive.Close>
		{/if}
	</SheetPrimitive.Content>
</SheetPortal>
