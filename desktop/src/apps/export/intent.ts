// 跨应用导出意图（G6）：Gallery 的“导出此目录”在切换到 Export 前写入待处理意图。

export interface ExportSourceIntent {
  readonly sourceId: string;
  /** null 表示整个来源（来源级范围）。 */
  readonly directoryId: string | null;
  readonly includeDescendants: boolean;
  readonly sourceLabel?: string;
  readonly suggestedAlias?: string;
}

let pendingIntent: ExportSourceIntent | null = null;

export function setPendingExportSource(intent: ExportSourceIntent): void {
  pendingIntent = intent;
}

export function consumePendingExportSource(): ExportSourceIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

export function peekPendingExportSource(): ExportSourceIntent | null {
  return pendingIntent;
}

/** 测试辅助：清空意图。 */
export function clearPendingExportSource(): void {
  pendingIntent = null;
}
