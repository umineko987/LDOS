<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { PollingService } from "../../core/polling/service";
  import { createProxyController } from "./controller";
  import {
    PROXY_NODE_RENDER_LIMIT,
    proxyControls,
    proxyWorkspace,
    validateInlineNodeInput,
    validateNodeFileInput,
    validateSubscriptionInput,
  } from "./model";
  import { createProxyService } from "./service";
  import { createProxyStore, proxyInlineNodes, proxyNodes, proxySubscriptions } from "./state";
  import "./proxy.css";

  let { api, polling }: { api: ApiClient; polling: PollingService } = $props();

  const runtime = untrack(() => {
    const store = createProxyStore();
    return {
      store,
      controller: createProxyController({ store, service: createProxyService(api), polling }),
    };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const nodes = $derived(proxyNodes(snapshot).slice(0, PROXY_NODE_RENDER_LIMIT));
  const subscriptions = $derived(proxySubscriptions(snapshot));
  const inlineNodes = $derived(proxyInlineNodes(snapshot));
  const controls = $derived(proxyControls(snapshot.status, snapshot.busy));
  const workspace = $derived(proxyWorkspace(snapshot.status, snapshot.sources, snapshot.phase));

  let subscriptionDraft = $state("");
  let nodeFileDraft = $state("");
  let inlineDraft = $state("");
  let replacement = $state<{ kind: "subscription" | "inline"; id: string; value: string } | null>(null);
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;

  function clearDrafts(): void {
    subscriptionDraft = "";
    nodeFileDraft = "";
    inlineDraft = "";
    replacement = null;
  }

  function sourceEditable(): boolean {
    return Boolean(snapshot.sources?.runtimeOverrideValid && !snapshot.busy);
  }

  function inputMessage(kind: "subscription" | "node-file" | "inline", value: string, multiple = false): string {
    const result = kind === "subscription"
      ? validateSubscriptionInput(value)
      : kind === "node-file"
        ? validateNodeFileInput(value)
        : validateInlineNodeInput(value, multiple);
    if (result.valid || !value) return "";
    const line = result.index === null ? "当前字段" : `第 ${result.index + 1} 行`;
    const labels: Readonly<Record<string, string>> = {
      empty: "不能为空", too_long: "超过长度上限", total_too_large: "总内容超过大小上限",
      too_many: "节点数量超过上限", control_character: "包含控制字符",
      unsupported_scheme: "协议不受支持", missing_host: "缺少主机名", malformed: "格式无效",
      invalid_type: "输入格式无效",
    };
    return `${line}：${labels[result.reason] ?? "格式无效"}`;
  }

  async function submitSubscription(): Promise<void> {
    const value = subscriptionDraft;
    subscriptionDraft = "";
    await controller.addSubscription(value);
  }

  async function submitNodeFile(): Promise<void> {
    const value = nodeFileDraft;
    nodeFileDraft = "";
    await controller.setNodeFile(value);
  }

  async function submitInline(): Promise<void> {
    const value = inlineDraft;
    inlineDraft = "";
    await controller.addInlineNodes(value);
  }

  async function submitReplacement(): Promise<void> {
    const draft = replacement;
    replacement = null;
    if (!draft) return;
    if (draft.kind === "subscription") await controller.replaceSubscription(draft.id, draft.value);
    else await controller.replaceInlineNode(draft.id, draft.value);
  }

  function shortRevision(value: string | null | undefined): string {
    return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
  }

  function latency(value: number | null): string {
    if (value === null) return "尚无数据";
    return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
  }

  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function resolveConfirmation(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    clearDrafts();
    void controller.confirmRemove(confirmed);
    void tick().then(() => restoreFocus(target));
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
      if (confirmationDialog && !confirmationDialog.open && typeof confirmationDialog.showModal === "function") {
        confirmationDialog.showModal();
      }
      restoreFocus(focusableDialogItems()[0] ?? confirmationDialog);
    });
  });

  function displayMessage(message: string): string {
    return message.replace("完成后将权威重读", "操作完成后会更新").replace("服务端权威读取", "服务").replace("安全事实", "信息").replace("权威状态", "状态");
  }

  onMount(() => {
    controller.activate();
    return () => {
      clearDrafts();
      controller.destroy();
    };
  });
</script>

<section class="proxy-app" data-proxy-app data-domain-owner="proxy" aria-labelledby="proxy-heading" aria-busy={Boolean(snapshot.busy)}>
  <header class="proxy-header">
    <h1 id="proxy-heading">代理</h1>
    <span class="proxy-status" data-kind={workspace.kind}>{workspace.label}</span>
  </header>

  {#if snapshot.error}
    <section class="proxy-error" role="alert" aria-labelledby="proxy-error-title">
      <strong id="proxy-error-title">{snapshot.error.title}</strong>
      <p>{snapshot.error.message} {snapshot.error.nextStep}</p>
      {#if snapshot.error.detail}<small>{snapshot.error.detail}</small>{/if}
      <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
    </section>
  {/if}
  <p class="proxy-live" role="status" aria-live="polite">{displayMessage(snapshot.message)} {displayMessage(workspace.message)}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable proxy workspace) -->
  <section class="proxy-workspace" tabindex="0" aria-label="代理设置；可纵向滚动">
    <div class="proxy-workspace__track">
      <aside class="proxy-column proxy-column--status" aria-labelledby="proxy-status-heading">
        <header><h2 id="proxy-status-heading">运行状态</h2></header>
        <div class="proxy-column__scroll" tabindex="0" aria-label="代理状态内容；可滚动">
          {#if snapshot.status}
            <div class="proxy-metrics" aria-label="代理统计">
              <div><span>节点总数</span><strong>{snapshot.status.total}</strong></div>
              <div><span>健康</span><strong>{snapshot.status.healthy}</strong></div>
              <div><span>可重试</span><strong>{snapshot.status.retryEligible}</strong></div>
              <div><span>正在使用</span><strong>{snapshot.status.leases}</strong></div>
            </div>
            <section class="proxy-panel"><h3>运行设置</h3><dl>
              <div><dt>启用</dt><dd>{snapshot.status.enabled ? "是" : "否"}</dd></div>
              <div><dt>运行</dt><dd>{snapshot.status.running ? "运行中" : "已停止"}</dd></div>
              <div><dt>引擎</dt><dd>{snapshot.status.engine}</dd></div>
              <div><dt>管理方式</dt><dd>{snapshot.status.managedByBackend ? "由服务管理" : "未知"}</dd></div>
              <div><dt>自动启动</dt><dd>{snapshot.status.autoStart ? "已启用" : "未启用"}</dd></div>
              <div><dt>最近错误</dt><dd>{snapshot.status.lastError || "无"}</dd></div>
            </dl></section>
            <section class="proxy-panel"><h3>Mihomo / 传输核心</h3><dl>
              <div><dt>启用</dt><dd>{snapshot.status.transportCore.enabled ? "是" : "否"}</dd></div>
              <div><dt>运行</dt><dd>{snapshot.status.transportCore.running ? "是" : "否"}</dd></div>
              <div><dt>监听端口数</dt><dd>{snapshot.status.transportCore.listeners}</dd></div>
              <div><dt>最近错误</dt><dd>{snapshot.status.transportCore.lastError || "无"}</dd></div>
            </dl></section>
            <section class="proxy-panel"><h3>配置版本</h3><dl>
              <div><dt>已保存</dt><dd>{shortRevision(snapshot.status.configuredRevision)}</dd></div>
              <div><dt>当前运行</dt><dd>{shortRevision(snapshot.status.activeRevision)}</dd></div>
              <div><dt>关系</dt><dd>{snapshot.status.reloadRequired ? "有更新" : "已生效"}</dd></div>
            </dl></section>
          {:else}<p class="proxy-empty">状态正在加载。</p>{/if}
        </div>
      </aside>

      <section class="proxy-column" aria-labelledby="proxy-runtime-heading">
        <header><h2 id="proxy-runtime-heading">运行池</h2></header>
        <div class="proxy-column__scroll" tabindex="0" aria-label="代理运行池内容；可滚动">
          <div class="proxy-action-panel" aria-label="代理池操作">
            <div class="proxy-actions" aria-label="代理池操作">
              <button type="button" disabled={controls.start} aria-describedby={controls.start ? "proxy-start-reason" : undefined} onclick={() => void controller.runtime("start")}>{snapshot.busy === "start" ? "正在启动…" : "启动代理池"}</button>
              <button type="button" class="danger" disabled={controls.stop} aria-describedby={controls.stop ? "proxy-stop-reason" : undefined} onclick={() => void controller.runtime("stop")}>{snapshot.busy === "stop" ? "正在停止…" : "停止代理池"}</button>
              <button type="button" class="primary" disabled={controls.reload} aria-describedby={controls.reload ? "proxy-reload-reason" : undefined} onclick={() => void controller.runtime("reload")}>{snapshot.busy === "reload" ? "正在应用…" : "应用并重新加载"}</button>
              <button type="button" disabled={controls.probe} aria-describedby={controls.probe ? "proxy-probe-reason" : undefined} onclick={() => void controller.runtime("probe")}>{snapshot.busy === "probe" ? "正在检测…" : "检测全部节点"}</button>
              <button type="button" disabled={controls.refresh} onclick={() => void controller.refresh()}>{snapshot.busy === "refresh" ? "正在刷新…" : "刷新"}</button>
            </div>
            <div class="proxy-control-reasons" aria-live="polite">
              {#if controls.start}<span id="proxy-start-reason">启动：代理池当前不可启动。</span>{/if}
              {#if controls.stop}<span id="proxy-stop-reason">停止：当前有正在使用代理的任务或代理池未运行。</span>{/if}
              {#if controls.reload}<span id="proxy-reload-reason">应用：没有待应用配置，或当前有任务正在使用代理。</span>{/if}
              {#if controls.probe}<span id="proxy-probe-reason">检测：请先启动代理池。</span>{/if}
            </div>
          </div>
          <p class="proxy-control-note">{snapshot.status?.leases ? `仍有 ${snapshot.status.leases} 项正在使用代理；不会强制停止。` : "停止操作不会中断正在使用代理的任务。"}</p>
          <section class="proxy-nodes" aria-labelledby="proxy-nodes-heading">
            <div class="proxy-section-heading"><h3 id="proxy-nodes-heading">代理节点</h3><span>显示 {nodes.length} / {snapshot.status?.nodeRowsReceived ?? 0}</span></div>
            {#each nodes as node (node.id)}
              <article class="proxy-node" data-node-id={node.id} data-leased={node.refCount > 0 ? "true" : undefined}>
                <div><strong>{node.name}</strong><code>{node.protocol.toUpperCase()} · {node.endpoint}</code></div>
                <span class="proxy-status" data-kind={node.healthy ? "ready" : node.retryEligible ? "warning" : "error"}>{node.healthy ? "健康" : node.retryEligible ? "可重试" : "冷却或失败"}</span>
                <dl>
                  <div><dt>占用状态</dt><dd>{node.refCount ? `使用中 · ${node.refCount}` : "未使用"}</dd></div>
                  <div><dt>最近延迟</dt><dd>{latency(node.lastLatencyMs)}</dd></div>
                  <div><dt>累计成功/失败</dt><dd>{node.successCount} / {node.failCount}</dd></div>
                  <div><dt>最近错误</dt><dd>{node.lastError || "无"}</dd></div>
                </dl>
              </article>
            {:else}<p class="proxy-empty">尚未收到可显示的代理节点。</p>{/each}
            {#if (snapshot.status?.nodeRowsReceived ?? 0) > nodes.length}<p class="proxy-control-note">为保证页面流畅，最多显示前 {PROXY_NODE_RENDER_LIMIT} 个节点；完整数量以上方统计为准。</p>{/if}
          </section>
        </div>
      </section>

      <aside class="proxy-column" aria-labelledby="proxy-sources-heading">
        <header><h2 id="proxy-sources-heading">节点来源</h2><span>保存后需点击“应用并重新加载”才能生效。</span></header>
        <div class="proxy-column__scroll" tabindex="0" aria-label="代理来源内容；可滚动">
          {#if snapshot.sources}
            <section class="proxy-panel"><h3>来源摘要</h3><dl>
              <div><dt>当前来源</dt><dd>{snapshot.sources.source === "runtime" ? "界面自定义配置" : snapshot.sources.source === "config" ? "配置文件默认值" : "未配置"}</dd></div>
              <div><dt>设置有效</dt><dd>{snapshot.sources.runtimeOverrideValid ? "是" : "否"}</dd></div>
              <div><dt>订阅 / 文件 / 手动</dt><dd>{snapshot.sources.counts.subscriptions} / {snapshot.sources.counts.nodeFile} / {snapshot.sources.counts.inlineNodes}</dd></div>
              <div><dt>应用状态</dt><dd>{snapshot.sources.reloadRequired ? "有配置待应用" : "已生效"}</dd></div>
            </dl></section>
            {#if !snapshot.sources.runtimeOverrideValid}<p class="proxy-error" role="alert">界面自定义配置已损坏；恢复默认设置后再编辑。</p>{/if}
          {/if}

          <section class="proxy-source-group" aria-labelledby="proxy-subscriptions-heading">
            <h3 id="proxy-subscriptions-heading">订阅地址 · {snapshot.sources?.counts.subscriptions ?? 0}</h3>
            {#each subscriptions as item (item.id)}
              <article class="proxy-source-card" data-source-id={item.id}>
                <strong>{item.displayUrl}</strong><p>{item.scheme.toUpperCase()} · {item.host || "主机已隐藏"}{item.port ? `:${item.port}` : ""}</p>
                <small>{item.redacted ? "敏感部分已脱敏" : "未包含额外敏感部分"}</small>
                <div class="proxy-row-actions"><button type="button" disabled={!sourceEditable()} onclick={() => { clearDrafts(); replacement = { kind: "subscription", id: item.id, value: "" }; }}>替换</button><button type="button" class="danger" disabled={!sourceEditable()} onclick={() => controller.requestRemove("subscription-delete", item.id)}>删除</button></div>
                {#if replacement?.kind === "subscription" && replacement.id === item.id}
                  <form onsubmit={(event) => { event.preventDefault(); void submitReplacement(); }}>
                    <label class="proxy-field"><span>完整新订阅地址</span><input type="url" autocomplete="off" value={replacement.value} oninput={(event) => { if (replacement) replacement.value = (event.currentTarget as HTMLInputElement).value; }} /></label>
                    <p class="proxy-validation" role="status">{inputMessage("subscription", replacement.value)}</p>
                    <div><button type="submit" disabled={!sourceEditable()}>保存替换</button><button type="button" onclick={() => { replacement = null; }}>取消</button></div>
                  </form>
                {/if}
              </article>
            {:else}<p class="proxy-empty">尚未配置订阅地址。</p>{/each}
            <form onsubmit={(event) => { event.preventDefault(); void submitSubscription(); }}>
              <label class="proxy-field"><span>添加完整订阅地址</span><input type="url" autocomplete="off" bind:value={subscriptionDraft} /></label>
              <p class="proxy-validation" role="status">{inputMessage("subscription", subscriptionDraft)}</p>
              <button type="submit" disabled={!sourceEditable()}>保存订阅</button>
            </form>
          </section>

          <section class="proxy-source-group" aria-labelledby="proxy-file-heading">
            <h3 id="proxy-file-heading">节点文件</h3>
            {#if snapshot.sources?.nodeFile.configured}
              <article class="proxy-source-card"><strong>{snapshot.sources.nodeFile.displayPath || "路径已隐藏"}</strong><button type="button" class="danger" disabled={!sourceEditable()} onclick={() => controller.requestRemove("node-file-clear")}>清除节点文件</button></article>
            {/if}
            <form onsubmit={(event) => { event.preventDefault(); void submitNodeFile(); }}>
              <label class="proxy-field"><span>允许目录中的节点文件</span><input type="text" autocomplete="off" bind:value={nodeFileDraft} /></label>
              <p class="proxy-validation" role="status">{inputMessage("node-file", nodeFileDraft)}</p>
              <button type="submit" disabled={!sourceEditable()}>保存节点文件</button>
            </form>
          </section>

          <section class="proxy-source-group" aria-labelledby="proxy-inline-heading">
            <h3 id="proxy-inline-heading">手动节点 · {snapshot.sources?.counts.inlineNodes ?? 0}</h3>
            {#each inlineNodes as item (item.id)}
              <article class="proxy-source-card" data-source-id={item.id}>
                <strong>{item.displayEndpoint}</strong><p>{item.scheme.toUpperCase()} · {item.host || "主机已隐藏"}{item.port ? `:${item.port}` : ""}</p><small>{item.requiresTransportCore ? "需要 Mihomo 传输核心" : "无需 Mihomo 传输核心"}</small>
                <div class="proxy-row-actions"><button type="button" disabled={!sourceEditable()} onclick={() => { clearDrafts(); replacement = { kind: "inline", id: item.id, value: "" }; }}>替换</button><button type="button" class="danger" disabled={!sourceEditable()} onclick={() => controller.requestRemove("inline-delete", item.id)}>删除</button></div>
                {#if replacement?.kind === "inline" && replacement.id === item.id}
                  <form onsubmit={(event) => { event.preventDefault(); void submitReplacement(); }}>
                    <label class="proxy-field"><span>完整新节点</span><textarea rows="3" autocomplete="off" value={replacement.value} oninput={(event) => { if (replacement) replacement.value = (event.currentTarget as HTMLTextAreaElement).value; }}></textarea></label>
                    <p class="proxy-validation" role="status">{inputMessage("inline", replacement.value)}</p>
                    <div><button type="submit" disabled={!sourceEditable()}>保存替换</button><button type="button" onclick={() => { replacement = null; }}>取消</button></div>
                  </form>
                {/if}
              </article>
            {:else}<p class="proxy-empty">尚未配置手动节点。</p>{/each}
            <form onsubmit={(event) => { event.preventDefault(); void submitInline(); }}>
              <label class="proxy-field"><span>批量添加手动节点（每行一个）</span><textarea rows="6" autocomplete="off" bind:value={inlineDraft}></textarea></label>
              <p class="proxy-validation" role="status">{inputMessage("inline", inlineDraft, true)}</p>
              <button type="submit" disabled={!sourceEditable()}>批量保存节点</button>
            </form>
          </section>

          <section class="proxy-danger-zone" aria-labelledby="proxy-danger-heading"><h3 id="proxy-danger-heading">危险操作</h3><p>删除界面保存的来源并恢复配置文件默认值；运行池不会自动更新。</p><button type="button" class="danger" disabled={Boolean(snapshot.busy || !snapshot.sources?.hasRuntimeOverride)} onclick={() => controller.requestRemove("override-reset")}>恢复配置文件默认值</button></section>
        </div>
      </aside>
    </div>
  </section>
</section>

{#if snapshot.confirmation}
  <dialog
    class="proxy-confirmation"
    data-proxy-confirmation={snapshot.confirmation.action}
    aria-modal="true"
    aria-labelledby="proxy-confirmation-title"
    aria-describedby="proxy-confirmation-message proxy-confirmation-warning"
    bind:this={confirmationDialog}
    oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }}
    onkeydown={onConfirmationKeydown}
    onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}
  >
    <section>
      <h2 id="proxy-confirmation-title">{snapshot.confirmation.title}</h2>
      <p id="proxy-confirmation-message">{snapshot.confirmation.message}</p>
      <p id="proxy-confirmation-warning" class="proxy-confirmation__warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p>
      <div><button type="button" onclick={() => resolveConfirmation(false)}>取消</button><button type="button" class="danger" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button></div>
    </section>
  </dialog>
{/if}
