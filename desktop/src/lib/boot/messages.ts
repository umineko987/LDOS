import { apiErrorMessage } from "#lib/api/messages.ts";
import { m } from "#lib/paraglide/messages.js";
import type { BackendStatusCode } from "#lib/platform/sanitize.ts";

import type { BootSnapshot } from "./gate.ts";

const STATUS_MESSAGES: Readonly<Record<BackendStatusCode, () => string>> = {
  backend_config_invalid: m.boot_backend_config_invalid,
  backend_exited: m.boot_backend_exited,
  backend_start_failed: m.boot_backend_start_failed,
  backend_start_timeout: m.boot_backend_start_timeout,
  backend_stopped: m.boot_backend_stopped,
  platform_unavailable: m.boot_platform_unavailable,
};

export function bootTitle(snapshot: BootSnapshot): string {
  return snapshot.phase === "failed" ? m.boot_title_failed() : m.boot_title_starting();
}

/** 启动门下方的一行状态说明。 */
export function bootMessage(snapshot: BootSnapshot): string {
  switch (snapshot.failure) {
    case "request_failed":
      return apiErrorMessage(snapshot.error);
    case "unhealthy":
      return m.boot_unhealthy();
    case "runtime_unavailable":
      return m.boot_runtime_unavailable();
  }
  if (snapshot.status?.code) return STATUS_MESSAGES[snapshot.status.code]();
  switch (snapshot.status?.state) {
    case "failed":
      return m.boot_host_failed();
    case "stopped":
      return m.boot_backend_stopped();
    case "ready":
      return snapshot.phase === "ready" ? m.boot_ready() : m.boot_connecting();
    default:
      return m.boot_starting();
  }
}
