const APPLICATION_METADATA_KEYS = Object.freeze([
  "id",
  "label",
  "icon",
  "route",
  "windowTitle",
  "availability",
  "defaultWindowState",
]);

const AVAILABILITIES = new Set(["ready", "placeholder"]);
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
    for (const field of ["label", "icon", "windowTitle"]) {
      if (typeof item[field] !== "string" || !item[field]) {
        throw new TypeError(`${item.id} 应用元数据字段无效：${field}`);
      }
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
    windowTitle: "C:\\IMAGEWEAVE\\CRAWL.EXE",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "tasks",
    label: "批次管理",
    icon: "list",
    route: "/tasks",
    windowTitle: "C:\\IMAGEWEAVE\\TASKMGR.EXE",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "proxy",
    label: "代理管理",
    icon: "network",
    route: "/proxy",
    windowTitle: "C:\\IMAGEWEAVE\\PROXY.CPL",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "vault",
    label: "授权管理",
    icon: "key",
    route: "/vault",
    windowTitle: "C:\\IMAGEWEAVE\\VAULT.CPL",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "review",
    label: "去重审核",
    icon: "images",
    route: "/review",
    windowTitle: "C:\\IMAGEWEAVE\\REVIEW.EXE",
    availability: "ready",
    defaultWindowState: "maximized",
  },
  {
    id: "policy",
    label: "站点设置",
    icon: "sliders",
    route: "/policy",
    windowTitle: "C:\\IMAGEWEAVE\\POLICY.CPL",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "diagnostics",
    label: "系统诊断",
    icon: "activity",
    route: "/diagnostics",
    windowTitle: "C:\\IMAGEWEAVE\\DIAG.EXE",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "personalization",
    label: "外观设置",
    icon: "sliders",
    route: "/personalization",
    windowTitle: "C:\\IMAGEWEAVE\\DESKTOP.CPL",
    availability: "ready",
    defaultWindowState: "normal",
  },
  {
    id: "gallery",
    label: "图片库",
    icon: "folder",
    route: "/gallery",
    windowTitle: "C:\\IMAGEWEAVE\\GALLERY.EXE",
    availability: "placeholder",
    defaultWindowState: "normal",
  },
  {
    id: "schedule",
    label: "定时任务",
    icon: "calendar",
    route: "/schedule",
    windowTitle: "C:\\IMAGEWEAVE\\SCHEDULE.EXE",
    availability: "placeholder",
    defaultWindowState: "normal",
  },
  {
    id: "export",
    label: "数据集导出",
    icon: "archive",
    route: "/export",
    windowTitle: "C:\\IMAGEWEAVE\\EXPORT.EXE",
    availability: "placeholder",
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
