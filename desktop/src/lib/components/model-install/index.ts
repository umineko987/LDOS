// 模型安装组件，给需要模型的阶段页（去重、地图、清洗、打标）和设置 › 模型用。
//
// 最常用的是 ModelGate：
//
//   <ModelGate keys={["sscd", "dino"]} bind:ready>
//     …这一步的界面，模型都装好后才渲染…
//   </ModelGate>
//
// - `keys`：GET /api/v1/models 里的 `key`（sscd、dino、completeness、ccip、wd-vit-v3 …）；
//   同包模型（sscd ↔ dino）会一起装。
// - `block`（默认 true）：false 时提示条和 children 同时显示，children 自己看 `ready`。
// - `ready`：可绑定的只读输出，所有 key 都已安装时为 true。
// - `title`：提示条标题，默认「需要先安装模型」。
//
// 需要自己排版时用 useModelInstaller() + InstallButton + ModelStatus + LicenseDialog：
// 同一个页面里只创建一个 installer，把它传给这几个组件；LicenseDialog 必须挂上，
// 否则受限模型的安装会停在许可确认这一步。
//
//   const installer = useModelInstaller();          // { load: false } 时首次 install 再拉表
//   installer.items / loading / error / submitting  // 模型表和请求状态
//   await installer.install(keys)                   // 有受限模型时先打开许可对话框
//   await installer.installMissing()                // 装所有能装的
//
// 进度来自 SSE 的 job.updated（按 job_id 对上模型），安装中另有 5 秒一次的兜底轮询；
// job 结束后重拉 /models 取最终状态。

export { default as InstallButton } from "./install-button.svelte";
export { INSTALL_FALLBACK_POLL_MS, useModelInstaller, type LicenseRequest, type ModelInstaller, type ModelInstallerOptions } from "./installer.svelte.ts";
export { default as LicenseDialog } from "./license-dialog.svelte";
export { default as ModelGate } from "./model-gate.svelte";
export { default as ModelStatus } from "./model-status.svelte";
export { STATUS_LABELS as MODEL_STATUS_LABELS, USE_LABELS as MODEL_USE_LABELS } from "./labels.ts";
