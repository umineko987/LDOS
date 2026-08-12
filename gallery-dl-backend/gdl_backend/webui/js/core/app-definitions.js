const APPLICATION_METADATA_KEYS = Object.freeze([
  "id",
  "label",
  "icon",
  "route",
  "windowTitle",
  "group",
  "description",
  "availability",
  "defaultWindowState",
]);

export const APPLICATION_GROUPS = Object.freeze([
  Object.freeze({
    id: "workflow",
    title: "工作流",
    appIds: Object.freeze(["crawl", "tasks", "gallery", "review", "schedule", "export"]),
  }),
  Object.freeze({
    id: "connections",
    title: "连接与策略",
    appIds: Object.freeze(["proxy", "vault", "policy"]),
  }),
  Object.freeze({
    id: "system",
    title: "系统",
    appIds: Object.freeze(["diagnostics", "personalization"]),
  }),
]);

const APPLICATION_GROUP_IDS = new Set(APPLICATION_GROUPS.map((group) => group.id));
const AVAILABILITIES = new Set(["ready", "preview", "placeholder"]);
const DEFAULT_WINDOW_STATES = new Set(["normal", "maximized"]);

export function validateApplicationDefinitions(items) {
  if (!Array.isArray(items)) throw new TypeError("应用元数据必须是数组");
  const ids = new Set();
  const routes = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("应用元数据必须是对象");
    }
    if (typeof item.id !== "string" || !item.id) {
      throw new TypeError("应用 ID 无效");
    }
    if (ids.has(item.id)) throw new Error(`应用 ID 重复：${item.id}`);
    if (typeof item.route !== "string") throw new TypeError(`${item.id} 应用路由无效`);
    if (routes.has(item.route)) throw new Error(`应用路由重复：${item.route}`);
    if (!item.route.startsWith("/") || item.route.includes("?") || item.route.includes("#")) {
      throw new Error(`应用路由格式无效：${item.route}`);
    }
    if (
      Object.keys(item).length !== APPLICATION_METADATA_KEYS.length
      || !APPLICATION_METADATA_KEYS.every((key) => (
        Object.prototype.hasOwnProperty.call(item, key)
      ))
    ) {
      throw new TypeError(`${item.id} 应用元数据字段无效`);
    }
    for (const field of ["label", "icon", "windowTitle", "description"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) {
        throw new TypeError(`${item.id} 应用元数据字段无效：${field}`);
      }
    }
    if (!APPLICATION_GROUP_IDS.has(item.group)) {
      throw new TypeError(`${item.id} 应用分组无效`);
    }
    const declaredGroup = APPLICATION_GROUPS.find((group) => group.id === item.group);
    if (!declaredGroup?.appIds.includes(item.id)) {
      throw new TypeError(`${item.id} 应用分组与固定顺序不一致`);
    }
    if (!AVAILABILITIES.has(item.availability)) {
      throw new TypeError(`${item.id} 应用可用性无效`);
    }
    if (!DEFAULT_WINDOW_STATES.has(item.defaultWindowState)) {
      throw new TypeError(`${item.id} 默认窗口状态无效`);
    }
    ids.add(item.id);
    routes.add(item.route);
  }
  return items;
}

const definitions = [
  {
    id: "crawl",
    label: "图片采集",
    icon: "download",
    route: "/crawl",
    windowTitle: "图片采集",
    group: "workflow",
    description: "搜索来源、选择地址并创建有序采集批次。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "tasks",
    label: "批次管理",
    icon: "list",
    route: "/tasks",
    windowTitle: "批次管理",
    group: "workflow",
    description: "查看采集进度，并取消、重试或重新规划批次。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "proxy",
    label: "代理管理",
    icon: "network",
    route: "/proxy",
    windowTitle: "代理管理",
    group: "connections",
    description: "管理代理来源、运行池状态与连接探测。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "vault",
    label: "授权管理",
    icon: "key",
    route: "/vault",
    windowTitle: "授权管理",
    group: "connections",
    description: "管理站点授权、浏览器会话与授权代理。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "review",
    label: "去重审核",
    icon: "images",
    route: "/review",
    windowTitle: "去重审核",
    group: "workflow",
    description: "比较重复候选、确认保留项并应用整理结果。",
    availability: "ready",
    defaultWindowState: "maximized",
  },
  {
    id: "policy",
    label: "站点设置",
    icon: "sliders",
    route: "/policy",
    windowTitle: "站点设置",
    group: "connections",
    description: "配置各站点的并发、重试和代理策略。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "diagnostics",
    label: "系统诊断",
    icon: "activity",
    route: "/diagnostics",
    windowTitle: "系统诊断",
    group: "system",
    description: "检查服务、配置能力与调度器健康状态。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "personalization",
    label: "外观设置",
    icon: "sliders",
    route: "/personalization",
    windowTitle: "外观设置",
    group: "system",
    description: "调整主题、壁纸、窗口可读性与动效。",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "gallery",
    label: "图片库",
    icon: "folder",
    route: "/gallery",
    windowTitle: "图片库",
    group: "workflow",
    description: "浏览、搜索和整理已下载的图片。",
    availability: "preview",
    defaultWindowState: "normal",
  },
  {
    id: "schedule",
    label: "定时任务",
    icon: "calendar",
    route: "/schedule",
    windowTitle: "定时任务",
    group: "workflow",
    description: "查看与编辑自动采集计划。",
    availability: "preview",
    defaultWindowState: "normal",
  },
  {
    id: "export",
    label: "数据集导出",
    icon: "archive",
    route: "/export",
    windowTitle: "数据集导出",
    group: "workflow",
    description: "配置来源并导出审核后的数据集。",
    availability: "preview",
    defaultWindowState: "normal",
  },
];

validateApplicationDefinitions(definitions);

export const applicationDefinitions = Object.freeze(
  definitions.map((definition) => Object.freeze({ ...definition })),
);

const definitionById = new Map(
  applicationDefinitions.map((definition) => [definition.id, definition]),
);
const definitionByRoute = new Map(
  applicationDefinitions.map((definition) => [definition.route, definition]),
);

export const DEFAULT_APP_ID = "crawl";
const defaultApplication = definitionById.get(DEFAULT_APP_ID);
if (!defaultApplication) throw new Error(`默认应用未定义：${DEFAULT_APP_ID}`);
export const DEFAULT_ROUTE = defaultApplication.route;

export function getApplicationDefinitionById(id) {
  return definitionById.get(id) || null;
}

export function getApplicationDefinitionByRoute(route) {
  return definitionByRoute.get(route) || null;
}
