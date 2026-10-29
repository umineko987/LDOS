// 图库页的纯逻辑：来源状态、路由路径、面包屑、改名校验。

import type { ComponentStatus } from "#lib/api/queries/system.ts";

/** GallerySourceResponse["availability"]。 */
export type SourceAvailability = "available" | "offline" | "conflict" | "scanning" | "error";

/** 列表里显示的来源状态：有扫描任务在跑时一律算 scanning。 */
export function sourceState(availability: SourceAvailability, scanning: boolean): SourceAvailability {
  return scanning ? "scanning" : availability;
}

/** 状态点的颜色（不用金色）。 */
export const SOURCE_DOT: Readonly<Record<SourceAvailability, ComponentStatus>> = {
  available: "ok",
  scanning: "warning",
  conflict: "warning",
  offline: "disabled",
  error: "error",
};

/** 扫描任务的 id（后端 gallery_service 固定写法）。 */
export function scanJobId(sourceId: string): string {
  return `scan:${sourceId}`;
}

/** 浏览页的路由路径（不带 `#`）。来源根目录不写目录段。 */
export function libraryPath(sourceId: string, directoryId?: string | null, rootDirectoryId?: string | null): string {
  const source = `/library/${encodeURIComponent(sourceId)}`;
  return directoryId && directoryId !== rootDirectoryId ? `${source}/${encodeURIComponent(directoryId)}` : source;
}

export interface Crumb {
  readonly directoryId: string;
  readonly label: string;
  readonly path: string;
}

interface DirectoryLike {
  readonly directory_id: string;
  readonly name: string;
  readonly parent_id?: string | null;
}

/** 面包屑：根目录显示来源名，其余显示目录名。 */
export function crumbs(sourceId: string, sourceName: string, chain: readonly DirectoryLike[]): Crumb[] {
  const rootId = chain.find((directory) => !directory.parent_id)?.directory_id ?? null;
  return chain.map((directory) => ({
    directoryId: directory.directory_id,
    label: directory.directory_id === rootId ? sourceName || directory.name : directory.name,
    path: libraryPath(sourceId, directory.directory_id, rootId),
  }));
}

/** 去掉扩展名（`extension` 带点，和后端的 asset.extension 一致）后的主名。 */
export function stemOf(name: string, extension: string): string {
  if (extension && name.toLowerCase().endsWith(extension.toLowerCase()) && name.length > extension.length) {
    return name.slice(0, -extension.length);
  }
  return name;
}

export type StemProblem = "empty" | "unchanged" | "invalid" | "extension" | "too_long";

const MAX_STEM_LENGTH = 255;
// Windows 不允许的字符、路径分隔符和控制字符。
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"|?*/\\\u0000-\u001f]/;

/**
 * 新主名的问题（和后端 _validate_new_base_name 一致）；没问题返回 null。
 * 调用方提交 `stem.trim()`。
 */
export function stemProblem(stem: string, current: string, extension: string): StemProblem | null {
  const value = stem.trim();
  if (!value) return "empty";
  if (value === current) return "unchanged";
  if (value.length > MAX_STEM_LENGTH) return "too_long";
  if (FORBIDDEN.test(value) || value === "." || value === ".." || value.endsWith(".")) return "invalid";
  if (extension && value.toLowerCase().endsWith(extension.toLowerCase())) return "extension";
  return null;
}
