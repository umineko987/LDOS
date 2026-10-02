<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { PollingService } from "../../core/polling/service";
  import { createPlatformAdapter } from "../../core/platform/adapter";
  import { createVaultController } from "./controller";
  import {
    deriveVaultControls,
    deriveVaultWorkspacePresentation,
    formatVaultTime,
    getVaultSiteDefinition,
    validateAuthorizationProxyInput,
    vaultSiteItems,
    vaultErrorPresentation,
    type VaultBrowserRuntime,
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
    const service = createVaultService(api);
    return { store, service, controller: createVaultController({ store, service, polling }) };
  });
  const platform = untrack(() => createPlatformAdapter());
  const { store, service, controller } = runtime;
  const snapshot = $derived($store);
  const siteItems = $derived(vaultSiteItems(snapshot.snapshot));
  const selectedStatus = $derived(snapshot.snapshot?.sites[snapshot.selectedSite] ?? null);
  let proxyDraft = $state("");
  let proxyVisible = $state(false);
  let workspace = $state<HTMLElement>();
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;
  let browserRuntime = $state<VaultBrowserRuntime | null>(null);
  let browserBusy = $state<"read" | "detect" | "select" | "">("");
  let browserError = $state("");
  let browserController: AbortController | null = null;
  const elements = { get workspace(): HTMLElement | undefined { return workspace; } };

  const proxyValidation = $derived(validateAuthorizationProxyInput(proxyDraft));
  const controls = $derived(deriveVaultControls(snapshot.snapshot, {
    busy: snapshot.busy,
    proxyInputValid: proxyValidation.valid,
  }));
  const presentation = $derived(deriveVaultWorkspacePresentation(snapshot.snapshot, snapshot.selectedSite, snapshot.phase));

  const browserChangeDisabled = $derived(Boolean(snapshot.busy || browserBusy || controls.activeSite));
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

  function browserFailure(error: unknown): void {
    const failure = vaultErrorPresentation(error);
    browserError = `${failure.message} ${failure.nextStep}`.trim();
  }

  async function readBrowser(): Promise<void> {
    browserController?.abort();
    const request = new AbortController();
    browserController = request;
    browserBusy = "read";
    browserError = "";
    try {
      browserRuntime = await service.readBrowser(request.signal);
    } catch (error) {
      if (!request.signal.aborted) browserFailure(error);
    } finally {
      if (browserController === request) {
        browserController = null;
        browserBusy = "";
      }
    }
  }

  async function detectBrowser(): Promise<void> {
    if (browserChangeDisabled) return;
    const request = new AbortController();
    browserController?.abort();
    browserController = request;
    browserBusy = "detect";
    browserError = "";
    try {
      browserRuntime = await service.detectBrowser(request.signal);
    } catch (error) {
      if (!request.signal.aborted) browserFailure(error);
    } finally {
      if (browserController === request) {
        browserController = null;
        browserBusy = "";
      }
    }
  }

  async function selectBrowser(): Promise<void> {
    if (browserChangeDisabled || !platform.capabilities.selectBrowserExecutable) return;
    browserBusy = "select";
    browserError = "";
    let path: string | null;
    try {
      path = await platform.selectBrowserExecutable();
    } catch {
      browserBusy = "";
      browserError = "无法打开文件选择器，请重试。";
      return;
    }
    if (!path) {
      browserBusy = "";
      return;
    }
    const request = new AbortController();
    browserController?.abort();
    browserController = request;
    try {
      browserRuntime = await service.selectBrowser(path, request.signal);
    } catch (error) {
      if (!request.signal.aborted) browserFailure(error);
    } finally {
      path = null;
      if (browserController === request) {
        browserController = null;
        browserBusy = "";
      }
    }
  }

  function displayMessage(message: string): string {
    return message.replace("操作完成后将权威重读", "操作完成后会更新").replace("安全授权事实", "授权信息").replace("安全事实", "信息").replace("权威授权状态", "授权状态").replace("；仅当前站点会自动轮询", "");
  }

  onMount(() => {
    const unregisterUnsaved = registerUnsavedChanges?.(() => Boolean(proxyDraft), clearSensitiveInputs) ?? (() => {});
    controller.activate();
    void readBrowser();
    return () => {
      unregisterUnsaved();
      controller.deactivate();
      proxyDraft = "";
      browserController?.abort();
      browserController = null;
      controller.destroy();
    };
  });
</script>

<section class="vault-app" data-vault-app data-domain-owner="vault" aria-labelledby="vault-heading" aria-busy={Boolean(snapshot.busy)}>
  <header class="vault-header">
    <h1 id="vault-heading">授权</h1>
    <div class="vault-header-actions"><span class="vault-status" data-vault-workspace-state={presentation.state} data-kind={presentation.kind}>{presentation.label}</span><button type="button" class="vault-button" disabled={controls.refresh.disabled} onclick={refresh}>{controls.refresh.label}</button></div>
  </header>

  {#if snapshot.error}
    <section class="vault-error" role="alert" aria-labelledby="vault-error-title">
      <strong id="vault-error-title">{snapshot.error.title}</strong>
      <p>{snapshot.error.message} {snapshot.error.nextStep}</p>
      <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
    </section>
  {/if}
  <p class="vault-live" aria-live="polite">{displayMessage(snapshot.message)} {displayMessage(presentation.message)}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable Vault workspace) -->
  <section class="vault-workspace" tabindex="0" bind:this={workspace} aria-label="站点授权设置；可纵向滚动">
    <div class="vault-workspace-track">
      <nav class="vault-column vault-column--navigation" aria-labelledby="vault-sites-heading">
        <header><h2 id="vault-sites-heading">选择站点</h2></header>
        <div class="vault-column-scroll" tabindex="0" aria-label="授权目标内容；可滚动">
          <div class="vault-site-nav" role="group" aria-label="授权站点">
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
        </div>
      </nav>

      <section class="vault-column vault-column--materials" aria-labelledby="vault-materials-heading">
        <header><h2 id="vault-materials-heading">{selectedStatus?.label ?? getVaultSiteDefinition(snapshot.selectedSite)?.label ?? "授权站点"}</h2></header>
        <div class="vault-column-scroll" tabindex="0" aria-label="授权材料与会话内容；可滚动">
          <section class="vault-waiting-host" data-vault-workspace-state={presentation.state} aria-live="polite">
            <span class="vault-status" data-kind={presentation.kind}>{presentation.label}</span>
            <p>{displayMessage(presentation.message)}</p>
          </section>

          {#if selectedStatus}
            <section class="vault-site-card" data-site-state={statusKind(selectedStatus)} aria-labelledby="vault-site-facts-heading">
              <div class="vault-section-heading"><h3 id="vault-site-facts-heading">授权状态</h3><span class="vault-status" data-kind={statusKind(selectedStatus)}>{statusLabel(selectedStatus)}</span></div>
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
                <p>请在打开的浏览器中完成登录，授权状态会自动更新。</p>
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
            <section class="vault-empty-state"><span class="vault-status" data-kind="disabled">等待站点状态</span><p>刷新后查看授权状态。</p></section>
          {/if}
        </div>
      </section>

      <aside class="vault-column vault-column--recovery" aria-labelledby="vault-recovery-heading">
        <header><h2 id="vault-recovery-heading">浏览器与登录代理</h2></header>
        <div class="vault-column-scroll" tabindex="0" aria-label="共享授权与恢复内容；可滚动">
          <section class="vault-browser-panel" aria-labelledby="vault-browser-heading" aria-busy={Boolean(browserBusy)}>
            <div class="vault-section-heading"><h3 id="vault-browser-heading">授权浏览器</h3><span class="vault-status" data-kind={browserBusy ? "running" : browserRuntime?.available ? "ready" : browserError ? "error" : "warning"}>{browserBusy === "select" ? "正在保存" : browserBusy ? "正在检测" : browserRuntime?.available ? "可用" : "未就绪"}</span></div>
            {#if browserRuntime}
              <p class="vault-browser-fact">{browserRuntime.available ? browserRuntime.name : "未检测到支持的浏览器"}</p>
              <p class="vault-proxy-note">{browserRuntime.message} · {browserRuntime.source === "configured" ? "手动选择" : browserRuntime.source === "auto" ? "自动检测" : "未配置"}</p>
            {:else}<p class="empty-state">正在检测 Chrome、Chromium 和 Microsoft Edge。</p>{/if}
            {#if browserError}<p class="vault-field-error" role="alert">{browserError}</p>{/if}
            <div class="vault-actions"><button type="button" class="vault-button" disabled={browserChangeDisabled} onclick={() => void detectBrowser()}>{browserBusy === "detect" ? "正在检测…" : "自动检测"}</button><button type="button" class="vault-button vault-button--primary" disabled={browserChangeDisabled || !platform.capabilities.selectBrowserExecutable} onclick={() => void selectBrowser()}>{browserBusy === "select" ? "正在保存…" : "选择浏览器"}</button></div>
            {#if !platform.capabilities.selectBrowserExecutable}<p class="vault-proxy-note">手动选择仅在桌面应用中可用。</p>{/if}
          </section>

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
