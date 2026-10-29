// 设置 › 模型 › 下载：HF 镜像和下载代理的表单草稿、校验、增量提交。
// HF token 不在草稿里：它只写，单独提交，提交后立刻清空输入框。

import type { DownloadSettings, DownloadSettingsUpdate } from "#lib/api/queries/models.ts";

export type DownloadProxyMode = DownloadSettings["proxy_mode"];
export type MirrorChoice = "official" | "preset" | "custom";

/** 预置的国内镜像。 */
export const HF_MIRROR_PRESET = "https://hf-mirror.com";

export interface DownloadDraft {
  readonly mirror: MirrorChoice;
  /** mirror 为 custom 时的地址。 */
  readonly mirrorUrl: string;
  readonly proxyMode: DownloadProxyMode;
  /** 新的自定义代理；留空表示沿用已保存的（后端只回打码后的值，不能回填）。 */
  readonly customProxy: string;
}

export type DraftError = "mirror_required" | "mirror_invalid" | "proxy_required" | "proxy_invalid";

// 与后端一致：不允许空白和控制字符。
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000- \u007f]/;
const PROXY = /^https?:\/\/(?:[^@/?#]+@)?(?:\[[0-9a-f:.]+\]|[^:/?#@[\]]+):\d{1,5}\/?$/i;

export function toDraft(view: DownloadSettings): DownloadDraft {
  const mirror: MirrorChoice = view.hf_mirror === null ? "official" : view.hf_mirror === HF_MIRROR_PRESET ? "preset" : "custom";
  return {
    mirror,
    mirrorUrl: mirror === "custom" ? (view.hf_mirror ?? "") : "",
    proxyMode: view.proxy_mode,
    customProxy: "",
  };
}

export function mirrorValue(draft: DownloadDraft): string | null {
  if (draft.mirror === "official") return null;
  if (draft.mirror === "preset") return HF_MIRROR_PRESET;
  return draft.mirrorUrl.trim().replace(/\/+$/, "");
}

export function isMirrorUrl(value: string): boolean {
  if (!value || value.length > 300 || UNSAFE.test(value) || /[?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 带端口的 HTTP(S) 代理地址，不带路径、查询和片段；可以带凭据。 */
export function isProxyUrl(value: string): boolean {
  return value.length <= 300 && !UNSAFE.test(value) && PROXY.test(value);
}

/** 本地能查出的错误；更细的规则交给后端（错误码 invalid_hf_mirror / invalid_download_proxy）。 */
export function validateDraft(draft: DownloadDraft, view: DownloadSettings): DraftError | null {
  if (draft.mirror === "custom") {
    const mirror = mirrorValue(draft);
    if (!mirror) return "mirror_required";
    if (!isMirrorUrl(mirror)) return "mirror_invalid";
  }
  const proxy = draft.customProxy.trim();
  if (proxy && !isProxyUrl(proxy)) return "proxy_invalid";
  if (draft.proxyMode === "custom" && !proxy && view.custom_proxy === null) return "proxy_required";
  return null;
}

/** 只带改动过的字段；没有改动时返回 null。 */
export function draftChanges(view: DownloadSettings, draft: DownloadDraft): DownloadSettingsUpdate | null {
  const changes: DownloadSettingsUpdate = {};
  const mirror = mirrorValue(draft);
  if (mirror !== view.hf_mirror) changes.hf_mirror = mirror;
  if (draft.proxyMode !== view.proxy_mode) changes.proxy_mode = draft.proxyMode;
  const proxy = draft.customProxy.trim();
  if (proxy) changes.custom_proxy = proxy;
  return Object.keys(changes).length ? changes : null;
}
