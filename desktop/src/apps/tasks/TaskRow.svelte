<script lang="ts">
  import { formatTaskBytes, shortBatchId, siteLabel, type TaskEntity } from "./model";

  let { task }: { task: TaskEntity } = $props();
  const errorLabel = $derived(task.errorCategory?.label ?? "无错误");
  const fileLabel = $derived(task.artifactCount || task.artifactBytes
    ? `${task.artifactCount} 个文件 · ${formatTaskBytes(task.artifactBytes)}`
    : "尚无文件");
</script>

<tr
  data-task-row
  data-task-id={task.id}
  data-task-status={task.status}
  title={`${errorLabel} · ${fileLabel}`}
>
  <td>{task.sourceOrder + 1}.{task.addressOrder + 1}.{task.sequence}</td>
  <td>
    <strong>{siteLabel(task.site)}</strong>
    <span>{task.addressId ? shortBatchId(task.addressId) : "地址不可用"}</span>
  </td>
  <td><span class="tasks-status" data-status-kind={task.statusKind}>{task.statusLabel}</span></td>
  <td>{task.attemptCount}/{task.maxAttempts}</td>
  <td>{errorLabel}</td>
  <td>{fileLabel}</td>
</tr>
