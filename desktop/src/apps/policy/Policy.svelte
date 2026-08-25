<script lang="ts">
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

  $effect(() => {
    if (!draftInitialized || (!dirty && current)) loadDraft();
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
    <div><p>站点设置</p><h1 id="policy-heading">抓取策略与任务边界</h1></div>
    <div class="policy-header-actions"><span class="policy-status" data-kind={presentation.kind}>{presentation.label}</span><button type="button" disabled={Boolean(snapshot.busy)} onclick={() => void refresh()}>{snapshot.busy === "refresh" ? "正在刷新…" : "刷新设置"}</button></div>
  </header>

  {#if snapshot.error}
    <section class="policy-error" role="alert" aria-labelledby="policy-error-title">
      <strong id="policy-error-title">{snapshot.error.title}</strong>
      <p>{snapshot.error.message} {snapshot.error.nextStep}{snapshot.error.detail ? ` ${snapshot.error.detail}` : ""}</p>
      <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
    </section>
  {/if}
  <p class="policy-live" aria-live="polite">{snapshot.message}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable Policy workspace) -->
  <section class="policy-workspace" tabindex="0" bind:this={workspace} aria-label="站点设置三栏工作区，可横向滚动查看站点、完整编辑器与保存恢复操作">
    <div class="policy-workspace-track">
      <nav class="policy-column policy-column--navigation" aria-labelledby="policy-sites-heading">
        <header><p>01 · 站点</p><h2 id="policy-sites-heading">站点设置来源</h2><span>固定顺序显示五个后端支持的站点。</span></header>
        <div class="policy-column-scroll">
          <div class="policy-site-nav" role="list" aria-label="五个站点的设置状态">
            {#each items as entry (entry.definition.id)}
              <button
                type="button"
                class="policy-site-button"
                data-policy-site={entry.definition.id}
                aria-current={snapshot.selectedSite === entry.definition.id ? "true" : undefined}
                disabled={controls.siteSelect.disabled}
                onclick={() => selectSite(entry.definition.id)}
              >
                <span class="policy-site-mark" aria-hidden="true">{entry.definition.mark}</span>
                <span><strong>{entry.definition.label}</strong><small>{sourceState(entry.item)}</small></span>
              </button>
            {/each}
          </div>
          <p class="policy-proof">◆ 当前站点 · {getPolicySiteDefinition(snapshot.selectedSite)?.label ?? "尚未加载"}</p>
          {#if snapshot.snapshot?.unknownOverrideCount}<p class="policy-warning">有 {snapshot.snapshot.unknownOverrideCount} 条未知设置记录已忽略。</p>{/if}
        </div>
      </nav>

      <main class="policy-column policy-column--editor" aria-labelledby="policy-editor-heading">
        <header><p>02 · 当前站点</p><h2 id="policy-editor-heading">完整四字段编辑器</h2><span>无效草稿不会发送请求。</span></header>
        <div class="policy-column-scroll">
          <section class="policy-workspace-state" data-policy-workspace-state={presentation.state} role="status" aria-live="polite">
            <span class="policy-status" data-kind={presentation.kind}>{presentation.label}</span>
            <p>{presentation.message}</p>
          </section>

          <form class="policy-form" autocomplete="off" novalidate onsubmit={(event) => { event.preventDefault(); void save(); }}>
            <div class="policy-editor-heading"><h3>{current?.label ?? "站点设置"}</h3><p>四个字段组成完整设置；保存始终提交全部四项。</p></div>
            <div class="policy-field-grid">
              <label class="policy-field"><span>最大并发数</span><input data-policy-field="max_concurrency" type="number" min="1" max="128" required aria-describedby="policy-max-help policy-validation" aria-invalid={formLoaded && validation.field === "max_concurrency"} disabled={Boolean(snapshot.busy || !current?.editable)} bind:value={draft.max_concurrency} /><small id="policy-max-help">范围 1–128；仍受系统总上限限制。</small></label>
              <label class="policy-field"><span>重试次数</span><input data-policy-field="retry_limit" type="number" min="0" max="20" required aria-describedby="policy-retry-help policy-validation" aria-invalid={formLoaded && validation.field === "retry_limit"} disabled={Boolean(snapshot.busy || !current?.editable)} bind:value={draft.retry_limit} /><small id="policy-retry-help">范围 0–20；0 表示不自动重试。</small></label>
              <label class="policy-field"><span>首次重试等待（秒）</span><input data-policy-field="backoff_base_seconds" type="number" min="0" max="3600" step="0.1" required aria-describedby="policy-backoff-help policy-validation" aria-invalid={formLoaded && validation.field === "backoff_base_seconds"} disabled={Boolean(snapshot.busy || !current?.editable)} bind:value={draft.backoff_base_seconds} /><small id="policy-backoff-help">范围 0–3600；后续等待随连续失败增加。</small></label>
              <label class="policy-field"><span>连接方式</span><select data-policy-field="proxy_mode" aria-describedby="policy-proxy-help policy-validation" aria-invalid={formLoaded && validation.field === "proxy_mode"} disabled={Boolean(snapshot.busy || !current?.editable)} bind:value={draft.proxy_mode}><option value="direct">直连</option><option value="prefer">优先代理（不可用时直连）</option><option value="required">仅代理（不可用时失败）</option></select><small id="policy-proxy-help">单次搜索或批次中的显式连接设置优先。</small></label>
            </div>
            <p id="policy-validation" class="policy-validation" role="alert" aria-live="assertive">{validationMessage()}</p>
            <button type="submit" class="policy-button policy-button--primary" disabled={controls.save.disabled} title={controls.save.reason}>{controls.save.label}</button>
          </form>
        </div>
      </main>

      <aside class="policy-column policy-column--actions" aria-labelledby="policy-actions-heading">
        <header><p>03 · 状态与操作</p><h2 id="policy-actions-heading">来源、草稿与保存</h2><span>保存和恢复仅影响后续新建任务。</span></header>
        <div class="policy-column-scroll">
          <section class="policy-panel"><h3>当前来源</h3><p class="policy-source-title">{sourceLabel()}</p><p>{editor.message}</p><p class="policy-impact">{editor.scope}</p></section>
          <section class="policy-panel"><h3>草稿状态</h3><p class="policy-dirty-live" data-dirty={dirty}>{!formLoaded ? "该站点设置暂时无法编辑。" : !validation.valid ? "草稿无效：请修正标记字段，尚未发送请求。" : dirty ? "有未保存的更改。离开、最小化或关闭前会要求确认。" : "所有更改均已保存。"}</p><p class="policy-operation-live" aria-live="polite">{snapshot.message}</p></section>
          <section class="policy-panel"><h3>保存与危险恢复</h3><div class="policy-actions"><button type="button" class="policy-button policy-button--primary" disabled={controls.save.disabled} onclick={() => void save()}>{controls.save.label}</button><button type="button" class="policy-button policy-button--dangerous" disabled={controls.reset.disabled} onclick={reset}>{controls.reset.label}</button></div><p class="policy-action-reason" aria-live="polite">{controls.save.reason || controls.reset.reason || "保存会提交完整四字段；恢复默认只影响当前站点。"}</p></section>
          <section class="policy-panel policy-danger-note"><h3>影响范围</h3><p>恢复默认会删除当前站点覆盖；已创建和运行中的任务不受影响。</p></section>
        </div>
      </aside>
    </div>
  </section>
</section>

{#if snapshot.confirmation}
  <dialog class="policy-confirmation" data-policy-confirmation={snapshot.confirmation.action} aria-modal="true" aria-labelledby="policy-confirmation-title" aria-describedby="policy-confirmation-message policy-confirmation-warning" bind:this={confirmationDialog} oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }} onkeydown={onConfirmationKeydown} onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}>
    <section><h2 id="policy-confirmation-title">{snapshot.confirmation.title}</h2><p id="policy-confirmation-message">{snapshot.confirmation.message}</p><p id="policy-confirmation-warning" class="policy-confirmation-warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p><div><button type="button" onclick={() => resolveConfirmation(false)}>取消</button><button type="button" class="policy-button policy-button--dangerous" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button></div></section>
  </dialog>
{/if}
