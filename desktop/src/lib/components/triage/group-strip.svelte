<script lang="ts">
  import { groupStatus, type TriageState } from "#lib/keys/triage.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 组进度条：每组一小段，当前组最亮，已定夺的次之。组很多时只画当前组附近的一段（DOM 预算）。
  const WINDOW = 60;

  let { state, ongoto }: { state: TriageState; ongoto: (group: number) => void } = $props();

  const range = $derived.by(() => {
    const total = state.groups.length;
    const start = Math.max(0, Math.min(state.group - WINDOW / 2, total - WINDOW));
    return { start, end: Math.min(total, start + WINDOW) };
  });
  const visible = $derived(state.groups.slice(range.start, range.end));
</script>

<div class="flex flex-wrap gap-1" role="group" aria-label={m.triage_strip()} data-testid="triage-strip">
  {#each visible as group, offset (group.id)}
    {@const index = range.start + offset}
    {@const status = groupStatus(state, group.id)}
    <button
      type="button"
      tabindex="-1"
      class={cn(
        "h-1.5 w-5 rounded-full transition-colors duration-(--t-color)",
        index === state.group ? "bg-fg" : status === "pending" ? "bg-line2 hover:bg-line3" : "bg-fg3",
      )}
      title={m.triage_group_counter({ n: index + 1, total: state.groups.length })}
      aria-label={m.triage_group_counter({ n: index + 1, total: state.groups.length })}
      aria-current={index === state.group || undefined}
      onclick={() => ongoto(index)}
    ></button>
  {/each}
</div>
