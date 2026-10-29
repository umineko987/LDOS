<script lang="ts">
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import CircleDashedIcon from "@lucide/svelte/icons/circle-dashed";
  import CircleSlashIcon from "@lucide/svelte/icons/circle-slash";
  import CircleXIcon from "@lucide/svelte/icons/circle-x";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";

  import { cn } from "#lib/utils.ts";

  import { statusTone, TONE_TEXT } from "./labels.ts";

  // 状态图标：运行中转圈（减少动效时静止），终态用颜色区分。文字说明由调用方给。
  let { status, class: className }: { status: string; class?: string } = $props();

  const tone = $derived(statusTone(status));
</script>

{#if tone === "active"}
  <LoaderCircleIcon
    aria-hidden="true"
    data-status={status}
    class={cn("size-3.5 flex-none motion-safe:animate-spin in-data-[motion=reduced]:animate-none", TONE_TEXT[tone], className)}
  />
{:else if tone === "ok"}
  <CircleCheckIcon aria-hidden="true" data-status={status} class={cn("size-3.5 flex-none", TONE_TEXT[tone], className)} />
{:else if tone === "danger"}
  <CircleXIcon aria-hidden="true" data-status={status} class={cn("size-3.5 flex-none", TONE_TEXT[tone], className)} />
{:else if tone === "warn"}
  <CircleAlertIcon aria-hidden="true" data-status={status} class={cn("size-3.5 flex-none", TONE_TEXT[tone], className)} />
{:else if status === "cancelled"}
  <CircleSlashIcon aria-hidden="true" data-status={status} class={cn("size-3.5 flex-none", TONE_TEXT[tone], className)} />
{:else}
  <CircleDashedIcon aria-hidden="true" data-status={status} class={cn("size-3.5 flex-none", TONE_TEXT[tone], className)} />
{/if}
