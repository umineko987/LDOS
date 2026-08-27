export const APPLICATION_GROUPS = Object.freeze([
  Object.freeze({ id: "workflow", title: "工作流", order: 0 }),
  Object.freeze({ id: "connections", title: "连接与策略", order: 1 }),
  Object.freeze({ id: "system", title: "系统", order: 2 }),
] as const);

const DEFAULT_WINDOW_RECT = Object.freeze({ x: 160, y: 64, w: 800, h: 560 });

const definitions = [
  {
    id: "crawl",
    route: "/crawl",
    title: "图片采集",
    icon: "download",
    group: "workflow",
    order: 0,
    description: "搜索来源、选择地址并创建有序采集批次。",
    availability: "ready",
    dockOrder: 0,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "tasks",
    route: "/tasks",
    title: "批次管理",
    icon: "list",
    group: "workflow",
    order: 1,
    description: "查看采集进度，并取消、重试或重新规划批次。",
    availability: "ready",
    dockOrder: 1,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "proxy",
    route: "/proxy",
    title: "代理管理",
    icon: "network",
    group: "connections",
    order: 0,
    description: "管理代理来源、运行池状态与连接探测。",
    availability: "ready",
    dockOrder: null,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "vault",
    route: "/vault",
    title: "授权管理",
    icon: "key",
    group: "connections",
    order: 1,
    description: "管理站点授权、浏览器会话与授权代理。",
    availability: "ready",
    dockOrder: null,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "review",
    route: "/review",
    title: "去重审核",
    icon: "images",
    group: "workflow",
    order: 3,
    description: "比较重复候选、确认保留项并应用整理结果。",
    availability: "ready",
    dockOrder: 3,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "maximized" },
  },
  {
    id: "policy",
    route: "/policy",
    title: "站点设置",
    icon: "sliders",
    group: "connections",
    order: 2,
    description: "配置各站点的并发、重试和代理策略。",
    availability: "ready",
    dockOrder: null,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "diagnostics",
    route: "/diagnostics",
    title: "系统诊断",
    icon: "activity",
    group: "system",
    order: 0,
    description: "检查服务、配置能力与调度器健康状态。",
    availability: "ready",
    dockOrder: null,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "personalization",
    route: "/personalization",
    title: "外观设置",
    icon: "sliders",
    group: "system",
    order: 1,
    description: "选择内置夜景场景并调整界面动效。",
    availability: "ready",
    dockOrder: null,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
  {
    id: "gallery",
    route: "/gallery",
    title: "图片库",
    icon: "folder",
    group: "workflow",
    order: 2,
    description: "浏览、管理图片，并将完整目录复制到数据集目标。",
    availability: "ready",
    dockOrder: 2,
    defaultWindow: { rect: DEFAULT_WINDOW_RECT, state: "normal" },
  },
] as const;

export type ApplicationDefinition = typeof definitions[number];
export type ApplicationId = ApplicationDefinition["id"];
export type ApplicationRoute = ApplicationDefinition["route"];
export type ApplicationIcon = ApplicationDefinition["icon"];
export type ApplicationGroupId = ApplicationDefinition["group"];
export type ApplicationAvailability = ApplicationDefinition["availability"];
export type DefaultWindowState = ApplicationDefinition["defaultWindow"]["state"];
export type WindowRect = Readonly<{ x: number; y: number; w: number; h: number }>;

function freezeDefinition(definition: ApplicationDefinition): ApplicationDefinition {
  return Object.freeze({
    ...definition,
    defaultWindow: Object.freeze({
      ...definition.defaultWindow,
      rect: Object.freeze({ ...definition.defaultWindow.rect }),
    }),
  }) as ApplicationDefinition;
}

export const APPLICATION_DEFINITIONS = Object.freeze(definitions.map(freezeDefinition));
export const APPLICATION_IDS = Object.freeze(APPLICATION_DEFINITIONS.map(({ id }) => id));

const byId = new Map<ApplicationId, ApplicationDefinition>(
  APPLICATION_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const byRoute = new Map<ApplicationRoute, ApplicationDefinition>(
  APPLICATION_DEFINITIONS.map((definition) => [definition.route, definition]),
);

export function getApplicationDefinition(id: ApplicationId): ApplicationDefinition;
export function getApplicationDefinition(id: string | null | undefined): ApplicationDefinition | null;
export function getApplicationDefinition(id: string | null | undefined): ApplicationDefinition | null {
  return typeof id === "string" ? byId.get(id as ApplicationId) ?? null : null;
}

export function getApplicationDefinitionByRoute(route: string | null | undefined): ApplicationDefinition | null {
  return typeof route === "string" ? byRoute.get(route as ApplicationRoute) ?? null : null;
}
