<script lang="ts">
  import type { ComponentStatus } from "#lib/api/queries/system.ts";
  import { cn } from "#lib/utils.ts";

  // 6px 状态点。颜色只表达状态（正常/提示/异常/禁用），不用金色。
  let { status, class: className }: { status: ComponentStatus; class?: string } = $props();

  const COLORS: Record<ComponentStatus, string> = {
    ok: "bg-ok",
    warning: "bg-warn",
    error: "bg-danger",
    disabled: "bg-fg3",
  };
</script>

<span aria-hidden="true" data-status={status} class={cn("inline-block size-1.5 flex-none rounded-full", COLORS[status], className)}
></span>
