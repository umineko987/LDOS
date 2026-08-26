<script lang="ts">
  import { onMount, untrack } from "svelte";

  import { createExportController } from "./controller";
  import { exportPreviewPresentation } from "./model";
  import { createExportStore } from "./state";
  import "./export.css";

  const runtime = untrack(() => {
    const store = createExportStore();
    return { store, controller: createExportController(store) };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const presentation = exportPreviewPresentation();
  const disabledReason = "数据集导出后端能力尚未接入；动作已禁用，不会写入文件、读取路径或发送业务请求。";

  function scrollWorkspace(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    const distance = Math.max(240, element.clientWidth * 0.72);
    element.scrollBy({ left: event.key === "ArrowRight" ? distance : -distance });
  }

  onMount(() => {
    controller.activate();
    return () => controller.destroy();
  });
</script>

<section class="export-app" data-export-app data-domain-owner="export" data-preview-availability={snapshot.phase} aria-labelledby="export-heading">
  <header class="export-header">
    <div><p>数据集导出 · Preview</p><h1 id="export-heading">确定性导出工作区</h1></div>
    <span class="export-status" data-kind={presentation.kind}>{presentation.label}</span>
  </header>
  <p class="export-live" role="status" aria-live="polite">{presentation.message}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable export workspace) -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard-scrollable export workspace) -->
  <section class="export-workspace" tabindex="0" onkeydown={scrollWorkspace} aria-label="数据集导出三栏预览工作区；普通窗口可横向滚动">
    <div class="export-workspace-track">
      <aside class="export-column export-column--sources" aria-labelledby="export-sources-heading">
        <header class="export-column-header"><p>01 · 来源</p><h2 id="export-sources-heading">安全来源选择</h2><span>只呈现来源选择结构；不会生成示例来源、路径或计数。</span></header>
        <div class="export-column-scroll" tabindex="0" aria-label="导出来源内容；可滚动">
          <section class="export-unavailable" role="status" aria-live="polite"><strong>暂无安全来源事实</strong><p>后端能力接入前不读取批次、媒体或文件系统。</p></section>
          <p class="export-selection-facts">未选择来源。</p>
        </div>
      </aside>

      <main class="export-column export-column--config" aria-labelledby="export-config-heading">
        <header class="export-column-header"><p>02 · 配置</p><h2 id="export-config-heading">格式与目标</h2><span>保留确定性配置结构；全部控件保持禁用且不访问文件系统。</span></header>
        <div class="export-column-scroll" tabindex="0" aria-label="导出配置内容；可滚动">
          <fieldset class="export-config" disabled aria-describedby="export-write-reason">
            <legend>导出配置预览</legend>
            <label><span>导出格式</span><select><option value="">尚不可配置</option><option value="manifest">Manifest</option><option value="coco">COCO</option><option value="webdataset">WebDataset</option></select></label>
            <label><span>每分片项目数</span><input type="number" min="1" max="100000" step="1" value="" placeholder="尚不可配置" /></label>
            <label class="export-check"><input type="checkbox" /> <span>包含安全元数据</span></label>
            <label class="export-check"><input type="checkbox" /> <span>包含拒绝项</span></label>
          </fieldset>
          <section class="export-destination" aria-labelledby="export-destination-heading"><h3 id="export-destination-heading">目标摘要</h3><p>目标摘要不可用；不会读取或显示路径。</p><button type="button" disabled aria-describedby="export-write-reason" title={disabledReason}>选择目标</button></section>
          <div class="export-actions"><button type="button" disabled aria-describedby="export-write-reason" title={disabledReason}>开始导出</button><button type="button" disabled aria-describedby="export-write-reason" title={disabledReason}>取消导出</button><button type="button" disabled aria-describedby="export-write-reason" title={disabledReason}>打开结果</button></div>
          <p id="export-write-reason" class="export-disabled-reason">{disabledReason}</p>
        </div>
      </main>

      <aside class="export-column export-column--progress" aria-labelledby="export-progress-heading">
        <header class="export-column-header"><p>03 · 进度与结果</p><h2 id="export-progress-heading">确定性运行事实</h2><span>进度只能来自未来受控能力；界面不使用计时器或模拟运行。</span></header>
        <div class="export-column-scroll" tabindex="0" aria-label="导出进度与结果内容；可滚动">
          <section class="export-progress-empty" role="status" aria-live="polite"><strong>暂无进度事实</strong><p>当前不会创建作业、虚构进度、结果文件或完成状态。</p><p>下一步：等待后端能力接入；界面不会自行启动导出。</p></section>
        </div>
      </aside>
    </div>
  </section>
</section>
