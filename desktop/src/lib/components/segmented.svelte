<script lang="ts" generics="T extends string">
  import type { HTMLAttributes } from "svelte/elements";

  import { cn } from "#lib/utils.ts";

  // 分段按钮：几个互斥选项并排，当前项用 aria-pressed 标出。
  // 选中态是 bg3 + 主文字色，不用金色（金色只给主操作、焦点环和选中的导航点）。
  interface Option {
    readonly value: T;
    readonly label: string;
    readonly lang?: string;
  }

  let {
    options,
    value,
    onchange,
    label,
    size = "xs",
    class: className,
    ...rest
  }: {
    options: readonly Option[];
    value: T;
    onchange: (value: T) => void;
    /** 整组的 aria-label。 */
    label: string;
    size?: "xs" | "sm";
    class?: string;
  } & Omit<HTMLAttributes<HTMLDivElement>, "role" | "onchange"> = $props();
</script>

<div
  role="group"
  aria-label={label}
  class={cn("inline-flex overflow-hidden rounded-[5px] border border-line", className)}
  {...rest}
>
  {#each options as option (option.value)}
    <button
      type="button"
      lang={option.lang}
      aria-pressed={value === option.value}
      data-value={option.value}
      class={cn(
        "text-fg3 transition-colors hover:text-fg2 aria-pressed:bg-bg3 aria-pressed:text-fg",
        size === "xs" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs",
      )}
      onclick={() => onchange(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>
