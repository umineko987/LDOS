<script lang="ts">
  import * as Sheet from "#lib/components/ui/sheet/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  // Ctrl+J：活动抽屉。Phase 1 只有占位；任务列表接 /api/v1/jobs 和 SSE 后放在这里。
  let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" data-testid="activity-drawer">
    <Sheet.Header class="border-b border-line px-[18px] py-3.5">
      <Sheet.Title>{m.shell_activity()}</Sheet.Title>
    </Sheet.Header>
    <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
      <p class="text-sm text-fg2">{m.shell_activity_empty()}</p>
      <p class="text-xs text-fg3">{m.shell_activity_hint()}</p>
    </div>
  </Sheet.Content>
</Sheet.Root>
