<script lang="ts">
  import { untrack } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { CaptionBatchResult } from "#lib/api/queries/captions.ts";
  import TagDiff from "#lib/components/captions/tag-diff.svelte";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { previewOps, type CaptionOp, type CaptionOpKind, type CaptionTarget } from "#lib/domain/captions.ts";
  import { draftOp, type OpDraft } from "#lib/domain/studio.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 对选中的图做一个批量操作（加 / 删 / 替换 / 合并 / 置顶）：表单一变，本地先算会改几张，
  // 停顿后跑一次后端 dry-run 拿真实的统计和差异样例；dry-run 和当前表单一致时才能写入。
  // 写入后的撤销由页面的 toast 提供。
  interface Props {
    open: boolean;
    /** 打开时的初始表单（从检查器里点的那一行带过来）。 */
    initial: OpDraft;
    targets: readonly CaptionTarget[];
    triggerWord: string;
    nameOf: (assetId: string) => string;
    preview: (op: CaptionOp) => Promise<CaptionBatchResult>;
    apply: (op: CaptionOp) => Promise<void>;
  }

  let { open = $bindable(), initial, targets, triggerWord, nameOf, preview, apply }: Props = $props();

  const DEBOUNCE_MS = 250;

  let draft = $state<{ -readonly [K in keyof OpDraft]: OpDraft[K] }>({ ...untrack(() => initial) });
  let result = $state.raw<CaptionBatchResult | null>(null);
  let resultFor = $state("");
  let error = $state<string | null>(null);
  let applying = $state(false);
  let token = 0;

  const op = $derived(draftOp(draft));
  const key = $derived(op ? JSON.stringify(op) : "");
  const local = $derived(op ? previewOps(targets, [op], triggerWord) : null);
  const fresh = $derived(result !== null && resultFor === key);
  const changes = $derived(fresh && result ? result.stats.changed + result.stats.new : 0);

  useOverlay(() => open, { id: "studio-op" });

  $effect(() => {
    if (!open) return;
    draft = { ...untrack(() => initial) };
    result = null;
    resultFor = "";
    error = null;
  });

  // 表单停顿后自动 dry-run。
  $effect(() => {
    if (!open || !op) return;
    const requested = key;
    const body = op;
    const timer = setTimeout(() => void run(body, requested), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  async function run(body: CaptionOp, requested: string) {
    const current = ++token;
    error = null;
    try {
      const next = await preview(body);
      if (current !== token) return;
      result = next;
      resultFor = requested;
    } catch (failure) {
      if (current === token) error = apiErrorMessage(failure);
    }
  }

  async function confirm() {
    if (!op || !fresh || applying || changes === 0) return;
    applying = true;
    error = null;
    try {
      await apply(op);
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      applying = false;
    }
  }

  const kinds: { value: CaptionOpKind; label: string }[] = [
    { value: "add", label: m.studio_op_add() },
    { value: "remove", label: m.studio_op_remove() },
    { value: "replace", label: m.studio_op_replace() },
    { value: "merge", label: m.studio_op_merge() },
    { value: "pin", label: m.studio_op_pin() },
  ];
  const positions = [
    { value: "back" as const, label: m.studio_op_back() },
    { value: "front" as const, label: m.studio_op_front() },
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[560px]" data-testid="studio-op-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.studio_op_title({ count: targets.length })}</Dialog.Title>
      <Dialog.Description>{m.studio_op_hint()}</Dialog.Description>
    </Dialog.Header>

    <form
      class="flex flex-col gap-3"
      onsubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <Segmented options={kinds} value={draft.kind} onchange={(kind) => (draft.kind = kind)} label={m.studio_op_kind()} size="sm" data-testid="studio-op-kind" />

      {#if draft.kind === "replace"}
        <div class="grid grid-cols-2 gap-2">
          <Input bind:value={draft.from} placeholder={m.studio_op_from()} aria-label={m.studio_op_from()} data-testid="studio-op-from" />
          <Input bind:value={draft.to} placeholder={m.studio_op_to()} aria-label={m.studio_op_to()} data-testid="studio-op-to" />
        </div>
      {:else}
        <Input bind:value={draft.tags} placeholder={m.studio_op_tags()} aria-label={m.studio_op_tags()} data-testid="studio-op-tags" />
        {#if draft.kind === "merge"}
          <Input bind:value={draft.into} placeholder={m.studio_op_into()} aria-label={m.studio_op_into()} data-testid="studio-op-into" />
        {:else if draft.kind === "add"}
          <Segmented options={positions} value={draft.position} onchange={(position) => (draft.position = position)} label={m.studio_op_position()} />
        {/if}
      {/if}

      <div class="flex flex-col gap-1.5" aria-live="polite">
        {#if !op}
          <p class="text-xs text-fg3">{m.studio_op_incomplete()}</p>
        {:else if fresh && result}
          <p class="text-sm text-fg" data-testid="studio-op-stats" data-changes={changes}>
            {m.studio_op_stats({ changed: changes, total: result.stats.total })}
            {#if result.stats.conflicts}<span class="text-xs text-warn"> · {m.studio_op_conflicts({ count: result.stats.conflicts })}</span>{/if}
          </p>
          {#if result.samples.length}
            <ul class="flex max-h-[240px] flex-col overflow-y-auto border-y border-line" data-testid="studio-op-samples">
              {#each result.samples as sample (sample.asset_id)}
                <li class="flex flex-col gap-0.5 border-b border-line py-1.5 last:border-b-0">
                  <span class="truncate text-xs text-fg2">{nameOf(sample.asset_id)}</span>
                  <TagDiff added={sample.added} removed={sample.removed} />
                </li>
              {/each}
            </ul>
          {/if}
        {:else if local}
          <p class="text-xs text-fg3" role="status">{m.studio_op_local({ changed: local.changes.length, total: local.total })}</p>
        {/if}
        {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
      </div>

      <Dialog.Footer>
        <Button variant="ghost" onclick={() => (open = false)}>{m.common_cancel()}</Button>
        <Button type="submit" variant="primary" disabled={!fresh || changes === 0 || applying} data-testid="studio-op-apply">
          {!fresh ? m.studio_op_waiting() : changes ? m.studio_op_apply({ count: changes }) : m.studio_op_nothing()}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
