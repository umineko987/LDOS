// 侧栏和命令面板共用的导航条目。新增顶层页面时在这里加一项，两边同时出现。

import { dev } from "$app/env";
import { resolve } from "$app/paths";

import type { KeyBinding, Text } from "#lib/keys/keymap.ts";
import type { Section } from "#lib/nav/routes.ts";
import { m } from "#lib/paraglide/messages.js";

export interface NavLink {
  readonly id: string;
  readonly label: Text;
  readonly href: string;
  /** 侧栏高亮用；不在侧栏的条目为 undefined。 */
  readonly section?: Section;
  /** 整页跳转（旧版工作台是另一个应用）。 */
  readonly reload?: boolean;
  readonly keywords?: readonly string[];
  readonly group?: Text;
}

/** 旧版工作台由 vite.legacy.config.ts 构建到 static/legacy/，和新前端同源。 */
export const LEGACY_HREF = "/legacy/index.html";

export function primaryNav(): NavLink[] {
  return [
    { id: "datasets", section: "datasets", label: m.nav_datasets, href: resolve("/"), keywords: ["datasets", "shujuji"] },
    { id: "library", section: "library", label: m.nav_library, href: resolve("/library"), keywords: ["library", "tuku"] },
    { id: "jobs", section: "jobs", label: m.nav_jobs, href: resolve("/jobs"), keywords: ["jobs", "renwu"] },
  ];
}

export function systemNav(): NavLink[] {
  return [
    { id: "settings", section: "settings", label: m.nav_settings, href: resolve("/settings/network"), keywords: ["settings", "shezhi"] },
    { id: "legacy", label: m.nav_legacy, href: LEGACY_HREF, reload: true, keywords: ["legacy", "jiuban"] },
  ];
}

export function settingsNav(): NavLink[] {
  return [
    { id: "settings.network", label: m.nav_settings_network, href: resolve("/settings/network"), keywords: ["network", "proxy"] },
    { id: "settings.models", label: m.nav_settings_models, href: resolve("/settings/models"), keywords: ["models"] },
    { id: "settings.preferences", label: m.nav_settings_preferences, href: resolve("/settings/preferences"), keywords: ["preferences"] },
    { id: "settings.diagnostics", label: m.nav_settings_diagnostics, href: resolve("/settings/diagnostics"), keywords: ["diagnostics", "zhenduan"] },
  ];
}

function devNav(): NavLink[] {
  return dev ? [{ id: "dev.gfx", label: m.nav_gfx, href: resolve("/dev/gfx"), keywords: ["gfx", "webgl"], group: m.keys_group_dev }] : [];
}

/** 命令面板里的导航命令（Phase 1 面板只做导航）。 */
export function navCommands(go: (link: NavLink) => void): KeyBinding[] {
  const settingsLabel = (link: NavLink): Text => () => `${m.nav_settings()} › ${link.label()}`;
  const links = [
    ...primaryNav(),
    ...systemNav().filter((link) => link.id !== "settings"),
    ...settingsNav().map((link) => ({ ...link, label: settingsLabel(link) })),
    ...devNav(),
  ];
  return links.map((link) => ({
    id: `nav.${link.id}`,
    label: link.label,
    group: link.group ?? m.keys_group_navigation,
    keywords: link.keywords,
    palette: true,
    run: () => go(link),
  }));
}
