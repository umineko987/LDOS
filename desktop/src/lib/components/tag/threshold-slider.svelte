<script lang="ts">
  import { Slider as SliderPrimitive } from "bits-ui";

  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 一个类别的阈值滑块。滑块头只在拖动或键盘聚焦时变金色；轨道上的小刻度是模型默认值，
  // 改过时数值旁边出现「恢复默认」。键盘：←/→ 步进 0.01，Home/End 到两头。
  let {
    label,
    tone,
    value,
    defaultValue,
    min,
    max,
    step,
    muted = false,
    onchange,
    testid,
  }: {
    label: string;
    /** 类别颜色的文字类（tag-colors.ts）。 */
    tone: string;
    value: number;
    defaultValue: number;
    min: number;
    max: number;
    step: number;
    /** 这个类别不输出：滑块照常可调，整行变暗。 */
    muted?: boolean;
    onchange: (value: number) => void;
    testid?: string;
  } = $props();

  const span = $derived(Math.max(max - min, Number.EPSILON));
  const tick = $derived(Math.min(100, Math.max(0, ((defaultValue - min) / span) * 100)));
  const changed = $derived(value !== defaultValue);
</script>

<div class={cn("flex flex-col gap-1.5 transition-opacity duration-(--t-color)", muted && "opacity-50")} data-testid={testid} data-value={value.toFixed(2)}>
  <div class="flex h-5 items-center gap-2 text-xs">
    <span class={cn("min-w-0 flex-1 truncate", tone)}>{label}</span>
    {#if changed}
      <button
        type="button"
        class="text-2xs text-fg3 hover:text-fg"
        onclick={() => onchange(defaultValue)}
        title={m.tag_threshold_reset({ value: defaultValue.toFixed(2) })}
      >
        {m.tag_threshold_default({ value: defaultValue.toFixed(2) })}
      </button>
    {/if}
    <span class="w-9 text-right font-mono text-fg tabular-nums" data-slot="value">{value.toFixed(2)}</span>
  </div>
  <SliderPrimitive.Root
    type="single"
    {value}
    {min}
    {max}
    {step}
    onValueChange={onchange}
    class="relative flex h-3 w-full touch-none items-center select-none"
  >
    {#snippet children({ thumbItems })}
      <span class="relative h-0.5 grow rounded-full bg-line2">
        <SliderPrimitive.Range class="absolute h-full rounded-full bg-fg3" />
        <span class="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-line3" style:left="{tick}%" aria-hidden="true"></span>
      </span>
      {#each thumbItems as thumb (thumb.index)}
        <SliderPrimitive.Thumb
          index={thumb.index}
          aria-label={label}
          class="block size-3 shrink-0 rounded-full bg-fg2 transition-colors duration-(--t-color) select-none hover:bg-fg focus-visible:bg-gold focus-visible:outline-none active:bg-gold data-active:bg-gold"
        />
      {/each}
    {/snippet}
  </SliderPrimitive.Root>
</div>
