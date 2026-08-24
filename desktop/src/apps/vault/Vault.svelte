<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { PollingService } from "../../core/polling/service";
  import { createVaultController } from "./controller";
  import {
    deriveVaultControls,
    deriveVaultWorkspacePresentation,
    formatVaultTime,
    getVaultSiteDefinition,
    validateAuthorizationProxyInput,
    vaultSiteItems,
    type VaultSiteId,
  } from "./model";
  import { createVaultService } from "./service";
  import { createVaultStore } from "./state";
  import "./vault.css";

  let { api, polling, registerUnsavedChanges }: {
    api: ApiClient;
    polling: PollingService;
    registerUnsavedChanges?: (reader: () => boolean, discard?: () => void) => () => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createVaultStore();
    return { store, controller: createVaultController({ store, service: createVaultService(api), polling }) };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const siteItems = $derived(vaultSiteItems(snapshot.snapshot));
  const selectedStatus = $derived(snapshot.snapshot?.sites[snapshot.selectedSite] ?? null);
  let proxyDraft = $state("");
  let proxyVisible = $state(false);
  let workspace = $state<HTMLElement>();
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;
  const elements = { get workspace(): HTMLElement | undefined { return workspace; } };

  const proxyValidation = $derived(validateAuthorizationProxyInput(proxyDraft));
  const controls = $derived(deriveVaultControls(snapshot.snapshot, {
    busy: snapshot.busy,
    proxyInputValid: proxyValidation.valid,
  }));
  const presentation = $derived(deriveVaultWorkspacePresentation(snapshot.snapshot, snapshot.selectedSite, snapshot.phase));

  function statusKind(status: typeof selectedStatus): string {
    if (!status) return "error";
    if (status.session.active) return "running";
    if (status.method === "anonymous") return "ready";
    if (status.invalidated || (status.configured && !status.materialValid)) return "error";
    if (status.authorized && status.materialValid) return "warning";
    return "disabled";
  }

  function statusLabel(status: typeof selectedStatus): string {
    if (!status) return "状态不可用";
    if (status.session.active) return "授权进行中";
    if (status.method === "anonymous") return "无需登录";
    if (status.invalidated) return "凭证已失效";
    if (status.authorized && status.materialValid) return "凭证已保存，待验证";
    if (status.configured) return "凭证不可用";
    return "未授权";
  }

  function sessionLabel(state: string): string {
    const labels: Readonly<Record<string, string>> = {
      none: "无记录", starting: "正在开始", starting_browser: "正在启动授权浏览器",
      awaiting_login: "等待登录", awaiting_code: "等待授权确认", exchanging: "正在确认授权",
      authorized: "已授权", cancelled: "已取消", timed_out: "已超时", failed: "失败", token_ready: "登录令牌已就绪",
    };
    return labels[state] ?? "状态不可用";
  }

  function boolLabel(value: boolean): string {
    return value ? "是" : "否";
  }

  function proxySourceLabel(source: string): string {
    return source === "runtime" ? "授权管理设置" : source === "config" ? "配置文件默认值" : "未设置";
  }

  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function restoreVaultFocus(target: FocusTarget | null = returnFocus): void {
    if (!restoreFocus(target)) elements.workspace?.focus({ preventScroll: true });
    returnFocus = null;
  }

  function resolveConfirmation(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    clearSensitiveInputs();
    void controller.confirmAction(confirmed);
    void tick().then(() => restoreVaultFocus(target));
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

  $effect(() => {
    if (!snapshot.confirmation) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (confirmationDialog && !confirmationDialog.open && typeof confirmationDialog.showModal === "function") confirmationDialog.showModal();
      restoreFocus(focusableDialogItems()[0] ?? confirmationDialog);
    });
  });

  function clearSensitiveInputs(): void {
    proxyDraft = "";
    proxyVisible = false;
  }

  async function saveProxy(): Promise<void> {
    const value = proxyDraft;
    clearSensitiveInputs();
    await controller.saveProxy(value);
  }

  function selectSite(site: VaultSiteId): void {
    clearSensitiveInputs();
    void controller.selectSite(site);
  }

  function refresh(): void {
    clearSensitiveInputs();
    void controller.refresh();
  }

  function authorizeSelected(): void {
    clearSensitiveInputs();
    void controller.authorize(snapshot.selectedSite);
  }

  onMount(() => {
    const unregisterUnsaved = registerUnsavedChanges?.(() => Boolean(proxyDraft), clearSensitiveInputs) ?? (() => {});
    controller.activate();
    return () => {
      unregisterUnsaved();
      controller.deactivate();
      proxyDraft = "";
      controller.destroy();
    };
  });
</script>

<section class="vault-app" data-vault-app data-domain-owner="vault" aria-labelledby="vault-heading" aria-busy={Boolean(snapshot.busy)}>
  <header class="vault-header">
    <div><p>授权管理</p><h1 id="vault-heading">站点材料与共享恢复</h1></div>
    <div class="vault-header-actions"><span class="vault-status" data-vault-workspace-state={presentation.state} data-kind={presentation.kind}>{presentation.label}</span><button type="button" class="vault-button" disabled={controls.refresh.disabled} onclick={refresh}>{controls.refresh.label}</button></div>
  </header>

  {#if snapshot.error}
    <section class="vault-error" role="alert" aria-labelledby="vault-error-title">
      <strong id="vault-error-title">{snapshot.error.title}</strong>
      <p>{snapshot.error.message} {snapshot.error.nextStep}</p>
      <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
    </section>
  {/if}
  <p class="vault-live" aria-live="polite">{snapshot.message} {presentation.message}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable Vault workspace) -->
  <section class="vault-workspace" tabindex="0" bind:this={workspace} aria-label="授权管理三栏工作区，可横向滚动查看站点、材料与共享恢复">
    <div class="vault-workspace-track">
      <nav class="vault-column vault-column--navigation" aria-labelledby="vault-sites-heading">
        <header><p>01 · 站点</p><h2 id="vault-sites-heading">授权目标</h2><span>固定顺序显示五个后端支持的站点。</span></header>
        <div class="vault-column-scroll">
          <div class="vault-site-nav" role="list" aria-label="授权站点">
            {#each siteItems as item (item.definition.id)}
              <button
                type="button"
                class="vault-site-nav-button"
                data-vault-action={`site:${item.definition.id}`}
                aria-current={snapshot.selectedSite === item.definition.id ? "true" : undefined}
                disabled={Boolean(snapshot.busy)}
                onclick={() => selectSite(item.definition.id)}
              >
                <span class="vault-site-mark" aria-hidden="true">{item.definition.mark}</span>
                <span><strong>{item.definition.label}</strong><small>{item.status ? statusLabel(item.status) : "尚未读取"}</small></span>
              </button>
            {/each}
          </div>
          <p class="vault-proof-note">◆ 状态说明 · 站点状态来自服务安全投影；页面不保存 Cookie、Token 或浏览器地址。</p>
        </div>
      </nav>

      <main class="vault-column vault-column--materials" aria-labelledby="vault-materials-heading">
        <header><p>02 · 材料与会话</p><h2 id="vault-materials-heading">{selectedStatus?.label ?? getVaultSiteDefinition(snapshot.selectedSite)?.label ?? "授权站点"}</h2><span>只展示是否存在、是否有效和活动会话事实。</span></header>
        <div class="vault-column-scroll">
          <section class="vault-waiting-host" data-vault-workspace-state={presentation.state} aria-live="polite">
            <span class="vault-status" data-kind={presentation.kind}>{presentation.label}</span>
            <p>{presentation.message}</p>
          </section>

          {#if selectedStatus}
            <section class="vault-site-card" data-site-state={statusKind(selectedStatus)} aria-labelledby="vault-site-facts-heading">
              <div class="vault-section-heading"><h3 id="vault-site-facts-heading">站点事实</h3><span class="vault-status" data-kind={statusKind(selectedStatus)}>{statusLabel(selectedStatus)}</span></div>
              <dl class="vault-definition-list">
                <div><dt>访问方式</dt><dd>{selectedStatus.method === "anonymous" ? "公开访问" : selectedStatus.method === "oauth" ? "Pixiv 登录令牌" : "托管浏览器 Cookie"}</dd></div>
                <div><dt>已配置材料</dt><dd>{boolLabel(selectedStatus.configured)}</dd></div>
                <div><dt>材料有效</dt><dd>{boolLabel(selectedStatus.materialValid)}</dd></div>
                <div><dt>Cookie 数量</dt><dd>{selectedStatus.method === "managed_browser" ? selectedStatus.cookieCount : "不适用"}</dd></div>
                <div><dt>最近会话</dt><dd>{selectedStatus.session.present ? sessionLabel(selectedStatus.session.state) : "无记录"}</dd></div>
                <div><dt>最近更新</dt><dd>{formatVaultTime(selectedStatus.updatedAt)}</dd></div>
              </dl>
            </section>

            {#if selectedStatus.session.present}
              <section class="vault-session-card" aria-labelledby="vault-session-heading">
                <h3 id="vault-session-heading">授权会话</h3>
                <p class="vault-session-state" data-kind={selectedStatus.session.active ? "running" : "disabled"}>{selectedStatus.session.active ? "活动会话 · " : "最近会话 · "}{sessionLabel(selectedStatus.session.state)}</p>
                <p>活动会话只在当前选中站点上以 800ms 前台频率读取；会话结束后自动停止并完整确认。</p>
              </section>
            {/if}

            <section class="vault-action-panel" aria-labelledby="vault-site-actions-heading">
              <h3 id="vault-site-actions-heading">站点操作</h3>
              <div class="vault-actions">
                {#if controls.sites[snapshot.selectedSite]?.showAuthorize}
                  <button type="button" class="vault-button vault-button--primary" disabled={controls.sites[snapshot.selectedSite].authorize.disabled} aria-describedby="vault-authorize-reason" onclick={authorizeSelected}>{controls.sites[snapshot.selectedSite].authorize.label}</button>
                {/if}
                {#if controls.sites[snapshot.selectedSite]?.showCancel}
                  <button type="button" class="vault-button vault-button--dangerous" disabled={controls.sites[snapshot.selectedSite].cancel.disabled} onclick={() => { clearSensitiveInputs(); controller.requestCancel(snapshot.selectedSite); }}>{controls.sites[snapshot.selectedSite].cancel.label}</button>
                {/if}
                {#if controls.sites[snapshot.selectedSite]?.showClear}
                  <button type="button" class="vault-button vault-button--dangerous" disabled={controls.sites[snapshot.selectedSite].clear.disabled} onclick={() => { clearSensitiveInputs(); controller.requestClearSite(snapshot.selectedSite); }}>{controls.sites[snapshot.selectedSite].clear.label}</button>
                {/if}
              </div>
              <p id="vault-authorize-reason" class="vault-field-error" aria-live="polite">{controls.sites[snapshot.selectedSite]?.authorize.reason ?? ""}</p>
            </section>
          {:else}
            <section class="vault-empty-state"><span class="vault-status" data-kind="disabled">等待站点状态</span><p>刷新后将在这里显示经过安全投影的站点事实。</p></section>
          {/if}
        </div>
      </main>

      <aside class="vault-column vault-column--recovery" aria-labelledby="vault-recovery-heading">
        <header><p>03 · 共享与恢复</p><h2 id="vault-recovery-heading">共享授权浏览器</h2><span>共享材料和登录代理只显示受控事实。</span></header>
        <div class="vault-column-scroll">
          <section class="vault-profile-status" aria-labelledby="vault-profile-heading">
            <h3 id="vault-profile-heading">共享授权浏览器数据</h3>
            {#if snapshot.snapshot?.browserProfile}
              <dl class="vault-definition-list">
                <div><dt>共享配置</dt><dd>{boolLabel(snapshot.snapshot.browserProfile.shared)}</dd></div>
                <div><dt>数据存在</dt><dd>{boolLabel(snapshot.snapshot.browserProfile.present)}</dd></div>
                <div><dt>正在运行</dt><dd>{boolLabel(snapshot.snapshot.browserProfile.running)}</dd></div>
                <div><dt>正在清理</dt><dd>{boolLabel(snapshot.snapshot.browserProfile.resetting)}</dd></div>
              </dl>
            {:else}<p class="empty-state">尚未读取共享浏览器状态。</p>{/if}
            <button type="button" class="vault-button vault-button--dangerous" disabled={controls.profileClear.disabled} onclick={() => { clearSensitiveInputs(); controller.requestClearProfile(); }}>{controls.profileClear.label}</button>
          </section>

          <section class="vault-proxy-panel" aria-labelledby="vault-proxy-heading">
            <h3 id="vault-proxy-heading">登录代理</h3>
            {#if snapshot.snapshot?.authorizationProxy}
              <p class="vault-proxy-fact">{snapshot.snapshot.authorizationProxy.configured ? snapshot.snapshot.authorizationProxy.displayEndpoint : "直连（未设置登录代理）"}</p>
              <dl class="vault-definition-list">
                <div><dt>设置来源</dt><dd>{proxySourceLabel(snapshot.snapshot.authorizationProxy.source)}</dd></div>
                <div><dt>最近更新</dt><dd>{formatVaultTime(snapshot.snapshot.authorizationProxy.updatedAt)}</dd></div>
                <div><dt>凭据显示</dt><dd>{snapshot.snapshot.authorizationProxy.credentialsRedacted ? "账号信息已隐藏" : "响应未包含账号信息"}</dd></div>
              </dl>
              <p class="vault-proxy-note">{snapshot.snapshot.authorizationProxy.restartPending ? "当前授权浏览器仍使用原线路；下次授权时应用新设置。" : snapshot.snapshot.authorizationProxy.browserRunning ? "授权浏览器正在运行。" : "新设置将在下次授权时使用。"}</p>
            {:else}<p class="empty-state">尚未读取登录代理状态。</p>{/if}
            <form onsubmit={(event) => { event.preventDefault(); void saveProxy(); }}>
              <label class="vault-field">
                <span>代理地址（留空表示直连）</span>
                <span class="vault-secret-input-wrap"><input class="vault-secret-input" type="text" data-revealed={proxyVisible ? "true" : "false"} maxlength="300" spellcheck="false" inputmode="url" autocomplete="off" aria-describedby="vault-proxy-input-error" bind:value={proxyDraft} /><button type="button" class="vault-reveal" aria-label={proxyVisible ? "隐藏代理输入" : "显示代理输入"} aria-pressed={proxyVisible} onclick={() => { proxyVisible = !proxyVisible; }}>◉</button></span>
              </label>
              <p id="vault-proxy-input-error" class="vault-field-error" aria-live="polite">{proxyDraft ? proxyValidation.error : ""}</p>
              <div class="vault-actions"><button type="submit" class="vault-button vault-button--primary" disabled={controls.proxySave.disabled}>{controls.proxySave.label}</button><button type="button" class="vault-button vault-button--dangerous" disabled={controls.proxyReset.disabled} onclick={() => { clearSensitiveInputs(); controller.requestResetProxy(); }}>{controls.proxyReset.label}</button></div>
            </form>
          </section>

          <section class="vault-danger-zone" aria-labelledby="vault-danger-heading">
            <h3 id="vault-danger-heading">危险操作</h3>
            <p>清理共享授权浏览器或恢复登录代理默认值前会再次确认；采集代理池不受影响。</p>
          </section>
        </div>
      </aside>
    </div>
  </section>
</section>

{#if snapshot.confirmation}
  <dialog
    class="vault-confirmation"
    data-vault-confirmation={snapshot.confirmation.action}
    aria-modal="true"
    aria-labelledby="vault-confirmation-title"
    aria-describedby="vault-confirmation-message vault-confirmation-warning"
    bind:this={confirmationDialog}
    oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }}
    onkeydown={onConfirmationKeydown}
    onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}
  >
    <section>
      <h2 id="vault-confirmation-title">{snapshot.confirmation.title}</h2>
      <p id="vault-confirmation-message">{snapshot.confirmation.message}</p>
      <p id="vault-confirmation-warning" class="vault-confirmation__warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p>
      <div><button type="button" onclick={() => resolveConfirmation(false)}>取消</button><button type="button" class="vault-button vault-button--dangerous" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button></div>
    </section>
  </dialog>
{/if}
