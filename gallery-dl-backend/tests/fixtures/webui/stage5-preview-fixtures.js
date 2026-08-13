const freeze = (value) => Object.freeze(value);

export const TESTS_ONLY_STAGE5 = true;

export const galleryItems = freeze([
  freeze({ id: "media-01", label: "雾中构图", collection: "library", sourceLabel: "合成来源 A", kind: "PNG", width: 1600, height: 1200, favorite: true, tags: freeze(["风景", "雾"]), mediaToken: "synthetic-gallery-01", mediaVariant: "mist" }),
  freeze({ id: "media-02", label: "余烬色块", collection: "library", sourceLabel: "合成来源 B", kind: "WebP", width: 1200, height: 1600, favorite: false, tags: freeze(["色块", "暖色"]), mediaToken: "synthetic-gallery-02", mediaVariant: "ember" }),
  freeze({ id: "media-03", label: "林间结构", collection: "library", sourceLabel: "合成来源 A", kind: "PNG", width: 1800, height: 1200, favorite: true, tags: freeze(["结构", "绿色"]), mediaToken: "synthetic-gallery-03", mediaVariant: "forest" }),
  freeze({ id: "media-04", label: "梅灰研究", collection: "library", sourceLabel: "合成来源 C", kind: "JPEG", width: 1400, height: 1400, favorite: false, tags: freeze(["研究", "方形"]), mediaToken: "synthetic-gallery-04", mediaVariant: "plum" }),
  freeze({ id: "media-05", label: "深海层次", collection: "library", sourceLabel: "合成来源 B", kind: "WebP", width: 1920, height: 1080, favorite: false, tags: freeze(["层次", "蓝色"]), mediaToken: "synthetic-gallery-05", mediaVariant: "ocean" }),
  freeze({ id: "media-06", label: "沙面几何", collection: "library", sourceLabel: "合成来源 C", kind: "PNG", width: 1080, height: 1350, favorite: true, tags: freeze(["几何", "暖纸"]), mediaToken: "synthetic-gallery-06", mediaVariant: "sand" }),
]);

export const galleryFixtures = freeze({
  loading: freeze({ phase: "loading" }),
  empty: freeze({ phase: "empty" }),
  content: freeze({ phase: "content", items: galleryItems }),
  error: freeze({ phase: "error", error: freeze({ code: "gallery_fixture_failed", status: 503, requestId: "request-gallery-01", category: "capability" }) }),
});

export const schedulePlans = freeze([
  freeze({ id: "plan-daily", name: "每日精选采集", state: "enabled", scheduleKind: "daily", scheduleLabel: "每天 08:30", concurrency: 6, sourceCount: 3, nextRunLabel: "明日 08:30", lastRunLabel: "今日 08:31 · 已完成" }),
  freeze({ id: "plan-weekly", name: "周末归档", state: "disabled", scheduleKind: "weekly", scheduleLabel: "每周六 21:00", concurrency: 3, sourceCount: 2, nextRunLabel: "计划已停用", lastRunLabel: "上周六 · 已完成" }),
  freeze({ id: "plan-running", name: "高频观察", state: "running", scheduleKind: "interval", scheduleLabel: "每 4 小时", concurrency: 8, sourceCount: 4, nextRunLabel: "当前运行完成后重新计算", lastRunLabel: "本轮正在运行" }),
]);

export const scheduleFixtures = freeze({
  loading: freeze({ phase: "loading" }),
  empty: freeze({ phase: "empty" }),
  content: freeze({ phase: "content", plans: schedulePlans }),
  error: freeze({ phase: "error", error: freeze({ code: "schedule_fixture_failed", status: 503, requestId: "request-schedule-01", category: "capability" }) }),
});

const exportSources = freeze([
  freeze({ id: "source-reviewed", label: "审核完成集", itemCount: 240, reviewedCount: 240, selected: true }),
  freeze({ id: "source-partial", label: "待复核集合", itemCount: 80, reviewedCount: 52, selected: false }),
  freeze({ id: "source-favorites", label: "合成收藏集", itemCount: 36, reviewedCount: 36, selected: true }),
]);

const exportConfig = freeze({ format: "manifest", includeMetadata: true, includeRejected: false, shardSize: 100, destinationLabel: "测试目标 · 合成数据集 A" });

export const exportFixtures = freeze({
  loading: freeze({ phase: "loading" }),
  empty: freeze({ phase: "empty" }),
  content: freeze({ phase: "content", sources: exportSources, config: exportConfig, progress: freeze({ state: "idle", completed: 0, total: 0, resultLabel: "", code: "", category: "" }) }),
  running: freeze({ phase: "content", sources: exportSources, config: exportConfig, progress: freeze({ state: "running", completed: 148, total: 276, resultLabel: "", code: "", category: "" }) }),
  success: freeze({ phase: "content", sources: exportSources, config: exportConfig, progress: freeze({ state: "success", completed: 276, total: 276, resultLabel: "合成导出事实：276 项已完成", code: "", category: "" }) }),
  resultError: freeze({ phase: "content", sources: exportSources, config: exportConfig, progress: freeze({ state: "error", completed: 148, total: 276, resultLabel: "", code: "export_fixture_interrupted", category: "capability" }) }),
  error: freeze({ phase: "error", error: freeze({ code: "export_fixture_failed", status: 503, requestId: "request-export-01", category: "capability" }) }),
});

export function stage5Fixture(appId, stateName) {
  const tables = { gallery: galleryFixtures, schedule: scheduleFixtures, export: exportFixtures };
  const table = tables[appId];
  if (!table || !Object.prototype.hasOwnProperty.call(table, stateName)) throw new TypeError("未知 Stage 5 测试夹具");
  return table[stateName];
}
