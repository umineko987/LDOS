const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STATE_KEYS = new Set(["phase"]);

export interface ExportPreviewState {
  readonly phase: "unavailable";
}

export interface ExportPreviewPresentation {
  readonly kind: "disabled";
  readonly label: "后端能力尚未接入";
  readonly message: "数据集导出后端能力尚未接入；当前不会读取文件系统或发送业务请求。";
}

export const EXPORT_PREVIEW_DEFAULTS: ExportPreviewState = Object.freeze({ phase: "unavailable" });

export function sanitizeExportPreviewState(raw: unknown): ExportPreviewState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid_export_preview_state");
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("invalid_export_preview_state");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== STATE_KEYS.size) throw new TypeError("invalid_export_preview_state");
  for (const key of keys) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || !STATE_KEYS.has(key)) throw new TypeError("invalid_export_preview_state");
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || descriptor.value !== "unavailable") throw new TypeError("invalid_export_preview_state");
  }
  return EXPORT_PREVIEW_DEFAULTS;
}

export function exportPreviewPresentation(): ExportPreviewPresentation {
  return Object.freeze({
    kind: "disabled",
    label: "后端能力尚未接入",
    message: "数据集导出后端能力尚未接入；当前不会读取文件系统或发送业务请求。",
  });
}
