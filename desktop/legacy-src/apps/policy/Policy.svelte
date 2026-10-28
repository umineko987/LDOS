<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { onMount, tick, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import { createPolicyController } from "./controller";
  import {
    derivePolicyControls,
    derivePolicyEditorPresentation,
    derivePolicyWorkspacePresentation,
    emptyPolicyDraft,
    getPolicySiteDefinition,
    isPolicyDirty,
    policyConfigToDraft,
    policySiteItems,
    validatePolicyDraft,
    type PolicyDraft,
    type PolicySiteId,
  } from "./model";
  import { createPolicyService } from "./service";
  import { createPolicyStore } from "./state";
  import "./policy.css";

  let { api, registerUnsavedChanges }: {
    api: ApiClient;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void) => () => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createPolicyStore();
    return { store, controller: createPolicyController({ store, service: createPolicyService(api) }) };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const items = $derived(policySiteItems(snapshot.snapshot));
  const current = $derived(snapshot.snapshot?.sites[snapshot.selectedSite] ?? null);
  let draft = $state<PolicyDraft>(emptyPolicyDraft());
  let formLoaded = $state(false);
  let confirmationDialog = $state<HTMLDialogElement>();
  let workspace = $state<HTMLElement>();
  let returnFocus: FocusTarget | null = null;
  let draftInitialized = $state(false);

  const validation = $derived(formLoaded ? validatePolicyDraft(draft) : { valid: false, payload: null, field: "policy", reason: "invalid_value" });
  const dirty = $derived(Boolean(formLoaded && current?.policy && isPolicyDirty(current.policy, draft)));
  const controls = $derived(derivePolicyControls(current, { busy: snapshot.busy, dirty, valid: validation.valid }));
  const presentation = $derived(derivePolicyWorkspacePresentation({
    snapshot: snapshot.snapshot,
    item: current,
    phase: snapshot.phase,
    busy: snapshot.busy,
    dirty,
    valid: validation.valid,
  }));
  const editor = $derived(derivePolicyEditorPresentation(current));

  function loadDraft(): void {
    if (current?.editable && current.policy) {
      draft = policyConfigToDraft(current.policy);
      formLoaded = true;
      draftInitialized = true;
      return;
    }
    draft = emptyPolicyDraft();
    formLoaded = false;
    draftInitialized = true;
  }

  function updateDraft(patch: Partial<PolicyDraft>): void {
    draft = { ...draft, ...patch };
  }

  $effect(() => {
    if (!draftInitialized && current) loadDraft();
  });

  function discardDraft(): void {
    loadDraft();
    store.setPhase(snapshot.snapshot ? "idle" : "loading", "已放弃未保存的站点设置。 ");
  }

  function selectSite(site: PolicySiteId): void {
    if (site === snapshot.selectedSite) return;
    if (dirty) {
      controller.requestDiscardSite(site);
      return;
    }
    draftInitialized = false;
    controller.selectSite(site);
  }

  async function refresh(): Promise<void> {
    const wasDirty = dirty;
    const succeeded = await controller.refresh();
    if (succeeded && !wasDirty) loadDraft();
  }

  async function save(): Promise<void> {
    if (!validation.valid) {
      store.setMessage("请修正标记项后再保存；请求尚未发送。");
      return;
    }
    const preserved = { ...draft };
    const succeeded = await controller.save(snapshot.selectedSite, draft);
    if (succeeded) loadDraft();
    else draft = preserved;
  }

  function reset(): void {
    if (dirty && !current?.hasOverride) {
      discardDraft();
      return;
    }
    controller.requestReset(snapshot.selectedSite);
  }

  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function restorePolicyFocus(target: FocusTarget | null = returnFocus): void {
    if (!restoreFocus(target)) workspace?.focus({ preventScroll: true });
    returnFocus = null;
  }

  function resolveConfirmation(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    void controller.confirmAction(confirmed).then((succeeded) => { if (succeeded) { draftInitialized = false; loadDraft(); } });
    void tick().then(() => restorePolicyFocus(target));
  }

  function onConfirmationKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      resolveConfirmation(false);
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableDialogItems();
    const next = trappedTabIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    }
  }

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!dirty && !snapshot.busy) return;
    event.preventDefault();
    event.returnValue = "";
  }

  function validationMessage(): string {
    if (!formLoaded || validation.valid) return "";
    const labels: Readonly<Record<string, string>> = {
      max_concurrency: "最大并发数", retry_limit: "重试次数", backoff_base_seconds: "首次重试等待", proxy_mode: "连接方式", policy: "站点设置",
    };
    const reasons: Readonly<Record<string, string>> = {
      not_number: "需要填写数字", not_integer: "需要填写整数", out_of_range: "超出允许范围", invalid_enum: "不是可选连接方式", unknown_field: "包含不支持的字段", missing_field: "缺少必填内容", invalid_value: "内容无效",
    };
    return `${labels[validation.field] ?? "站点设置"}：${reasons[validation.reason] ?? "内容不正确"}。`;
  }

  function sourceLabel(): string {
    if (!current) return "等待设置来源";
    return current.hasOverride ? "站点自定义覆盖" : "继承服务默认设置";
  }

  function sourceState(item: typeof current): string {
    if (!item) return "正在加载";
    if (!item.editable) return "暂时无法设置";
    return item.hasOverride ? "使用自定义设置" : "使用默认设置";
  }

  $effect(() => {
    if (!snapshot.confirmation) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (confirmationDialog && !confirmationDialog.open && typeof confirmationDialog.showModal === "function") confirmationDialog.showModal();
      restoreFocus(focusableDialogItems()[0] ?? confirmationDialog);
    });
  });

  function displayMessage(message: string): string {
    return message.replace(/权威/g, "").replace(/四字段设置/g, "设置").replace(/四个字段均来自/g, "设置来自").replace("最小化或关闭窗口", "关闭页面").replace("请勿关闭窗口", "请勿离开此页");
  }

  onMount(() => {
    const unregister = registerUnsavedChanges?.(() => dirty, discardDraft) ?? (() => {});
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    controller.activate();
    return () => {
      unregister();
      globalThis.removeEventListener("beforeunload", onBeforeUnload);
      controller.deactivate();
      controller.destroy();
    };
  });
</script>

<section class="policy-app" data-policy-app data-domain-owner="policy" aria-labelledby="policy-heading" aria-busy={Boolean(snapshot.busy)}>
  <header class="policy-header">
    <h1 id="policy-heading">站点</h1>
    <div class="policy-header-actions"><Badge variant="outline" class="policy-status" data-kind={presentation.kind}>{presentation.label}</Badge><Button variant="outline" size="sm" type="button" disabled={Boolean(snapshot.busy)} onclick={() => void refresh()}>{snapshot.busy === "refresh" ? "正在刷新…" : "刷新设置"}</Button></div>
  </header>

  {#if snapshot.error}
    <Alert.Root variant="destructive" class="policy-error" aria-labelledby="policy-error-title">
      <Alert.Title id="policy-error-title">{snapshot.error.title}</Alert.Title>
      <Alert.Description>{snapshot.error.message} {snapshot.error.nextStep}{snapshot.error.detail ? ` ${snapshot.error.detail}` : ""}</Alert.Description>
      <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
    </Alert.Root>
  {/if}
  <p class="policy-live" aria-live="polite">{displayMessage(snapshot.message)}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable Policy workspace) -->
  <section class="policy-workspace" tabindex="0" bind:this={workspace} aria-label="站点设置；可纵向滚动">
    <div class="policy-workspace-track">
      <nav class="policy-column policy-column--navigation" aria-labelledby="policy-sites-heading">
        <header><h2 id="policy-sites-heading">选择站点</h2></header>
        <div class="policy-column-scroll" tabindex="0" aria-label="站点设置来源内容；可滚动">
          <div class="policy-site-nav" role="group" aria-label="五个站点的设置状态">
            {#each items as entry (entry.definition.id)}
              <Button variant="outline" size="sm"
                type="button"
                class="policy-site-button"
                data-policy-site={entry.definition.id}
                aria-current={snapshot.selectedSite === entry.definition.id ? "true" : undefined}
                disabled={controls.siteSelect.disabled}
                onclick={() => selectSite(entry.definition.id)}
              >
                <span class="policy-site-mark" aria-hidden="true">{entry.definition.mark}</span>
                <span><strong>{entry.definition.label}</strong><small>{sourceState(entry.item)}</small></span>
              </Button>
            {/each}
          </div>
          {#if snapshot.snapshot?.unknownOverrideCount}<p class="policy-warning">有 {snapshot.snapshot.unknownOverrideCount} 条未知设置记录已忽略。</p>{/if}
        </div>
      </nav>

      <section class="policy-column policy-column--editor" aria-labelledby="policy-editor-heading">
        <header><h2 id="policy-editor-heading">采集设置</h2></header>
        <div class="policy-column-scroll" tabindex="0" aria-label="站点设置编辑器内容；可滚动">
          <section class="policy-workspace-state" data-policy-workspace-state={presentation.state} role="status" aria-live="polite">
            <span class="policy-status" data-kind={presentation.kind}>{presentation.label}</span>
            <p>{displayMessage(presentation.message)}</p>
          </section>

          <form id="policy-form" class="policy-form" autocomplete="off" novalidate onsubmit={(event) => { event.preventDefault(); void save(); }}>
            <div class="policy-editor-heading"><h3>{current?.label ?? getPolicySiteDefinition(snapshot.selectedSite)?.label ?? "站点设置"}</h3></div>
            <div class="policy-field-grid">
              <Field.Field class="policy-field"><Field.Label for="policy-max">最大并发数</Field.Label><Input id="policy-max" data-policy-field="max_concurrency" type="number" min={1} max={128} required aria-describedby="policy-max-help policy-validation" aria-invalid={formLoaded && validation.field === "max_concurrency"} disabled={Boolean(snapshot.busy || !current?.editable)} value={draft.max_concurrency} oninput={(event) => updateDraft({ max_concurrency: event.currentTarget.value })} /><Field.Description id="policy-max-help">范围 1–128；仍受系统总上限限制。</Field.Description></Field.Field>
              <Field.Field class="policy-field"><Field.Label for="policy-retry">重试次数</Field.Label><Input id="policy-retry" data-policy-field="retry_limit" type="number" min={0} max={20} required aria-describedby="policy-retry-help policy-validation" aria-invalid={formLoaded && validation.field === "retry_limit"} disabled={Boolean(snapshot.busy || !current?.editable)} value={draft.retry_limit} oninput={(event) => updateDraft({ retry_limit: event.currentTarget.value })} /><Field.Description id="policy-retry-help">范围 0–20；0 表示不自动重试。</Field.Description></Field.Field>
              <Field.Field class="policy-field"><Field.Label for="policy-backoff">首次重试等待（秒）</Field.Label><Input id="policy-backoff" data-policy-field="backoff_base_seconds" type="number" min={0} max={3600} step={0.1} required aria-describedby="policy-backoff-help policy-validation" aria-invalid={formLoaded && validation.field === "backoff_base_seconds"} disabled={Boolean(snapshot.busy || !current?.editable)} value={draft.backoff_base_seconds} oninput={(event) => updateDraft({ backoff_base_seconds: event.currentTarget.value })} /><Field.Description id="policy-backoff-help">范围 0–3600；后续等待随连续失败增加。</Field.Description></Field.Field>
              <Field.Field class="policy-field"><Field.Label for="policy-proxy">连接方式</Field.Label><NativeSelect.Root id="policy-proxy" data-policy-field="proxy_mode" aria-describedby="policy-proxy-help policy-validation" aria-invalid={formLoaded && validation.field === "proxy_mode"} disabled={Boolean(snapshot.busy || !current?.editable)} value={draft.proxy_mode} onchange={(event) => updateDraft({ proxy_mode: event.currentTarget.value as PolicyDraft["proxy_mode"] })}><option value="direct">直连</option><option value="prefer">优先代理（不可用时直连）</option><option value="required">仅代理（不可用时失败）</option></NativeSelect.Root><Field.Description id="policy-proxy-help">单次搜索或批次中的显式连接设置优先。</Field.Description></Field.Field>
            </div>
            <p id="policy-validation" class="policy-validation" role="alert" aria-live="assertive">{validationMessage()}</p>
          </form>
        </div>
      </section>

      <aside class="policy-column policy-column--actions" aria-labelledby="policy-actions-heading">
        <header><h2 id="policy-actions-heading">保存与恢复</h2><span>仅影响后续新建任务。</span></header>
        <div class="policy-column-scroll" tabindex="0" aria-label="站点设置状态与操作内容；可滚动">
          <section class="policy-panel"><h3>当前来源</h3><p class="policy-source-title">{sourceLabel()}</p><p>{displayMessage(editor.message)}</p><p class="policy-impact">{editor.scope}</p></section>
          <section class="policy-panel"><h3>草稿状态</h3><p class="policy-dirty-live" data-dirty={dirty}>{!formLoaded ? "该站点设置暂时无法编辑。" : !validation.valid ? "请修正标记字段后再保存。" : dirty ? "有未保存的更改，离开前需确认。" : "所有更改均已保存。"}</p><p class="policy-operation-live" aria-live="polite">{displayMessage(snapshot.message)}</p></section>
          <section class="policy-panel"><h3>操作</h3><div class="policy-actions"><Button variant="default" size="sm" type="submit" form="policy-form" class="policy-button policy-button--primary" disabled={controls.save.disabled} title={controls.save.reason}>{controls.save.label}</Button><Button variant="outline" size="sm" type="button" class="policy-button policy-button--dangerous" disabled={controls.reset.disabled} onclick={reset}>{controls.reset.label}</Button></div><p class="policy-action-reason" aria-live="polite">{controls.save.reason || controls.reset.reason || "恢复默认只影响当前站点。"}</p></section>
          <section class="policy-panel policy-danger-note"><h3>影响范围</h3><p>恢复默认会删除当前站点覆盖；已创建和运行中的任务不受影响。</p></section>
        </div>
      </aside>
    </div>
  </section>
</section>

{#if snapshot.confirmation}
  <dialog class="policy-confirmation" data-policy-confirmation={snapshot.confirmation.action} aria-modal="true" aria-labelledby="policy-confirmation-title" aria-describedby="policy-confirmation-message policy-confirmation-warning" bind:this={confirmationDialog} oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }} onkeydown={onConfirmationKeydown} onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}>
    <section><h2 id="policy-confirmation-title">{snapshot.confirmation.title}</h2><p id="policy-confirmation-message">{displayMessage(snapshot.confirmation.message)}</p><p id="policy-confirmation-warning" class="policy-confirmation-warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p><div><Button variant="outline" size="sm" type="button" onclick={() => resolveConfirmation(false)}>取消</Button><Button variant="outline" size="sm" type="button" class="policy-button policy-button--dangerous" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</Button></div></section>
  </dialog>
{/if}
