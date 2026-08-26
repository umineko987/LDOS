<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import type { ApplicationId } from "../../core/applications/definitions";
  import type { ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import type { PersistenceService } from "../../core/persistence/service";
  import type { PollingService } from "../../core/polling/service";
  import { createTasksController } from "./controller";
  import {
    deriveBatchProgress,
    deriveOperationAvailability,
    deriveTaskErrorFacts,
    deriveTaskFileFacts,
    deriveTaskRecovery,
    deriveWorkspacePresentation,
    formatBatchTime,
    formatTaskBytes,
    shortBatchId,
    siteLabel,
    taskPageCount,
    taskPageTotal,
    type RecentFilter,
  } from "./model";
  import { createTasksService } from "./service";
  import { createTasksStore, filteredRecentFromState, tasksFromState } from "./state";
  import TaskRow from "./TaskRow.svelte";
  import "./tasks.css";

  let { api, polling, persistence, onNavigate }: {
    api: ApiClient;
    polling: PollingService;
    persistence: PersistenceService;
    onNavigate: (appId: ApplicationId) => void;
  } = $props();

  const runtime = untrack(() => {
    const store = createTasksStore({ activeBatchId: persistence.readActiveBatchId() ?? "" });
    return {
      store,
      controller: createTasksController({
        store,
        service: createTasksService(api),
        polling,
        persistence,
      }),
    };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const recent = $derived(filteredRecentFromState(snapshot));
  const tasks = $derived(tasksFromState(snapshot));
  const progress = $derived(deriveBatchProgress(snapshot.summary));
  const pageTotal = $derived(taskPageTotal(snapshot.summary, snapshot.addressId));
  const pages = $derived(taskPageCount(snapshot.summary, snapshot.addressId));
  const fileFacts = $derived(deriveTaskFileFacts(tasks));
  const errorFacts = $derived(deriveTaskErrorFacts(tasks));
  const recovery = $derived(deriveTaskRecovery(tasks));
  const availability = $derived(deriveOperationAvailability(snapshot.summary, snapshot.busy));
  const presentation = $derived(deriveWorkspacePresentation(snapshot.phase));
  let confirmationDialog = $state<HTMLDialogElement>();
  let returnFocus: FocusTarget | null = null;

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function focusableDialogItems(): HTMLElement[] {
    return [...(confirmationDialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
  }

  function resolveConfirmation(confirmed: boolean): void {
    const target = returnFocus;
    returnFocus = null;
    void controller.confirmOperation(confirmed);
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
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = trappedTabIndex(current, items.length, event.shiftKey);
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

  onMount(() => {
    controller.activate();
    return () => controller.destroy();
  });
</script>

<section
  class="tasks-app"
  data-tasks-app
  data-domain-owner="tasks"
  aria-labelledby="tasks-heading"
  aria-busy={Boolean(snapshot.busy)}
>
  <header class="tasks-header">
    <div>
      <p>批次管理</p>
      <h1 id="tasks-heading">任务与恢复事实</h1>
    </div>
    <span class="tasks-status" data-status-kind={presentation.kind}>{presentation.label}</span>
  </header>

  {#if snapshot.error}
    <section class="tasks-error" role="alert" aria-labelledby="tasks-error-title">
      <div>
        <strong id="tasks-error-title">{snapshot.error.title}</strong>
        <p>{snapshot.error.message} {snapshot.error.nextStep}</p>
        <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
      </div>
      <button type="button" onclick={() => onNavigate(snapshot.error!.targetApp)}>打开恢复工具</button>
    </section>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable task workspace) -->
  <section class="tasks-workspace" tabindex="0" aria-label="批次管理三段工作区，可横向滚动">
    <div class="tasks-workspace__track">
      <aside class="tasks-column tasks-column--recent" aria-labelledby="tasks-recent-heading">
        <header>
          <p>01 · 批次</p>
          <h2 id="tasks-recent-heading">最近批次</h2>
          <span>筛选、选择并载入一个权威批次。</span>
        </header>
        <div class="tasks-column__scroll" tabindex="0" aria-label="最近批次内容；可滚动">
          <label class="tasks-field">
            <span>批次筛选</span>
            <select
              aria-label="批次筛选"
              value={snapshot.recentFilter}
              disabled={Boolean(snapshot.busy)}
              onchange={(event) => controller.setRecentFilter(selectValue(event) as RecentFilter)}
            >
              <option value="all">全部批次</option>
              <option value="active">活动批次</option>
              <option value="attention">需要处理</option>
              <option value="terminal">已结束</option>
            </select>
          </label>

          <label class="tasks-field">
            <span>最近批次列表</span>
            <select
              class="tasks-recent-list"
              aria-label="最近批次"
              size="9"
              value={snapshot.selectedRecentId}
              disabled={Boolean(snapshot.busy)}
              onchange={(event) => controller.selectRecent(selectValue(event))}
            >
              <option value="">{recent.length ? "选择一个批次" : "当前筛选没有批次"}</option>
              {#each recent as batch (batch.id)}
                <option value={batch.id}>
                  {batch.terminal ? "终态" : "活动"} · {batch.statusLabel} · {shortBatchId(batch.id)} · {formatBatchTime(batch.createdAt)}
                </option>
              {/each}
            </select>
          </label>
          <p class="tasks-muted">当前筛选显示 {recent.length} / 最近 {snapshot.recent.length} 个批次。</p>
          <div class="tasks-button-stack">
            <button
              type="button"
              class="tasks-primary"
              disabled={Boolean(snapshot.busy || !snapshot.selectedRecentId)}
              onclick={() => void controller.loadSelected()}
            >{snapshot.busy === "load" ? "正在加载…" : "查看所选批次"}</button>
            <button
              type="button"
              disabled={Boolean(snapshot.busy)}
              onclick={() => void controller.refresh()}
            >{snapshot.busy === "refresh" ? "正在刷新…" : "刷新全部事实"}</button>
          </div>

          <section class="tasks-active-card" aria-labelledby="tasks-active-title">
            <h3 id="tasks-active-title">活动状态</h3>
            {#if snapshot.summary}
              <span class="tasks-status" data-status-kind={snapshot.summary.statusKind}>{snapshot.summary.statusLabel}</span>
              <p>{shortBatchId(snapshot.summary.id)} · {snapshot.phase === "terminal" ? "自动刷新已停止" : "每 1.5 秒刷新"}</p>
            {:else}
              <span class="tasks-status" data-status-kind="disabled">没有已加载批次</span>
              <p>{snapshot.activeBatchId ? "正在等待完整摘要与任务页。" : "选择批次后显示轮询状态。"}</p>
            {/if}
          </section>
        </div>
      </aside>

      <main class="tasks-column tasks-column--detail" aria-labelledby="tasks-detail-heading">
        <header>
          <p>02 · 事实</p>
          <h2 id="tasks-detail-heading">批次摘要与当前页</h2>
          <span>完整数量来自批次摘要；表格只保留当前 100 条。</span>
        </header>
        <div class="tasks-column__scroll tasks-column__scroll--detail" tabindex="0" aria-label="批次事实内容；可滚动">
          <section class="tasks-workspace-state" data-phase={snapshot.phase} role="status" aria-live="polite">
            <span class="tasks-status" data-status-kind={presentation.kind}>{presentation.label}</span>
            <p>{snapshot.operationMessage || presentation.message}</p>
          </section>

          {#if snapshot.summary}
            <div class="tasks-metrics" aria-label="批次聚合事实">
              <div><span>批次 ID</span><strong>{shortBatchId(snapshot.summary.id)}</strong></div>
              <div><span>当前地址</span><strong>{snapshot.summary.current ? `${siteLabel(snapshot.summary.current.site)} · ${snapshot.summary.current.statusLabel}` : "—"}</strong></div>
              <div><span>成功 / 失败 / 取消</span><strong>{snapshot.summary.succeededTaskCount} / {snapshot.summary.failedTaskCount} / {snapshot.summary.cancelledTaskCount}</strong></div>
              <div><span>并发</span><strong>{snapshot.summary.concurrency || "—"}</strong></div>
              <div><span>预去重跳过</span><strong>{snapshot.summary.preDedupSkippedCount}</strong></div>
            </div>

            <label class="tasks-progress-label" for="tasks-progress">
              <span>批次进度</span>
              <strong>{progress.terminal} / {progress.total} 个任务已结束 · {progress.percent}%</strong>
            </label>
            <progress id="tasks-progress" max="100" value={progress.percent}>{progress.percent}%</progress>

            <section class="tasks-facts" aria-labelledby="tasks-files-heading">
              <div class="tasks-section-heading">
                <div>
                  <h3 id="tasks-files-heading">当前页文件事实</h3>
                  <p>仅聚合任务记录中的数量与字节，不展示文件路径。</p>
                </div>
              </div>
              <div class="tasks-file-metrics">
                <div><span>有文件任务</span><strong>{fileFacts.taskWithFilesCount} / {fileFacts.taskCount}</strong></div>
                <div><span>已记录文件</span><strong>{fileFacts.artifactCount}</strong></div>
                <div><span>已记录字节</span><strong>{formatTaskBytes(fileFacts.artifactBytes)}</strong></div>
              </div>
            </section>

            <section class="tasks-facts" aria-labelledby="tasks-sources-heading">
              <div class="tasks-section-heading">
                <div>
                  <h3 id="tasks-sources-heading">来源地址进度</h3>
                  <p>来源卡只显示聚合；地址可用于当前页查询。</p>
                </div>
              </div>
              {#if snapshot.summary.addressesTruncated}
                <p class="tasks-muted" role="status">来源地址数量过多；当前仅显示前 2,000 项，可按批次任务分页继续查看。</p>
              {/if}
              <label class="tasks-field">
                <span>任务地址筛选</span>
                <select
                  aria-label="任务地址筛选"
                  value={snapshot.addressId}
                  disabled={Boolean(snapshot.busy && snapshot.busy !== "load")}
                  onchange={(event) => void controller.setAddress(selectValue(event))}
                >
                  <option value="">全部来源地址</option>
                  {#each snapshot.summary.sources as source (`source:${source.order}:${source.site}`)}
                    <optgroup label={`${source.order + 1}. ${siteLabel(source.site)} · ${source.statusLabel}`}>
                      {#each source.addresses as address (address.id)}
                        <option value={address.id}>{address.order + 1}. {address.label} · {address.statusLabel} · 计划 {address.plannedTaskCount}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
              </label>
              <div class="tasks-source-grid">
                {#each snapshot.summary.sources as source (`summary:${source.order}:${source.site}`)}
                  <article>
                    <strong>{source.order + 1}. {siteLabel(source.site)}</strong>
                    <span class="tasks-status" data-status-kind={source.statusKind}>{source.statusLabel}</span>
                    <p>{source.addresses.length} 个来源地址 · 预去重 {source.preDedupSkippedCount}</p>
                  </article>
                {/each}
              </div>
            </section>

            <section class="tasks-facts" aria-labelledby="tasks-errors-heading">
              <div class="tasks-section-heading">
                <div>
                  <h3 id="tasks-errors-heading">当前页错误分类</h3>
                  <p>只显示安全分类，不显示原始异常、秘密、地址或本机路径。</p>
                </div>
              </div>
              {#if errorFacts.length}
                <ul class="tasks-fact-list">
                  {#each errorFacts as fact (fact.category.id)}
                    <li><span class="tasks-status" data-status-kind={fact.category.kind}>{fact.category.label}</span><strong>{fact.count} 个任务</strong></li>
                  {/each}
                </ul>
              {:else}
                <p class="tasks-muted">当前页没有已分类错误。</p>
              {/if}
            </section>

            <section class="tasks-facts tasks-task-section" aria-labelledby="tasks-table-heading">
              <div class="tasks-section-heading">
                <div>
                  <h3 id="tasks-table-heading">图片任务</h3>
                  <p>
                    {tasks.length
                      ? `显示 ${snapshot.pageIndex * 100 + 1}–${snapshot.pageIndex * 100 + tasks.length} / 共 ${pageTotal} 个`
                      : `当前页为空 / 共 ${pageTotal} 个`}
                  </p>
                </div>
                <span>第 {snapshot.pageIndex + 1} / {pages} 页</span>
              </div>
              <div class="tasks-table-wrap" tabindex="0" aria-label="当前批次任务表；可滚动">
                <table class="tasks-table" data-task-table>
                  <caption class="visually-hidden">当前批次第 {snapshot.pageIndex + 1} 页任务，最多 100 行</caption>
                  <thead>
                    <tr>
                      <th scope="col">顺序</th>
                      <th scope="col">来源 / 地址</th>
                      <th scope="col">状态</th>
                      <th scope="col">尝试</th>
                      <th scope="col">错误分类</th>
                      <th scope="col">文件事实</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each tasks as task (task.id)}
                      <TaskRow {task} />
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if !tasks.length}<p class="tasks-muted">任务建立或切换到该页后会在这里显示安全事实。</p>{/if}
              <nav class="tasks-pagination" aria-label="任务分页">
                <button
                  type="button"
                  disabled={Boolean(snapshot.busy && snapshot.busy !== "load") || snapshot.pageIndex === 0}
                  onclick={() => void controller.setPage(snapshot.pageIndex - 1)}
                >上一页</button>
                <span aria-live="polite">第 {snapshot.pageIndex + 1} 页，共 {pages} 页</span>
                <button
                  type="button"
                  disabled={Boolean(snapshot.busy && snapshot.busy !== "load") || snapshot.pageIndex + 1 >= pages}
                  onclick={() => void controller.setPage(snapshot.pageIndex + 1)}
                >下一页</button>
              </nav>
            </section>
          {:else}
            <section class="tasks-empty" aria-labelledby="tasks-empty-heading">
              <span class="tasks-status" data-status-kind={snapshot.phase === "error" ? "error" : "disabled"}>{presentation.label}</span>
              <h3 id="tasks-empty-heading">{snapshot.activeBatchId ? "正在读取完整批次快照" : "尚未选择批次"}</h3>
              <p>{presentation.message}</p>
            </section>
          {/if}
        </div>
      </main>

      <aside class="tasks-column tasks-column--actions" aria-labelledby="tasks-actions-heading">
        <header>
          <p>03 · 恢复</p>
          <h2 id="tasks-actions-heading">操作与恢复</h2>
          <span>危险写操作确认后，只进行一次权威重读。</span>
        </header>
        <div class="tasks-column__scroll" tabindex="0" aria-label="操作与恢复内容；可滚动">
          <p class="tasks-operation-live" aria-live="polite">{snapshot.operationMessage}</p>

          <section class="tasks-action-card" aria-labelledby="tasks-current-heading">
            <h3 id="tasks-current-heading">当前批次</h3>
            {#if snapshot.summary}
              <span class="tasks-status" data-status-kind={snapshot.summary.statusKind}>{snapshot.summary.statusLabel}</span>
              <p>{shortBatchId(snapshot.summary.id)} · 并发 {snapshot.summary.concurrency || "—"}</p>
            {:else}
              <span class="tasks-status" data-status-kind="disabled">尚未选择</span>
              <p>选择批次后显示可用操作。</p>
            {/if}
          </section>

          <section class="tasks-action-card" aria-labelledby="tasks-batch-actions-heading">
            <h3 id="tasks-batch-actions-heading">批次操作</h3>
            <p>取消、重试和重新规划由后端状态机决定，前端不强制改写状态。</p>
            <div class="tasks-button-stack">
              <button type="button" class="tasks-primary" disabled={!availability.retry} onclick={() => controller.requestOperation("retry")}>重试未完成项</button>
              <button type="button" disabled={!availability.rerun} onclick={() => controller.requestOperation("rerun")}>重新规划</button>
              <button type="button" class="tasks-danger" disabled={!availability.cancel} onclick={() => controller.requestOperation("cancel")}>取消批次</button>
            </div>
          </section>

          <section class="tasks-action-card" aria-labelledby="tasks-recovery-heading">
            <h3 id="tasks-recovery-heading">恢复动作</h3>
            {#if recovery.authSites.length}
              <div class="tasks-recovery-card">
                <span class="tasks-status" data-status-kind="warning">{recovery.authSites.length} 个来源需要授权</span>
                <p>修复授权后，再使用批次级重试。</p>
                <button type="button" onclick={() => onNavigate("vault")}>打开授权管理</button>
              </div>
            {/if}
            {#if recovery.proxyIssue}
              <div class="tasks-recovery-card">
                <span class="tasks-status" data-status-kind="warning">检测到代理或网络类失败</span>
                <p>先检查代理池，再使用批次级重试。</p>
                <button type="button" onclick={() => onNavigate("proxy")}>打开代理管理</button>
              </div>
            {/if}
            {#if !recovery.authSites.length && !recovery.proxyIssue}
              <p class="tasks-muted">当前页没有 Vault 或 Proxy 恢复建议。</p>
            {/if}
          </section>

          {#if snapshot.summary?.review && snapshot.phase === "terminal"}
            <section class="tasks-action-card" aria-labelledby="tasks-review-heading">
              <h3 id="tasks-review-heading">去重审核</h3>
              <span class="tasks-status" data-status-kind={snapshot.summary.review.kind}>{snapshot.summary.review.label}</span>
              <p>共 {snapshot.summary.review.totalGroupCount} 组；已确认 {snapshot.summary.review.decidedGroupCount} 组。</p>
              <button type="button" class="tasks-primary" onclick={() => onNavigate("review")}>打开去重审核</button>
            </section>
          {/if}
        </div>
      </aside>
    </div>
  </section>
</section>

{#if snapshot.confirmation}
  <dialog
    class="tasks-confirmation"
    data-tasks-confirmation={snapshot.confirmation.operation}
    aria-modal="true"
    aria-labelledby="tasks-confirmation-title"
    aria-describedby="tasks-confirmation-message tasks-confirmation-warning"
    bind:this={confirmationDialog}
    oncancel={(event) => { event.preventDefault(); resolveConfirmation(false); }}
    onkeydown={onConfirmationKeydown}
    onclick={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}
  >
    <section>
      <h2 id="tasks-confirmation-title">{snapshot.confirmation.title}</h2>
      <p id="tasks-confirmation-message">{snapshot.confirmation.message}</p>
      <p id="tasks-confirmation-warning" class="tasks-confirmation__warning"><strong>警告：</strong>{snapshot.confirmation.warning}</p>
      <div>
        <button type="button" onclick={() => resolveConfirmation(false)}>取消</button>
        <button type="button" class="tasks-danger" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</button>
      </div>
    </section>
  </dialog>
{/if}
