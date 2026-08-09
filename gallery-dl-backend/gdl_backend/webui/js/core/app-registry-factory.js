import { validateApplicationDefinitions } from "./app-definitions.js";

const REQUIRED_LIFECYCLE_HOOKS = Object.freeze([
  "mount",
  "activate",
  "deactivate",
  "unmount",
]);

export function createApplicationRegistry(definitions, controllerEntries) {
  validateApplicationDefinitions(definitions);
  if (!Array.isArray(controllerEntries)) throw new TypeError("应用控制器必须是数组");

  const controllersById = new Map();
  for (const entry of controllerEntries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new TypeError("应用控制器条目无效");
    }
    const [id, controller] = entry;
    if (controllersById.has(id)) throw new Error(`控制器 ID 重复：${id}`);
    if (!controller || typeof controller !== "object" || Array.isArray(controller)) {
      throw new TypeError(`${id} 应用控制器无效`);
    }
    controllersById.set(id, controller);
  }

  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const extraControllerIds = [...controllersById.keys()].filter((id) => !definitionIds.has(id));
  if (extraControllerIds.length) {
    throw new Error(`存在多余控制器：${extraControllerIds.join(", ")}`);
  }

  const applications = definitions.map((definition) => {
    const controller = controllersById.get(definition.id);
    if (!controller) throw new Error(`${definition.id} 缺少控制器`);
    for (const hook of REQUIRED_LIFECYCLE_HOOKS) {
      if (typeof controller[hook] !== "function") {
        throw new Error(`${definition.id} 缺少生命周期方法：${hook}`);
      }
    }
    for (const key of Object.keys(definition)) {
      if (Object.prototype.hasOwnProperty.call(controller, key)) {
        throw new Error(`${definition.id} 控制器不得覆盖应用元数据：${key}`);
      }
    }
    return Object.freeze({ ...definition, ...controller });
  });

  const frozenApplications = Object.freeze(applications);
  const applicationById = new Map(
    frozenApplications.map((application) => [application.id, application]),
  );
  const applicationByRoute = new Map(
    frozenApplications.map((application) => [application.route, application]),
  );

  return Object.freeze({
    applications: frozenApplications,
    getApplicationById(id) {
      return applicationById.get(id) || null;
    },
    getApplicationByRoute(route) {
      return applicationByRoute.get(route) || null;
    },
  });
}
