import { createElement } from "../core/dom.js";
import {
  batchProgress,
  deriveTasksWorkspacePresentation,
  filterRecentBatches,
  formatBatchTime,
  formatTaskBytes,
  shortBatchId,
  taskErrorCategory,
  taskFileFacts,
  taskRecoveryTargets,
  TERMINAL_BATCH_STATUSES,
} from "../core/tasks-model.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const SITE_LABELS = Object.freeze({
  danbooru: "Danbooru",
  twitter: "X / Twitter",
  pixiv: "Pixiv",
  exhentai: "EH",
  pawchive: "Pawchive",
  unknown: "未知来源",
});

function button(action, label, {
  primary = false,
  dangerous = false,
  small = false,
  title = label,
} = {}) {
  return createElement("button", {
    className: [
      "tasks-button",
      primary ? "tasks-button--primary" : "",
      dangerous ? "tasks-button--dangerous" : "",
      small ? "tasks-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button", title, "aria-label": label },
    dataset: { tasksAction: action },
  });
}

function metric(label, value, detail = "") {
  return createElement("div", { className: "tasks-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
    ...(detail ? [createElement("small", { text: detail })] : []),
  ]);
}

function siteLabel(site) {
  return SITE_LABELS[site] || SITE_LABELS.unknown;
}

function taskFileText(task) {
  if (!task.artifactCount && !task.artifactBytes) return "尚无文件";
  return `${task.artifactCount} 个文件 · ${formatTaskBytes(task.artifactBytes)}`;
}

export function taskResultText(task) {
  const category = task.errorCategory || taskErrorCategory(task.errorClass);
  const error = category?.label || "无错误";
  const files = task.artifactCount || task.artifactBytes
    ? `已记录 ${task.artifactCount} 个文件 / ${formatTaskBytes(task.artifactBytes)}`
    : "尚无文件";
  return `${error} · ${files}`;
}

function tasksFocusToken(root) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !root.contains(target)) return "";
  return target.dataset.tasksAction || target.dataset.tasksControl || "";
}

function restoreTasksFocus(root, token) {
  if (!token) return;
  const target = [...root.querySelectorAll("button, select, [tabindex]")]
    .find((element) => !element.disabled && (
      element.dataset.tasksAction === token || element.dataset.tasksControl === token
    ));
  target?.focus({ preventScroll: true });
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "tasks-heading";
  const recentFilter = createElement("select", {
    attributes: { "aria-label": "批次筛选" },
    dataset: { tasksFilter: "", tasksControl: "recent-filter" },
  }, [
    createElement("option", { text: "全部批次", attributes: { value: "all" } }),
    createElement("option", { text: "活动批次", attributes: { value: "active" } }),
    createElement("option", { text: "需要处理", attributes: { value: "attention" } }),
    createElement("option", { text: "已结束", attributes: { value: "terminal" } }),
  ]);
  const recent = createElement("select", {
    className: "tasks-recent-list",
    attributes: { "aria-label": "最近批次", size: "9" },
    dataset: { tasksRecent: "", tasksControl: "recent-list" },
  }, [createElement("option", { text: "暂无批次", attributes: { value: "" } })]);
  const recentCount = createElement("p", {
    className: "tasks-muted-copy",
    text: "最近列表正在加载。",
    dataset: { tasksRecentCount: "" },
  });
  const activeSummary = createElement("section", {
    className: "tasks-active-summary",
    attributes: { "aria-labelledby": "tasks-active-summary-title" },
    dataset: { tasksActiveSummary: "" },
  });
  const leftActions = createElement("div", { className: "tasks-button-stack" }, [
    button("load", "查看所选批次", { primary: true }),
    button("refresh", "刷新全部事实"),
  ]);

  const recentColumn = createElement("aside", {
    className: "tasks-column tasks-column--recent",
    attributes: { "aria-labelledby": "tasks-recent-heading" },
  }, [
    createElement("header", { className: "tasks-column-header" }, [
      createElement("p", { className: "tasks-column-kicker", text: "01 · 批次" }),
      createElement("h2", { text: "最近批次", attributes: { id: "tasks-recent-heading" } }),
      createElement("p", { text: "筛选最近记录，并确认当前活动批次是否仍在自动刷新。" }),
    ]),
    createElement("div", { className: "tasks-column-scroll" }, [
      createElement("label", { className: "tasks-field" }, [
        createElement("span", { text: "批次筛选" }),
        recentFilter,
      ]),
      recent,
      recentCount,
      leftActions,
      activeSummary,
    ]),
  ]);

  const workspaceBadge = createStatusBadge("disabled", "尚未选择批次");
  const workspaceStateMessage = createElement("p", {
    text: "从最近批次中选择，或先在图片采集页创建批次。",
    dataset: { tasksWorkspaceMessage: "" },
  });
  const workspaceState = createElement("section", {
    className: "tasks-workspace-state",
    attributes: { role: "status", "aria-live": "polite" },
    dataset: { tasksWorkspaceState: "empty" },
  }, [workspaceBadge, workspaceStateMessage]);
  const emptyHost = createElement("div", { className: "tasks-empty-host", dataset: { tasksEmpty: "" } });
  const metricsHost = createElement("div", { className: "tasks-metrics", dataset: { tasksMetrics: "" } });
  const progress = createElement("progress", {
    className: "tasks-progress",
    attributes: { max: "100", value: "0", "aria-label": "批次进度" },
    dataset: { tasksProgress: "" },
  });
  const progressText = createElement("p", {
    className: "tasks-progress-text",
    dataset: { tasksProgressText: "" },
  });
  const fileFactsHost = createElement("section", {
    className: "tasks-file-facts",
    attributes: { "aria-labelledby": "tasks-file-facts-title" },
    dataset: { tasksFileFacts: "" },
  });
  const sourceHost = createElement("div", { className: "tasks-sources", dataset: { tasksSources: "" } });
  const errorFactsHost = createElement("section", {
    className: "tasks-error-facts",
    attributes: { "aria-labelledby": "tasks-error-facts-title" },
    dataset: { tasksErrorFacts: "" },
  });
  const taskHost = createElement("div", { className: "tasks-list", dataset: { tasksList: "" } });
  const taskSummary = createElement("p", {
    className: "tasks-list-summary",
    dataset: { tasksSummary: "" },
  });
  const detailContent = createElement("div", {
    className: "tasks-detail-content",
    attributes: { hidden: "" },
    dataset: { tasksDetailContent: "" },
  }, [
    metricsHost,
    progress,
    progressText,
    fileFactsHost,
    createElement("section", { className: "tasks-detail-section", attributes: { "aria-labelledby": "tasks-addresses-title" } }, [
      createElement("div", { className: "tasks-section-heading" }, [
        createElement("div", {}, [
          createElement("h3", { text: "来源地址进度", attributes: { id: "tasks-addresses-title" } }),
          createElement("p", { text: "按创建时的来源和地址顺序展示规划与执行聚合。" }),
        ]),
      ]),
      sourceHost,
    ]),
    errorFactsHost,
    createElement("section", { className: "tasks-detail-section", attributes: { "aria-labelledby": "tasks-list-title" } }, [
      createElement("div", { className: "tasks-section-heading" }, [
        createElement("h3", { text: "图片任务", attributes: { id: "tasks-list-title" } }),
        taskSummary,
      ]),
      taskHost,
    ]),
  ]);

  const detailColumn = createElement("main", {
    className: "tasks-column tasks-column--detail",
    attributes: { "aria-labelledby": "tasks-detail-heading" },
  }, [
    createElement("header", { className: "tasks-column-header" }, [
      createElement("p", { className: "tasks-column-kicker", text: "02 · 事实" }),
      createElement("h2", { text: "来源地址与任务", attributes: { id: "tasks-detail-heading" } }),
      createElement("p", { text: "查看地址进度、错误分类、尝试次数和已记录文件事实。" }),
    ]),
    createElement("div", { className: "tasks-column-scroll tasks-column-scroll--detail" }, [
      workspaceState,
      emptyHost,
      detailContent,
    ]),
  ]);

  const operationLive = createElement("p", {
    className: "tasks-operation-live",
    text: "正在等待批次选择。",
    attributes: { "aria-live": "polite" },
    dataset: { tasksLive: "" },
  });
  const actionSummary = createElement("section", {
    className: "tasks-action-summary",
    attributes: { "aria-labelledby": "tasks-action-summary-title" },
    dataset: { tasksActionSummary: "" },
  });
  const batchActions = createElement("section", {
    className: "tasks-action-group",
    attributes: { "aria-labelledby": "tasks-batch-actions-title" },
  }, [
    createElement("h3", { text: "批次操作", attributes: { id: "tasks-batch-actions-title" } }),
    createElement("p", { text: "危险写操作需要确认，提交后以权威重读结果为准。" }),
    createElement("div", { className: "tasks-button-stack" }, [
      button("retry", "重试未完成项", {
        primary: true,
        title: "通过批次重试路径重新排队失败任务和规划缺口",
      }),
      button("rerun", "重新规划", { title: "按原批次重新规划全部来源地址" }),
      button("cancel", "取消批次", { dangerous: true }),
    ]),
  ]);
  const recoveryHost = createElement("div", {
    className: "tasks-recovery",
    attributes: { "aria-label": "恢复动作" },
    dataset: { tasksRecovery: "" },
  });
  const reviewHost = createElement("div", { className: "tasks-review-entry", dataset: { tasksReview: "" } });
  const actionColumn = createElement("aside", {
    className: "tasks-column tasks-column--actions",
    attributes: { "aria-labelledby": "tasks-actions-heading" },
  }, [
    createElement("header", { className: "tasks-column-header" }, [
      createElement("p", { className: "tasks-column-kicker", text: "03 · 恢复" }),
      createElement("h2", { text: "操作与恢复", attributes: { id: "tasks-actions-heading" } }),
      createElement("p", { text: "取消、重试、重新规划，并前往 Vault、Proxy 或 Review 继续处理。" }),
    ]),
    createElement("div", { className: "tasks-column-scroll tasks-column-scroll--actions" }, [
      operationLive,
      actionSummary,
      batchActions,
      createElement("section", { className: "tasks-action-group", attributes: { "aria-labelledby": "tasks-recovery-title" } }, [
        createElement("h3", { text: "恢复动作", attributes: { id: "tasks-recovery-title" } }),
        recoveryHost,
      ]),
      reviewHost,
    ]),
  ]);

  const workspaceTrack = createElement("div", {
    className: "tasks-workspace-track",
  }, [recentColumn, detailColumn, actionColumn]);
  const workspace = createElement("section", {
    className: "tasks-workspace",
    attributes: {
      "aria-label": "批次管理三段工作区，可横向滚动查看最近批次、任务事实和恢复动作",
      tabindex: "0",
    },
    dataset: { tasksWorkspace: "" },
  }, [workspaceTrack]);
  const errorHost = createElement("div", { className: "tasks-error-host", dataset: { tasksError: "" } });
  const headerBadge = createStatusBadge("running", "真实 API 工作区");

  root.classList.add("app-view", "tasks-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header tasks-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      createElement("div", { className: "tasks-app-status" }, [headerBadge]),
    ]),
    errorHost,
    workspace,
  );

  return {
    recentFilter,
    recent,
    recentCount,
    activeSummary,
    actionsRow: root,
    headerBadge,
    operationLive,
    errorHost,
    emptyHost,
    workspace,
    workspaceTrack,
    workspaceState,
    workspaceBadge,
    workspaceStateMessage,
    detailContent,
    metricsHost,
    progress,
    progressText,
    fileFactsHost,
    sourceHost,
    errorFactsHost,
    recoveryHost,
    taskHost,
    taskSummary,
    reviewHost,
    actionSummary,
  };
}

function findButton(elements, action) {
  return elements.actionsRow.querySelector(`[data-tasks-action="${action}"]`);
}

function renderSources(elements, batch) {
  const cards = [];
  for (const source of batch.sources) {
    const sourceCard = createElement("section", { className: "tasks-source-card" }, [
      createElement("div", { className: "tasks-source-heading" }, [
        createElement("div", {}, [
          createElement("strong", { text: `${source.order + 1}. ${siteLabel(source.site)}` }),
          createElement("span", { text: `${source.addresses.length} 个来源地址` }),
        ]),
        createStatusBadge(source.statusKind, source.statusLabel, { compact: true }),
      ]),
    ]);
    if (!source.addresses.length) {
      sourceCard.append(createEmptyState({
        label: "暂无地址",
        title: "来源地址尚未建立",
        message: "批次开始规划后会在这里显示地址进度。",
      }));
    }
    for (const address of source.addresses) {
      const current = batch.current?.addressId === address.id;
      const taskTerminal = address.succeededTaskCount + address.failedTaskCount + address.cancelledTaskCount;
      const facts = [
        `计划 ${address.plannedTaskCount}`,
        `已结束 ${taskTerminal}`,
        `成功 ${address.succeededTaskCount}`,
        `失败 ${address.failedTaskCount}`,
      ];
      if (address.cancelledTaskCount) facts.push(`取消 ${address.cancelledTaskCount}`);
      if (address.preDedupSkippedCount) facts.push(`预去重 ${address.preDedupSkippedCount}`);
      if (address.probedProxyCount) facts.push(`健康代理 ${address.healthyProxyCount}/${address.probedProxyCount}`);
      if (address.hasPlanningIssue) facts.push("存在规划异常");
      sourceCard.append(createElement("article", {
        className: `tasks-address${current ? " tasks-address--current" : ""}`,
        attributes: { "aria-label": `${address.label}，${address.statusLabel}${current ? "，当前地址" : ""}` },
      }, [
        createElement("div", { className: "tasks-address-heading" }, [
          createElement("span", { className: "tasks-order", text: String(address.order + 1), attributes: { "aria-hidden": "true" } }),
          createElement("div", { className: "tasks-address-copy" }, [
            createElement("strong", { text: address.label }),
            createElement("span", { text: `${address.addressType}${current ? " · 当前活动地址" : ""}` }),
          ]),
          createStatusBadge(address.statusKind, address.statusLabel, { compact: true }),
        ]),
        createElement("p", { className: "tasks-address-facts", text: facts.join(" · ") }),
      ]));
    }
    cards.push(sourceCard);
  }
  elements.sourceHost.replaceChildren(...(cards.length ? cards : [createEmptyState({
    label: "等待规划",
    title: "来源顺序尚未可用",
    message: "批次开始规划后会自动显示来源和地址。",
  })]));
}

function renderTaskErrorFacts(elements, tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const category = task.errorCategory || taskErrorCategory(task.errorClass);
    if (!category) continue;
    counts.set(category.id, { category, count: (counts.get(category.id)?.count || 0) + 1 });
  }
  const facts = [...counts.values()];
  elements.errorFactsHost.replaceChildren(
    createElement("div", { className: "tasks-section-heading" }, [
      createElement("div", {}, [
        createElement("h3", { text: "错误分类", attributes: { id: "tasks-error-facts-title" } }),
        createElement("p", { text: "只显示安全分类，不展示原始异常、Cookie、Token、地址或本机路径。" }),
      ]),
    ]),
    ...(facts.length
      ? [createElement("ul", { className: "tasks-fact-list" }, facts.map(({ category, count }) =>
          createElement("li", {}, [
            createStatusBadge(category.kind, category.label, { compact: true }),
            createElement("strong", { text: `${count} 个任务` }),
          ])))]
      : [createEmptyState({
          status: "ready",
          label: "无已分类错误",
          title: "当前任务未报告错误分类",
          message: "后续轮询会继续更新权威任务事实。",
        })]),
  );
}

function renderTasks(elements, batch, tasks) {
  const total = batch.taskCount;
  elements.taskSummary.textContent = total > tasks.length
    ? `显示前 ${tasks.length} / 共 ${total} 个；完整进度以批次聚合计数为准`
    : `显示 ${tasks.length} / 共 ${total} 个`;
  if (!tasks.length) {
    elements.taskHost.replaceChildren(createEmptyState({
      label: batch.current?.status === "planning" ? "正在规划" : "暂无任务",
      title: batch.current?.status === "planning" ? "正在查找当前地址中的图片" : "暂无图片任务",
      message: "任务建立后会显示顺序、地址、状态、尝试次数、错误分类和文件事实。",
    }));
    return;
  }
  const table = createElement("table", { className: "tasks-table" }, [
    createElement("thead", {}, [createElement("tr", {}, [
      createElement("th", { text: "顺序" }),
      createElement("th", { text: "来源 / 地址" }),
      createElement("th", { text: "状态" }),
      createElement("th", { text: "尝试" }),
      createElement("th", { text: "错误分类" }),
      createElement("th", { text: "文件事实" }),
    ])]),
  ]);
  const body = createElement("tbody");
  for (const task of tasks) {
    const category = task.errorCategory || taskErrorCategory(task.errorClass);
    body.append(createElement("tr", { attributes: { title: taskResultText(task) } }, [
      createElement("td", { text: `${task.sourceOrder + 1}.${task.addressOrder + 1}.${task.sequence}` }),
      createElement("td", {}, [
        createElement("strong", { text: siteLabel(task.site) }),
        createElement("span", { className: "tasks-table-secondary", text: task.addressId ? shortBatchId(task.addressId) : "地址事实不可用" }),
      ]),
      createElement("td", {}, [createStatusBadge(task.statusKind, task.statusLabel, { compact: true })]),
      createElement("td", { text: `${task.attemptCount}/${task.maxAttempts}` }),
      createElement("td", { text: category?.label || "无错误" }),
      createElement("td", { text: taskFileText(task) }),
    ]));
  }
  table.append(body);
  elements.taskHost.replaceChildren(createElement("div", { className: "tasks-table-wrap" }, [table]));
}

function renderFileFacts(elements, tasks) {
  const facts = taskFileFacts(tasks);
  elements.fileFactsHost.replaceChildren(
    createElement("div", { className: "tasks-section-heading" }, [
      createElement("div", {}, [
        createElement("h3", { text: "文件事实", attributes: { id: "tasks-file-facts-title" } }),
        createElement("p", { text: "来自任务记录的已落盘文件数量与字节聚合，不读取或展示文件路径。" }),
      ]),
    ]),
    createElement("div", { className: "tasks-file-metrics" }, [
      metric("有文件任务", facts.taskWithFilesCount, `共显示 ${facts.taskCount} 个任务`),
      metric("已记录文件", facts.artifactCount),
      metric("已记录字节", formatTaskBytes(facts.artifactBytes)),
    ]),
  );
}

function renderRecovery(elements, batch, tasks) {
  const targets = taskRecoveryTargets(tasks);
  const notices = [];
  if (targets.authSites.length) {
    notices.push(createElement("section", { className: "tasks-recovery-card" }, [
      createStatusBadge("warning", `${targets.authSites.length} 个来源需要授权`),
      createElement("p", { text: "授权材料不可用。修复 Vault 后，再使用批次级重试恢复未完成项。" }),
      button("open-vault", "打开授权管理", { small: true }),
    ]));
  }
  if (targets.proxyIssue) {
    notices.push(createElement("section", { className: "tasks-recovery-card" }, [
      createStatusBadge("warning", "检测到代理或网络类失败"),
      createElement("p", { text: "先检查 Proxy 运行池与来源，再使用批次级重试；不直接重试单个 crawl-media 任务。" }),
      button("open-proxy", "打开代理管理", { small: true }),
    ]));
  }
  if (batch.status === "completed_with_errors") {
    notices.push(createElement("section", { className: "tasks-recovery-card" }, [
      createStatusBadge("warning", "批次部分失败"),
      createElement("p", { text: batch.resumable
        ? "可重试失败媒体任务或重新规划地址缺口；已完成文件会跳过。"
        : "当前没有可恢复项，请刷新最新状态后再决定下一步。" }),
    ]));
  }
  if (!notices.length) {
    notices.push(createElement("p", {
      className: "tasks-muted-copy",
      text: TERMINAL_BATCH_STATUSES.has(batch.status)
        ? "当前没有 Vault 或 Proxy 恢复建议；可根据终态决定是否重新规划。"
        : "批次仍在活动中；恢复建议会按安全错误分类自动出现。",
    }));
  }
  elements.recoveryHost.replaceChildren(...notices);
}

function renderReviewEntry(elements, batch) {
  const review = batch.review;
  if (!TERMINAL_BATCH_STATUSES.has(batch.status) || !review) {
    elements.reviewHost.replaceChildren();
    return;
  }
  elements.reviewHost.replaceChildren(createElement("section", { className: "tasks-action-group tasks-review-card" }, [
    createElement("h3", { text: "去重审核" }),
    createStatusBadge(review.kind, review.label),
    createElement("p", { text: review.status === "ready"
      ? `待审核 ${review.totalGroupCount} 组；已确认 ${review.decidedGroupCount} 组。`
      : "审核状态由去重审核页单独更新。" }),
    button("open-review", "打开去重审核", { primary: true }),
  ]));
}

export function createTasksView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let workspacePhase = "idle";
  let workspacePhaseMessage = "";
  let renderedError = null;

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (guidance) => {
    clearError();
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
      actionLabel: guidance.targetApp === "vault"
        ? "打开授权管理"
        : guidance.targetApp === "proxy"
          ? "打开代理管理"
          : "打开系统诊断",
      onAction: () => actions.navigateToApp(guidance.targetApp),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const renderRecent = (batches) => {
    const filtered = filterRecentBatches(batches, elements.recentFilter.value || "all");
    const selected = store.getState().batches.activeId || elements.recent.value;
    const options = [createElement("option", {
      text: filtered.length ? "选择一个批次" : "当前筛选没有批次",
      attributes: { value: "" },
    })];
    for (const batch of filtered) {
      const terminal = TERMINAL_BATCH_STATUSES.has(batch.status) ? "终态" : "活动";
      const option = createElement("option", {
        text: `${terminal} · ${batch.statusLabel} · ${shortBatchId(batch.id)} · ${formatBatchTime(batch.createdAt)}`,
        attributes: { value: batch.id },
      });
      option.selected = batch.id === selected;
      options.push(option);
    }
    elements.recent.replaceChildren(...options);
    elements.recentCount.textContent = `当前筛选显示 ${filtered.length} / 最近 ${batches.length} 个批次。`;
  };

  const renderActiveSummary = (batchId, batch) => {
    if (!batchId) {
      elements.activeSummary.replaceChildren(
        createElement("h3", { text: "活动状态", attributes: { id: "tasks-active-summary-title" } }),
        createStatusBadge("disabled", "没有活动批次"),
        createElement("p", { text: "终态批次不会自动轮询；选择活动批次后按 1.5 秒刷新。" }),
      );
      return;
    }
    const terminal = Boolean(batch && TERMINAL_BATCH_STATUSES.has(batch.status));
    elements.activeSummary.replaceChildren(
      createElement("h3", { text: "活动状态", attributes: { id: "tasks-active-summary-title" } }),
      createStatusBadge(
        batch ? (terminal ? "warning" : "running") : "running",
        batch ? (terminal ? "终态 · 自动刷新已停止" : "活动 · 每 1.5 秒刷新") : "等待详情",
      ),
      createElement("p", { text: `批次 ${shortBatchId(batchId)}${batch ? ` · ${batch.statusLabel}` : ""}` }),
    );
  };

  const renderWorkspaceState = (batch) => {
    const presentation = deriveTasksWorkspacePresentation({ phase: workspacePhase, batch });
    elements.workspaceState.dataset.tasksWorkspaceState = presentation.state;
    updateStatusBadge(elements.workspaceBadge, presentation.kind, presentation.label);
    elements.workspaceStateMessage.textContent = workspacePhaseMessage || presentation.message;
    updateStatusBadge(
      elements.headerBadge,
      presentation.state === "error" ? "error" : presentation.state === "terminal" ? "warning" : "running",
      presentation.state === "terminal" ? "终态已停止轮询" : "真实 API 工作区",
    );
  };

  const renderActionSummary = (batch) => {
    if (!batch) {
      elements.actionSummary.replaceChildren(
        createElement("h3", { text: "当前批次", attributes: { id: "tasks-action-summary-title" } }),
        createStatusBadge("disabled", "尚未选择"),
        createElement("p", { text: "选择批次后显示可用操作和恢复入口。" }),
      );
      return;
    }
    const terminal = TERMINAL_BATCH_STATUSES.has(batch.status);
    elements.actionSummary.replaceChildren(
      createElement("h3", { text: "当前批次", attributes: { id: "tasks-action-summary-title" } }),
      createStatusBadge(batch.statusKind, batch.statusLabel),
      createElement("p", { text: `ID ${shortBatchId(batch.id)} · ${terminal ? "终态" : "活动"} · 并发 ${batch.concurrency || "—"}` }),
      createElement("p", { className: "tasks-muted-copy", text: terminal
        ? "活动轮询已停止；写操作完成后仍会权威重读。"
        : "批次活动中，仅允许取消；重试和重新规划需等待终态。" }),
    );
  };

  const render = (batches) => {
    const focusToken = tasksFocusToken(root);
    const filterValue = elements.recentFilter.value || "all";
    const recentValue = elements.recent.value;
    renderRecent(batches.recent);
    elements.recentFilter.value = filterValue;
    if (!batches.activeId && recentValue &&
        [...elements.recent.options].some((option) => option.value === recentValue)) {
      elements.recent.value = recentValue;
    }
    const batch = batches.active;
    const tasks = batches.tasks;
    renderActiveSummary(batches.activeId, batch);
    renderWorkspaceState(batch);
    renderActionSummary(batch);
    elements.detailContent.hidden = !batch;
    elements.emptyHost.replaceChildren(...(!batch ? [createEmptyState({
      label: workspacePhase === "loading" ? "正在加载" : "尚未选择批次",
      title: workspacePhase === "loading" ? "正在读取批次详情" : "从最近批次中选择，或先在图片采集页创建",
      message: workspacePhase === "loading"
        ? "读取期间保留三段工作区；完成后会显示权威详情。"
        : "离开页面后会暂停活动批次自动刷新。",
    })] : []));
    if (batch) {
      const progressValue = batchProgress(batch);
      elements.progress.value = progressValue.percent;
      elements.progress.setAttribute("value", String(progressValue.percent));
      elements.progressText.textContent = `${progressValue.terminal} / ${progressValue.total} 个任务已结束 · ${progressValue.percent}%`;
      elements.metricsHost.replaceChildren(
        metric("批次 ID", shortBatchId(batch.id)),
        metric("当前地址", batch.current ? `${siteLabel(batch.current.site)} · ${batch.current.statusLabel}` : "—"),
        metric("成功 / 失败 / 取消", `${batch.succeededTaskCount} / ${batch.failedTaskCount} / ${batch.cancelledTaskCount}`),
        metric("并发数", batch.concurrency || "—"),
        metric("预去重跳过", batch.preDedupSkippedCount),
      );
      renderFileFacts(elements, tasks);
      renderSources(elements, batch);
      renderTaskErrorFacts(elements, tasks);
      renderTasks(elements, batch, tasks);
      renderRecovery(elements, batch, tasks);
      renderReviewEntry(elements, batch);
    } else {
      elements.recoveryHost.replaceChildren(createElement("p", {
        className: "tasks-muted-copy",
        text: "选择批次后显示 Vault、Proxy 与 Review 恢复动作。",
      }));
      elements.reviewHost.replaceChildren();
    }
    const terminal = Boolean(batch && TERMINAL_BATCH_STATUSES.has(batch.status));
    findButton(elements, "load").disabled = Boolean(busy || !elements.recent.value);
    findButton(elements, "refresh").disabled = Boolean(busy);
    findButton(elements, "cancel").disabled = Boolean(busy || !batch || terminal);
    findButton(elements, "retry").disabled = Boolean(busy || !batch?.resumable || !terminal);
    findButton(elements, "rerun").disabled = Boolean(busy || !batch || !terminal);
    restoreTasksFocus(root, focusToken);
  };

  const onFilterChange = () => render(store.getState().batches);
  elements.recentFilter.addEventListener("change", onFilterChange);
  elements.recent.addEventListener("change", onFilterChange);
  const unsubscribe = store.subscribe((state) => state.batches, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    selectedRecentId: () => elements.recent.value,
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    setWorkspacePhase(phase, message = "") {
      workspacePhase = phase;
      workspacePhaseMessage = message;
      render(store.getState().batches);
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      for (const control of elements.actionsRow.querySelectorAll("button, select")) {
        control.disabled = Boolean(kind);
      }
      const labels = {
        load: "正在加载…",
        refresh: "正在刷新…",
        retry: "正在重试…",
        rerun: "正在重新规划…",
        cancel: "正在取消…",
      };
      const defaults = {
        load: "查看所选批次",
        refresh: "刷新全部事实",
        retry: "重试未完成项",
        rerun: "重新规划",
        cancel: "取消批次",
      };
      for (const [action, label] of Object.entries(labels)) {
        const control = findButton(elements, action);
        control.textContent = kind === action ? label : defaults[action];
        control.toggleAttribute("aria-busy", kind === action);
      }
      render(store.getState().batches);
    },
    clearError,
    showError,
    destroy() {
      unsubscribe();
      elements.recentFilter.removeEventListener("change", onFilterChange);
      elements.recent.removeEventListener("change", onFilterChange);
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
