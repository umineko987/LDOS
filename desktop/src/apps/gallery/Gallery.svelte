<script lang="ts">
  import { onMount, untrack } from "svelte";

  import { createGalleryController } from "./controller";
  import { galleryPreviewPresentation, type GalleryCollection, type GalleryMode, type GallerySort } from "./model";
  import { createGalleryStore } from "./state";
  import "./gallery.css";

  const runtime = untrack(() => {
    const store = createGalleryStore();
    return { store, controller: createGalleryController(store) };
  });
  const { store, controller } = runtime;
  const snapshot = $derived($store);
  const presentation = galleryPreviewPresentation();
  const disabledReason = "图片库后端能力尚未接入；动作已禁用，不会读取下载目录、修改文件或发送业务请求。";

  function chooseCollection(collection: GalleryCollection): void { controller.selectCollection(collection); }
  function chooseMode(mode: GalleryMode): void { controller.setMode(mode); }
  function updateQuery(event: Event): void { controller.setQuery((event.currentTarget as HTMLInputElement).value); }
  function updateSort(event: Event): void { controller.setSort((event.currentTarget as HTMLSelectElement).value as GallerySort); }
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

<section class="gallery-app" data-gallery-app data-domain-owner="gallery" data-preview-availability="unavailable" aria-labelledby="gallery-heading">
  <header class="gallery-header">
    <div><p>图片库 · Preview</p><h1 id="gallery-heading">媒体浏览工作区</h1></div>
    <span class="gallery-status" data-kind={presentation.kind}>{presentation.label}</span>
  </header>
  <p class="gallery-live" role="status" aria-live="polite">{presentation.message}</p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-scrollable gallery workspace) -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard-scrollable gallery workspace) -->
  <section class="gallery-workspace" tabindex="0" onkeydown={scrollWorkspace} aria-label="图片库三栏预览工作区；普通窗口可横向滚动">
    <div class="gallery-workspace-track">
      <aside class="gallery-column gallery-column--navigation" aria-labelledby="gallery-navigation-heading">
        <header class="gallery-column-header"><p>01 · 浏览</p><h2 id="gallery-navigation-heading">资料库导航</h2><span>保留浏览、筛选和视图结构，不读取真实媒体。</span></header>
        <div class="gallery-column-scroll">
          <nav class="gallery-navigation" aria-label="图片库分区">
            <button type="button" aria-pressed={snapshot.collection === "library"} onclick={() => chooseCollection("library")}>图库</button>
            <button type="button" aria-pressed={snapshot.collection === "favorites"} onclick={() => chooseCollection("favorites")}>收藏</button>
            <button type="button" aria-pressed={snapshot.collection === "sources"} onclick={() => chooseCollection("sources")}>来源</button>
          </nav>
          <label class="gallery-field"><span>安全搜索预览</span><input type="search" value={snapshot.query} maxlength="80" autocomplete="off" placeholder="搜索标题或站点" oninput={updateQuery} /></label>
          <label class="gallery-field"><span>排序</span><select value={snapshot.sort} onchange={updateSort}><option value="newest">最近完成</option><option value="oldest">最早完成</option><option value="site">按站点</option></select></label>
          <p class="gallery-note">搜索与排序仅改变当前内存中的预览控件；不会触发文件扫描或网络请求。</p>
        </div>
      </aside>

      <main class="gallery-column gallery-column--content" aria-labelledby="gallery-content-heading">
        <header class="gallery-column-header"><p>02 · 内容</p><h2 id="gallery-content-heading">媒体与批次</h2><span>网格、列表和 Quick Look 的信息架构已明确；真实媒体能力尚不可用。</span></header>
        <div class="gallery-column-scroll">
          <section class="gallery-toolbar" aria-label="图片库视图选项">
            <span>视图</span>
            <div role="group" aria-label="媒体显示方式">
              <button type="button" aria-pressed={snapshot.mode === "grid"} onclick={() => chooseMode("grid")}>网格</button>
              <button type="button" aria-pressed={snapshot.mode === "list"} onclick={() => chooseMode("list")}>列表</button>
            </div>
          </section>
          <section class="gallery-unavailable" role="status" aria-live="polite">
            <strong>暂无安全媒体事实</strong>
            <p>后端能力接入前不会生成示例图片、路径、计数或批次记录。</p>
            {#if snapshot.query}<small>当前仅预览筛选词：{snapshot.query}</small>{/if}
          </section>
          <section class="gallery-actions" aria-labelledby="gallery-write-reason">
            <button type="button" disabled aria-describedby="gallery-write-reason" title={disabledReason}>打开 Quick Look</button>
            <button type="button" disabled aria-describedby="gallery-write-reason" title={disabledReason}>收藏</button>
            <button type="button" disabled aria-describedby="gallery-write-reason" title={disabledReason}>从收藏移除</button>
          </section>
          <p id="gallery-write-reason" class="gallery-disabled-reason">{disabledReason}</p>
        </div>
      </main>

      <aside class="gallery-column gallery-column--inspector" aria-labelledby="gallery-inspector-heading" data-inspector-open={snapshot.inspectorOpen}>
        <header class="gallery-column-header"><p>03 · 检查器</p><h2 id="gallery-inspector-heading">安全媒体事实</h2><span>只展示未来可验证的安全字段，不展示文件名、路径或原始地址。</span></header>
        <div class="gallery-column-scroll">
          <button class="gallery-inspector-toggle" type="button" aria-expanded={snapshot.inspectorOpen} onclick={() => controller.toggleInspector()}>{snapshot.inspectorOpen ? "收起检查器" : "展开检查器"}</button>
          {#if snapshot.inspectorOpen}
            <section class="gallery-inspector-empty" role="status"><strong>尚未选择媒体</strong><p>后端能力尚未接入，因此没有可检查的媒体事实。</p></section>
          {/if}
          <dl class="gallery-facts"><div><dt>收藏视图</dt><dd>{snapshot.collection === "favorites" ? "已选择" : "未选择"}</dd></div><div><dt>内容模式</dt><dd>{snapshot.mode === "grid" ? "网格" : "列表"}</dd></div><div><dt>写入能力</dt><dd>不可用</dd></div></dl>
        </div>
      </aside>
    </div>
  </section>
</section>
