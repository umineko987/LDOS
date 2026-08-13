import crawlApplication from "../apps/crawl.js";
import tasksApplication from "../apps/tasks.js";
import proxyApplication from "../apps/proxy.js";
import vaultApplication from "../apps/vault.js";
import reviewApplication from "../apps/review.js";
import policyApplication from "../apps/policy.js";
import diagnosticsApplication from "../apps/diagnostics.js";
import personalizationApplication from "../apps/personalization.js";
import galleryApplication from "../apps/gallery.js";
import scheduleApplication from "../apps/schedule.js";
import { createPlaceholderApplication } from "../apps/placeholder.js";
import {
  applicationDefinitions,
  DEFAULT_APP_ID,
  DEFAULT_ROUTE,
} from "./app-definitions.js";
import { createApplicationRegistry } from "./app-registry-factory.js";

const controllers = [
  ["crawl", crawlApplication],
  ["tasks", tasksApplication],
  ["proxy", proxyApplication],
  ["vault", vaultApplication],
  ["review", reviewApplication],
  ["policy", policyApplication],
  ["diagnostics", diagnosticsApplication],
  ["personalization", personalizationApplication],
  ["gallery", galleryApplication],
  ["schedule", scheduleApplication],
  ["export", createPlaceholderApplication("将审核后的图片整理并导出为数据集。")],
];

const registry = createApplicationRegistry(applicationDefinitions, controllers);

export const applications = registry.applications;
export const getApplicationById = registry.getApplicationById;
export const getApplicationByRoute = registry.getApplicationByRoute;
export { DEFAULT_APP_ID, DEFAULT_ROUTE };
