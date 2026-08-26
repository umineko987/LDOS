<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { ApiClient } from "../../core/api/client";
  import type { PollingService } from "../../core/polling/service";
  import { createDiagnosticsController } from "./controller";
  import { deriveDiagnosticsWorkspacePresentation, type DiagnosticsSnapshot } from "./model";
  import { createDiagnosticsService } from "./service";
  import { createDiagnosticsStore } from "./state";
  import "./diagnostics.css";

  let { api, polling, onNavigate }: { api: ApiClient; polling: PollingService; onNavigate: (appId: "proxy" | "tasks") => void } = $props();

  const runtime = untrack(() => {
    const store = createDiagnosticsStore();
    return { store, controller: createDiagnosticsController({ store, service: createDiagnosticsService(api), polling, onNavigate }) };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const presentation = $derived(deriveDiagnosticsWorkspacePresentation({ snapshot: snapshot.snapshot, refreshing: snapshot.busy }));

  function statusLabel(value: boolean | undefined): string {
    return value === true ? "正常" : value === false ? "异常" : "未知";
  }

  function componentKind(status: string): string {
    return status === "ok" ? "ready" : status === "disabled" ? "disabled" : status === "optional_missing" || status === "optional_warning" ? "warning" : "error";
  }

  function formatCheckedAt(value: number): string {
    try {
      return new Intl.DateTimeFormat("zh-CN", { hour12: false, dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
    } catch {
      return "时间不可用";
    }
  }

  function summary(snapshotValue: DiagnosticsSnapshot | null): string {
    return snapshotValue?.stale ? "显示上次成功读取的安全分区；陈旧事实已明确标记。" : "仅显示白名单能力和计数；不显示路径、凭据、完整配置或错误正文。";
  }

  function copySummary(): void { void controller.copySummary(); }
  function navigate(targetApp: string): void { void controller.navigate(targetApp); }

  onMount(() => {
    controller.activate();
    return () => controller.destroy();
  });
</script>

<section class="diagnostics-app" data-diagnostics-app data-domain-owner="diagnostics" aria-labelledby="diagnostics-heading" aria-busy={snapshot.busy}>
  <header class="diagnostics-header">
    <div><p>系统诊断</p><h1 id="diagnostics-heading">服务、配置与任务事实</h1></div>
    <div class="diagnostics-header-actions"><span class="diagnostics-status" data-kind={presentation.kind}>{presentation.label}</span><button type="button" disabled={snapshot.busy} onclick={() => void controller.refresh()}>{snapshot.busy ? "正在刷新…" : "刷新诊断"}</button></div>
  </header>
  <p class="diagnostics-live" role="status" aria-live="polite">{snapshot.message}</p>

  {#if snapshot.error}<section class="diagnostics-error" role="alert" aria-labelledby="diagnostics-error-title"><strong id="diagnostics-error-title">{snapshot.error.title}</strong><p>{snapshot.error.message} {snapshot.error.nextStep}</p></section>{/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable Diagnostics workspace) -->
  <section class="diagnostics-workspace" tabindex="0" aria-label="系统诊断三栏工作区；普通窗口可横向滚动">
    <div class="diagnostics-workspace-track">
      <aside class="diagnostics-column diagnostics-column--summary" aria-labelledby="diagnostics-summary-heading">
        <header><p>01 · 摘要</p><h2 id="diagnostics-summary-heading">连接与检查</h2><span>四项只读检查复用同一检查周期。</span></header>
        <div class="diagnostics-column-scroll" tabindex="0" aria-label="诊断摘要内容；可滚动">
          <section class="diagnostics-workspace-state" data-diagnostics-workspace-state={presentation.state} role="status" aria-live="polite"><span class="diagnostics-status" data-kind={presentation.kind}>{presentation.label}</span><p>{presentation.message}</p></section>
          <div class="diagnostics-actions"><button type="button" disabled={!snapshot.snapshot || snapshot.busy} onclick={copySummary}>复制诊断摘要</button><a href="/docs" target="_blank" rel="noreferrer noopener">打开 API 文档</a></div>
          {#if snapshot.snapshot}<div class="diagnostics-metrics"><div><span>连接</span><strong>{snapshot.snapshot.offline ? "离线" : "在线"}</strong></div><div><span>健康</span><strong>{statusLabel(snapshot.snapshot.health?.ok)}</strong></div><div><span>就绪</span><strong>{snapshot.snapshot.readiness?.ready ? "已就绪" : "未完全就绪"}</strong></div><div><span>检查时间</span><strong>{formatCheckedAt(snapshot.snapshot.lastCheckedAt)}</strong></div></div>{/if}
          <p class:diagnostics-stale-marker={snapshot.snapshot?.stale} class="diagnostics-boundary-note">{summary(snapshot.snapshot)}</p>
        </div>
      </aside>

      <main class="diagnostics-column diagnostics-column--facts" aria-labelledby="diagnostics-facts-heading">
        <header><p>02 · 服务事实</p><h2 id="diagnostics-facts-heading">安全配置与调度</h2><span>配置与 scheduler 均来自 diagnostics 白名单投影。</span></header>
        <div class="diagnostics-column-scroll" tabindex="0" aria-label="服务事实内容；可滚动">
          {#if snapshot.snapshot?.config}
            <section class="diagnostics-panel"><h3>安全配置</h3><dl class="diagnostics-definitions"><div><dt>回环监听</dt><dd>{snapshot.snapshot.config.loopbackOnly ? "是" : "否（异常）"}</dd></div><div><dt>CORS</dt><dd>{snapshot.snapshot.config.corsEnabled ? "已配置" : "未启用"}</dd></div><div><dt>私网目标</dt><dd>{snapshot.snapshot.config.privateTargetsEnabled ? "允许" : "禁止"}</dd></div><div><dt>授权缓存</dt><dd>{snapshot.snapshot.config.managedAuthCache ? "启用" : "禁用"}</dd></div><div><dt>代理池</dt><dd>{snapshot.snapshot.config.proxyEnabled ? `启用 · 自动启动 ${snapshot.snapshot.config.proxyAutoStart ? "开" : "关"}` : "禁用"}</dd></div><div><dt>任务容量</dt><dd>{snapshot.snapshot.config.schedulerCapacity}</dd></div><div><dt>去重配置</dt><dd>{snapshot.snapshot.config.dedupEnabled ? `${snapshot.snapshot.config.configuredDevice} · SSCD ${snapshot.snapshot.config.sscdEnabled ? "开" : "关"} · DINO ${snapshot.snapshot.config.dinoEnabled ? "开" : "关"}` : "禁用"}</dd></div></dl></section>
          {:else}<p class="diagnostics-empty">尚未读取安全配置。</p>{/if}
          {#if snapshot.snapshot?.scheduler}
            <section class="diagnostics-panel"><h3>任务调度</h3><dl class="diagnostics-definitions"><div><dt>任务调度器</dt><dd>{snapshot.snapshot.scheduler.tasksRunning ? "运行中" : "未运行"}</dd></div><div><dt>活动任务</dt><dd>{snapshot.snapshot.scheduler.activeTasks} / {snapshot.snapshot.scheduler.maxConcurrent}</dd></div><div><dt>活动来源数</dt><dd>{snapshot.snapshot.scheduler.activeSiteCount}</dd></div><div><dt>批次调度</dt><dd>{snapshot.snapshot.scheduler.crawlsRunning ? "运行中" : "未运行"}</dd></div><div><dt>活动批次</dt><dd>{snapshot.snapshot.scheduler.activeBatches}</dd></div><div><dt>执行方式</dt><dd>{snapshot.snapshot.scheduler.executionOrder} / {snapshot.snapshot.scheduler.addressParallelism}</dd></div></dl></section>
          {:else}<p class="diagnostics-empty">尚未读取任务调度状态。</p>{/if}
        </div>
      </main>

      <aside class="diagnostics-column diagnostics-column--components" aria-labelledby="diagnostics-components-heading">
        <header><p>03 · 组件与恢复</p><h2 id="diagnostics-components-heading">分领域诊断</h2><span>每个组件给出安全事实和下一步。</span></header>
        <div class="diagnostics-column-scroll" tabindex="0" aria-label="组件与恢复内容；可滚动">
          {#if snapshot.snapshot?.readiness?.components?.length}
            {#each snapshot.snapshot.readiness.components as component (component.id)}
              <article class="diagnostics-component" data-component-id={component.id}>
                <div class="diagnostics-component-heading"><h3>{component.label}</h3><span class="diagnostics-status" data-kind={componentKind(component.status)}>{component.statusLabel}</span></div>
                {#if component.detail}<p>{component.detail}</p>{/if}
                <div class="diagnostics-next-step"><strong>下一步</strong><p>{component.nextStep}</p></div>
                {#if component.targetApp === "proxy" || component.targetApp === "tasks"}<button type="button" onclick={() => navigate(component.targetApp)}>打开{component.targetApp === "proxy" ? "代理管理" : "批次管理"}</button>{/if}
              </article>
            {/each}
          {:else}<p class="diagnostics-empty">尚未读取组件状态。</p>{/if}
        </div>
      </aside>
    </div>
  </section>
</section>
