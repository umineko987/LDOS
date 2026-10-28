<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "#lib/utils.ts";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
		variants: {
			variant: {
				default: "border-line2 bg-bg2 text-fg hover:border-line3 aria-expanded:border-line3",
				primary: "border-gold bg-gold font-semibold text-gold-ink hover:border-gold-hover hover:bg-gold-hover",
				outline: "border-line2 bg-transparent text-fg hover:border-line3 aria-expanded:border-line3",
				secondary: "border-line bg-bg3 text-fg hover:border-line2 aria-expanded:border-line2",
				ghost: "bg-transparent text-fg2 hover:bg-bg2 hover:text-fg aria-expanded:bg-bg2 aria-expanded:text-fg",
				destructive: "border-line2 bg-bg2 text-danger hover:border-line3",
				link: "h-auto! px-0! text-fg underline-offset-4 hover:underline",
			},
			size: {
				default: "h-control px-[11px]",
				xs: "h-5 gap-1 px-1.5 text-2xs [&_svg:not([class*='size-'])]:size-3",
				sm: "h-6 gap-1 px-2 text-xs",
				lg: "h-8 px-3.5",
				icon: "size-control",
				"icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-6",
				"icon-lg": "size-8",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
