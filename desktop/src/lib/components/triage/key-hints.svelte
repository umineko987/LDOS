<script lang="ts">
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 卡组下方的按键提示条。
  let { count, zoom = false }: { count: number; zoom?: boolean } = $props();
</script>

<p class="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-fg3" data-testid="triage-keyhints">
  <span class="inline-flex items-center gap-1"><Kbd>1</Kbd>–<Kbd>{Math.max(1, Math.min(9, count))}</Kbd>{m.triage_hint_toggle()}</span>
  <span class="inline-flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd>{m.triage_hint_focus()}</span>
  <span class="inline-flex items-center gap-1"><Kbd>Enter</Kbd>{m.triage_hint_adopt()}</span>
  <span class="inline-flex items-center gap-1"><Kbd>Shift Enter</Kbd>{m.triage_hint_group_prev()}</span>
  <span class="inline-flex items-center gap-1"><Kbd>Space</Kbd>{m.triage_hint_preview()}</span>
  <span class="inline-flex items-center gap-1"><Kbd>Z</Kbd>{m.triage_hint_undo()}</span>
  {#if zoom}<span class="inline-flex items-center gap-1">{m.dedup_hint_zoom()}</span>{/if}
</p>
