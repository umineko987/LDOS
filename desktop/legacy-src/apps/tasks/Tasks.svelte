<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
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

  function displayMessage(message: string): string {
    return message
      .replaceAll("经过安全投影的批次摘要与任务事实", "批次摘要与任务详情")
      .replaceAll("权威摘要与任务页重读", "刷新批次和任务")
      .replaceAll("权威重读", "刷新")
      .replaceAll("完整批次快照", "批次信息")
      .replaceAll("完整快照", "完整信息")
      .replaceAll("当前快照", "当前信息");
  }
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
      <h1 id="tasks-heading">批次</h1>
    </div>
    <Badge variant="outline" class="tasks-status" data-status-kind={presentation.kind}>{presentation.label}</Badge>
  </header>

  {#if snapshot.error}
    <Alert.Root variant="destructive" class="tasks-error" aria-labelledby="tasks-error-title">
      <div>
        <Alert.Title id="tasks-error-title">{snapshot.error.title}</Alert.Title>
        <Alert.Description>{displayMessage(`${snapshot.error.message} ${snapshot.error.nextStep}`)}</Alert.Description>
        <small>错误码：{snapshot.error.code}{snapshot.error.requestId ? ` · 请求 ${snapshot.error.requestId}` : ""}</small>
      </div>
      <Button variant="outline" size="sm" type="button" onclick={() => onNavigate(snapshot.error!.targetApp)}>打开恢复工具</Button>
    </Alert.Root>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable task workspace) -->
  <section class="tasks-workspace" tabindex="0" aria-label="批次管理工作区">
    <div class="tasks-workspace__track">
      <aside class="tasks-column tasks-column--recent" aria-labelledby="tasks-recent-heading">
        <header>
          <h2 id="tasks-recent-heading">最近批次</h2>
        </header>
        <div class="tasks-column__scroll" tabindex="0" aria-label="最近批次内容；可滚动">
          <Field.Field class="tasks-field">
            <Field.Label for="tasks-filter" class="visually-hidden">批次筛选</Field.Label>
            <NativeSelect.Root id="tasks-filter"
              aria-label="批次筛选"
              value={snapshot.recentFilter}
              disabled={Boolean(snapshot.busy)}
              onchange={(event) => controller.setRecentFilter(selectValue(event) as RecentFilter)}
            >
              <option value="all">全部批次</option>
              <option value="active">活动批次</option>
              <option value="attention">需要处理</option>
              <option value="terminal">已结束</option>
            </NativeSelect.Root>
          </Field.Field>

          <label class="tasks-field">
            <span class="visually-hidden">最近批次列表</span>
            <select
              class="tasks-recent-list"
              aria-label="最近批次"
              size="5"
              value={snapshot.selectedRecentId}
              disabled={Boolean(snapshot.busy)}
              onchange={(event) => controller.selectRecent(selectValue(event))}
            >
              <option value="">{recent.length ? "选择一个批次" : "当前筛选没有批次"}</option>
              {#each recent as batch (batch.id)}
                <option value={batch.id}>
                  {batch.statusLabel} · {shortBatchId(batch.id)} · {formatBatchTime(batch.createdAt)}
                </option>
              {/each}
            </select>
          </label>
          <p class="tasks-muted">当前筛选显示 {recent.length} / 最近 {snapshot.recent.length} 个批次。</p>
          <div class="tasks-button-stack">
            <Button variant="outline" size="sm"
              type="button"
              class="tasks-primary"
              disabled={Boolean(snapshot.busy || !snapshot.selectedRecentId)}
              onclick={() => void controller.loadSelected()}
            >{snapshot.busy === "load" ? "正在加载…" : "查看所选批次"}</Button>
            <Button variant="outline" size="sm"
              type="button"
              disabled={Boolean(snapshot.busy)}
              onclick={() => void controller.refresh()}
            >{snapshot.busy === "refresh" ? "正在刷新…" : "刷新批次"}</Button>
          </div>

          <p class="tasks-muted tasks-polling-note">{snapshot.summary ? snapshot.phase === "terminal" ? "批次已结束，自动刷新已停止。" : "每 1.5 秒自动刷新。" : "选择批次后查看任务进度。"}</p>
        </div>
      </aside>

      <section class="tasks-column tasks-column--detail" aria-labelledby="tasks-detail-heading">
        <header>
          <h2 id="tasks-detail-heading">任务进度</h2>
          {#if snapshot.summary}<span class="tasks-status" data-status-kind={snapshot.summary.statusKind}>{snapshot.summary.statusLabel}</span>{/if}
        </header>
        <div class="tasks-column__scroll tasks-column__scroll--detail" tabindex="0" aria-label="批次详情；可滚动">
          <section class="tasks-workspace-state" data-phase={snapshot.phase} role="status" aria-live="polite">
            <p>{displayMessage(snapshot.operationMessage || presentation.message)}</p>
          </section>

          {#if snapshot.summary}
            <div class="tasks-metrics" aria-label="批次摘要">
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
            <div class="workbench-progress" data-running={snapshot.summary.statusKind === "running"} data-complete={snapshot.summary.status === "succeeded"}>
              <progress id="tasks-progress" max="100" value={progress.percent}>{progress.percent}%</progress>
            </div>

            <section class="tasks-facts" aria-labelledby="tasks-sources-heading">
              <h3 id="tasks-sources-heading" class="visually-hidden">来源地址进度</h3>
              {#if snapshot.summary.addressesTruncated}
                <p class="tasks-muted" role="status">来源地址数量过多；当前仅显示前 2,000 项，可按批次任务分页继续查看。</p>
              {/if}
              <Field.Field class="tasks-field">
                <Field.Label for="tasks-address-filter">任务地址筛选</Field.Label>
                <NativeSelect.Root id="tasks-address-filter"
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
                </NativeSelect.Root>
              </Field.Field>
              <details class="tasks-source-summary">
                <summary>来源进度汇总（{snapshot.summary.sources.length}）</summary>
                <div class="tasks-source-grid">
                  {#each snapshot.summary.sources as source (`summary:${source.order}:${source.site}`)}
                    <article>
                      <strong>{source.order + 1}. {siteLabel(source.site)}</strong>
                      <span class="tasks-status" data-status-kind={source.statusKind}>{source.statusLabel}</span>
                      <p>{source.addresses.length} 个来源地址 · 预去重 {source.preDedupSkippedCount}</p>
                    </article>
                  {/each}
                </div>
              </details>
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
                      <th scope="col">文件</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each tasks as task (task.id)}
                      <TaskRow {task} />
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if !tasks.length}<p class="tasks-muted">任务建立或切换到该页后会在这里显示。</p>{/if}
              <nav class="tasks-pagination" aria-label="任务分页">
                <Button variant="outline" size="sm"
                  type="button"
                  disabled={Boolean(snapshot.busy && snapshot.busy !== "load") || snapshot.pageIndex === 0}
                  onclick={() => void controller.setPage(snapshot.pageIndex - 1)}
                >上一页</Button>
                <span aria-live="polite">第 {snapshot.pageIndex + 1} 页，共 {pages} 页</span>
                <Button variant="outline" size="sm"
                  type="button"
                  disabled={Boolean(snapshot.busy && snapshot.busy !== "load") || snapshot.pageIndex + 1 >= pages}
                  onclick={() => void controller.setPage(snapshot.pageIndex + 1)}
                >下一页</Button>
              </nav>
            </section>

            <details class="tasks-facts" aria-labelledby="tasks-files-heading">
              <summary id="tasks-files-heading">当前页文件统计</summary>
              <div class="tasks-file-metrics">
                <div><span>有文件任务</span><strong>{fileFacts.taskWithFilesCount} / {fileFacts.taskCount}</strong></div>
                <div><span>已记录文件</span><strong>{fileFacts.artifactCount}</strong></div>
                <div><span>已记录字节</span><strong>{formatTaskBytes(fileFacts.artifactBytes)}</strong></div>
              </div>
            </details>
            <details class="tasks-facts" aria-labelledby="tasks-errors-heading" open={errorFacts.length > 0}>
              <summary id="tasks-errors-heading">当前页错误分类（{errorFacts.reduce((total, fact) => total + fact.count, 0)} 个任务）</summary>
              {#if errorFacts.length}
                <ul class="tasks-fact-list">
                  {#each errorFacts as fact (fact.category.id)}
                    <li><span class="tasks-status" data-status-kind={fact.category.kind}>{fact.category.label}</span><strong>{fact.count} 个任务</strong></li>
                  {/each}
                </ul>
              {:else}
                <p class="tasks-muted">当前页没有已分类错误。</p>
              {/if}
            </details>
          {:else}
            <section class="tasks-empty" aria-labelledby="tasks-empty-heading">
              <h3 id="tasks-empty-heading">{snapshot.activeBatchId ? "正在加载批次" : "尚未选择批次"}</h3>
              <p>{displayMessage(presentation.message)}</p>
            </section>
          {/if}
        </div>
      </section>

      <aside class="tasks-column tasks-column--actions" aria-labelledby="tasks-actions-heading">
        <header>
          <h2 id="tasks-actions-heading">操作与恢复</h2>
        </header>
        <div class="tasks-column__scroll" tabindex="0" aria-label="操作与恢复内容；可滚动">

          <section class="tasks-action-card" aria-labelledby="tasks-batch-actions-heading">
            <h3 id="tasks-batch-actions-heading">批次操作</h3>
            <p>修复问题后重试未完成项；重新规划会重新建立任务，取消会停止后续采集。</p>
            <div class="tasks-button-stack">
              <Button variant="default" size="sm" type="button" class="tasks-primary" disabled={!availability.retry} onclick={() => controller.requestOperation("retry")}>重试未完成项</Button>
              <Button variant="outline" size="sm" type="button" disabled={!availability.rerun} onclick={() => controller.requestOperation("rerun")}>重新规划</Button>
              <Button variant="outline" size="sm" type="button" class="tasks-danger" disabled={!availability.cancel} onclick={() => controller.requestOperation("cancel")}>取消批次</Button>
            </div>
          </section>

          <section class="tasks-action-card" aria-labelledby="tasks-recovery-heading">
            <h3 id="tasks-recovery-heading">恢复动作</h3>
            {#if recovery.authSites.length}
              <div class="tasks-recovery-card">
                <span class="tasks-status" data-status-kind="warning">{recovery.authSites.length} 个来源需要授权</span>
                <p>修复授权后，再使用批次级重试。</p>
                <Button variant="outline" size="sm" type="button" onclick={() => onNavigate("vault")}>打开授权管理</Button>
              </div>
            {/if}
            {#if recovery.proxyIssue}
              <div class="tasks-recovery-card">
                <span class="tasks-status" data-status-kind="warning">检测到代理或网络类失败</span>
                <p>先检查代理池，再使用批次级重试。</p>
                <Button variant="outline" size="sm" type="button" onclick={() => onNavigate("proxy")}>打开代理管理</Button>
              </div>
            {/if}
            {#if !recovery.authSites.length && !recovery.proxyIssue}
              <p class="tasks-muted">当前页没有需要修复的授权或代理问题。</p>
            {/if}
          </section>

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
      <p id="tasks-confirmation-warning" class="tasks-confirmation__warning"><strong>警告：</strong>{displayMessage(snapshot.confirmation.warning)}</p>
      <div>
        <Button variant="outline" size="sm" type="button" onclick={() => resolveConfirmation(false)}>取消</Button>
        <Button variant="outline" size="sm" type="button" class="tasks-danger" onclick={() => resolveConfirmation(true)}>{snapshot.confirmation.confirmLabel}</Button>
      </div>
    </section>
  </dialog>
{/if}
