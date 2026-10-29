<script lang="ts">
  import { untrack } from "svelte";

  import { DATASET_KINDS, type DatasetKind } from "#lib/api/queries/datasets.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { DatasetFormValues } from "./context.ts";

  // 新建 / 编辑数据集：名称、类型（角色 / 画风 / 概念）、触发词。提交失败时留在对话框里显示错误。

  let {
    open = $bindable(false),
    mode,
    initial,
    focusField = "name",
    onsubmit,
  }: {
    open?: boolean;
    mode: "create" | "edit";
    initial?: Partial<DatasetFormValues>;
    /** 打开时聚焦哪个输入框（点触发词打开编辑时聚焦触发词）。 */
    focusField?: "name" | "trigger";
    onsubmit: (values: DatasetFormValues) => Promise<void>;
  } = $props();

  let name = $state("");
  let kind = $state<DatasetKind>("character");
  let triggerWord = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
  let triggerInput = $state<HTMLInputElement | null>(null);

  const KIND_LABELS: Record<DatasetKind, () => string> = {
    character: m.dataset_kind_character,
    style: m.dataset_kind_style,
    concept: m.dataset_kind_concept,
  };
  const kinds = $derived(DATASET_KINDS.map((value) => ({ value, label: KIND_LABELS[value]() })));
  const trimmed = $derived(name.trim());

  function reset() {
    name = initial?.name ?? "";
    kind = initial?.kind ?? "character";
    triggerWord = initial?.triggerWord ?? "";
    error = null;
    submitting = false;
  }

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  $effect.pre(() => {
    if (open) untrack(reset);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!trimmed || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit({ name: trimmed, kind, triggerWord: triggerWord.trim() });
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  // mode 在一个实例里不变（新建、编辑各用一个实例）。
  // svelte-ignore state_referenced_locally
  useOverlay(() => open, { id: `dataset-${mode}` });
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    data-testid="dataset-dialog"
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      (focusField === "trigger" ? triggerInput : nameInput)?.focus();
    }}
    onCloseAutoFocus={(event) => {
      if (mode === "create") event.preventDefault();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>{mode === "create" ? m.dataset_create_title() : m.dataset_edit_title()}</Dialog.Title>
      {#if mode === "create"}<Dialog.Description>{m.dataset_create_hint()}</Dialog.Description>{/if}
    </Dialog.Header>
    <form class="flex flex-col gap-4" onsubmit={submit} id="dataset-form-{mode}">
      <div class="flex flex-col gap-1.5">
        <Label for="dataset-name-{mode}">{m.dataset_field_name()}</Label>
        <Input
          id="dataset-name-{mode}"
          bind:ref={nameInput}
          bind:value={name}
          maxlength={120}
          autocomplete="off"
          placeholder={m.dataset_field_name_placeholder()}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-fg2">{m.dataset_field_kind()}</span>
        <Segmented options={kinds} value={kind} onchange={(next) => (kind = next)} label={m.dataset_field_kind()} size="sm" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="dataset-trigger-{mode}">{m.dataset_field_trigger()}</Label>
        <Input
          id="dataset-trigger-{mode}"
          bind:ref={triggerInput}
          bind:value={triggerWord}
          maxlength={120}
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
          placeholder={m.dataset_field_trigger_placeholder()}
        />
        <span class="text-2xs text-fg3">{m.dataset_field_trigger_hint()}</span>
      </div>
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    </form>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" type="submit" form="dataset-form-{mode}" disabled={!trimmed || submitting}>
        {mode === "create" ? m.dataset_create_submit() : m.common_save()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
