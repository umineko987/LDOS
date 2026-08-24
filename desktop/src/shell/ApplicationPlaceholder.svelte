<script lang="ts">
  import type { ApplicationDefinition } from "../core/applications/definitions";
  import Icon from "./Icon.svelte";

  let { application }: { application: ApplicationDefinition } = $props();
  const preview = $derived(application.availability === "preview");
</script>

<section class="application-placeholder" data-application-content={application.id} aria-labelledby="content-title-{application.id}">
  <div class="application-placeholder__identity">
    <span class="application-placeholder__icon" aria-hidden="true">
      <Icon name={application.icon} size={30} />
    </span>
    <div>
      <p class="application-placeholder__status" data-availability={application.availability}>
        {preview ? "前端预览 · 后端能力尚未接入" : "应用迁移将在后续阶段接入"}
      </p>
      <h1 id="content-title-{application.id}">{application.title}</h1>
    </div>
  </div>
  <p class="application-placeholder__description">{application.description}</p>
  <div class="application-placeholder__boundary" role="status">
    <strong>{preview ? "Preview" : "P2 Shell"}</strong>
    <span>
      {preview
        ? "本阶段不发送业务请求，也不提供伪数据或写入能力。"
        : "当前仅验证桌面窗口、路由、持久化与无障碍壳层；业务状态仍由后续应用阶段实现。"}
    </span>
  </div>
</section>
