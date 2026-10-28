<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { ...restProps }: SonnerProps = $props();
</script>

<!-- 工作台只有深色主题，主题固定，不依赖 mode-watcher。 -->
<Sonner
	theme="dark"
	position="bottom-right"
	class="toaster group"
	style="--normal-bg: var(--bg2); --normal-text: var(--fg); --normal-border: var(--bg2); --border-radius: 8px;"
	toastOptions={{
		classes: {
			toast: "shadow-over! font-sans! text-sm!",
			description: "text-fg2! text-xs!",
			actionButton: "bg-bg3! text-fg! h-6! rounded-md!",
			cancelButton: "bg-transparent! text-fg2! h-6! rounded-md!",
		},
	}}
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4 text-ok" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4 text-danger" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4 text-fg2" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4 text-warn" />
	{/snippet}
</Sonner>
