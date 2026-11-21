// 图库接口的有状态模拟：来源、目录树、图片、回收区、TXT 都在内存里，
// 回收、撤销、恢复、改名、写 TXT 之后的列表请求按新状态回答。
//
//   const library = new FakeLibrary();
//   const source = library.addSource({ name: "角色图", tree: { "": 3, a: 5, "a/b": 2 } });
//   await library.install(page);
//   source.directories.a // 目录 id
//
// `tree` 的键是相对路径（"" 是根目录），值是这一层的图片张数；图片名 `<文件夹名>-001.png`。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { errorEnvelope, mockApi } from "./api";
import { PIXEL_PNG } from "./datasets";

type Schemas = components["schemas"];
type Source = Schemas["GallerySourceResponse"];
type Directory = Schemas["GalleryDirectoryEntryResponse"];
type Asset = Schemas["GalleryAssetEntryResponse"];

const TIME = 1_760_000_000;

interface FakeAnnotation {
  content: string | null;
  txt_version: number;
  disk_version: string;
}

interface FakeOperation {
  readonly operation_id: string;
  readonly created_at: number;
  readonly asset_ids: readonly string[];
  readonly txt_paths: readonly string[];
  state: "trashed" | "restored" | "purged";
}

export interface FakeSourceInit {
  readonly name: string;
  readonly tree?: Readonly<Record<string, number>>;
  readonly availability?: Source["availability"];
  readonly kind?: Source["kind"];
  readonly lastScannedAt?: number | null;
}

export interface FakeSourceHandle {
  readonly sourceId: string;
  readonly rootId: string;
  /** 相对路径 → 目录 id。 */
  readonly directories: Readonly<Record<string, string>>;
}

function segment(request: Request, index: number): string {
  return decodeURIComponent(new URL(request.url()).pathname.split("/")[index] ?? "");
}

const notFound = (what: string) => ({ status: 404, body: errorEnvelope(`${what}_not_found`, "不存在") });

export class FakeLibrary {
  readonly sources = new Map<string, Source>();
  readonly directories = new Map<string, Directory>();
  readonly assets = new Map<string, Asset>();
  readonly annotations = new Map<string, FakeAnnotation>();
  readonly operations: FakeOperation[] = [];
  /** 收到的写请求（按顺序），用例里可以检查。 */
  readonly writes: { readonly method: string; readonly path: string; readonly body: unknown }[] = [];
  private sequence = 0;

  addSource(init: FakeSourceInit): FakeSourceHandle {
    const sourceId = `src${++this.sequence}`;
    const tree = init.tree ?? { "": 0 };
    const paths = Object.keys(tree).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    if (!paths.includes("")) paths.unshift("");
    const ids: Record<string, string> = {};
    for (const path of paths) {
      const id = `${sourceId}-d${++this.sequence}`;
      ids[path] = id;
      const parent = path === "" ? null : (ids[path.split("/").slice(0, -1).join("/")] ?? null);
      const name = path === "" ? init.name : path.split("/").at(-1)!;
      this.directories.set(id, {
        directory_id: id,
        source_id: sourceId,
        parent_id: parent,
        name,
        relative_path: path,
        cover_asset_ids: [],
        direct_asset_count: 0,
        direct_directory_count: 0,
        recursive_asset_count: 0,
        indexed_version: 1,
      });
      const folder = path === "" ? "root" : name;
      for (let index = 0; index < (tree[path] ?? 0); index += 1) {
        const file = `${folder}-${String(index + 1).padStart(3, "0")}`;
        const assetId = `${id}-a${String(index + 1).padStart(3, "0")}`;
        this.assets.set(assetId, {
          asset_id: assetId,
          source_id: sourceId,
          directory_id: id,
          name: `${file}.png`,
          extension: ".png",
          format: "png",
          relative_path: path ? `${path}/${file}.png` : `${file}.png`,
          width: 832,
          height: 1216,
          size_bytes: 120_000,
          content_sha256: assetId.padEnd(64, "0").slice(0, 64),
          content_version: 1,
          modified_ns: 0,
          lifecycle_state: "active",
          read_state: "ok",
          error_code: "",
          dedup_visibility: "kept",
          txt_state: "normal",
          txt_relative_path: path ? `${path}/${file}.txt` : `${file}.txt`,
          txt_size_bytes: 10,
          txt_modified_ns: 0,
          txt_version: 1,
          updated_at: TIME,
        });
        this.annotations.set(assetId, { content: `1girl, ${file}`, txt_version: 1, disk_version: "v1" });
      }
    }
    this.sources.set(sourceId, {
      source_id: sourceId,
      display_name: init.name,
      kind: init.kind ?? "imported",
      availability: init.availability ?? "available",
      root_directory_id: ids[""]!,
      batch_id: null,
      asset_count: 0,
      kept_count: 0,
      removed_count: 0,
      candidate_count: 0,
      last_scanned_at: init.lastScannedAt === undefined ? TIME : init.lastScannedAt,
      created_at: TIME,
      updated_at: TIME,
      content_version: 1,
      annotation_version: 1,
      indexed_version: 1,
      crawl_complete: true,
      dedup_applied_version: 0,
      dedup_required: false,
      dedup_state: "not_required",
      reconciliation_attempt_count: 0,
      reconciliation_error_code: "",
      reconciliation_state: "none",
      reconciliation_updated_at: null,
    });
    return { sourceId, rootId: ids[""]!, directories: ids };
  }

  /** 某个目录下（含子目录）的全部目录 id。 */
  private subtree(directoryId: string): Set<string> {
    const ids = new Set([directoryId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const directory of this.directories.values()) {
        if (directory.parent_id && ids.has(directory.parent_id) && !ids.has(directory.directory_id)) {
          ids.add(directory.directory_id);
          grew = true;
        }
      }
    }
    return ids;
  }

  private active(filter: (asset: Asset) => boolean): Asset[] {
    return [...this.assets.values()].filter((asset) => asset.lifecycle_state === "active" && filter(asset));
  }

  source(id: string): Source {
    const source = this.sources.get(id)!;
    const count = this.active((asset) => asset.source_id === id).length;
    return { ...source, asset_count: count, kept_count: count };
  }

  directory(id: string): Directory {
    const directory = this.directories.get(id)!;
    const subtree = this.subtree(id);
    return {
      ...directory,
      direct_asset_count: this.active((asset) => asset.directory_id === id).length,
      direct_directory_count: [...this.directories.values()].filter((item) => item.parent_id === id).length,
      recursive_asset_count: this.active((asset) => subtree.has(asset.directory_id ?? "")).length,
    };
  }

  /** 当前在回收区里的操作。 */
  trashed(): FakeOperation[] {
    return this.operations.filter((operation) => operation.state === "trashed");
  }

  private setLifecycle(ids: readonly string[], state: Asset["lifecycle_state"]) {
    for (const id of ids) {
      const asset = this.assets.get(id);
      if (asset) this.assets.set(id, { ...asset, lifecycle_state: state });
    }
  }

  private record(request: Request) {
    const body = request.postData() ? request.postDataJSON() : null;
    this.writes.push({ method: request.method(), path: new URL(request.url()).pathname + new URL(request.url()).search, body });
    return body;
  }

  private page<T>(items: readonly T[], request: Request, cursorName: string): { items: T[]; next: string | null; limit: number } {
    const params = new URL(request.url()).searchParams;
    const offset = Number(params.get(cursorName) ?? 0);
    const limit = Number(params.get("limit") ?? 100);
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return { items: items.slice(offset, offset + limit), next, limit };
  }

  /** 注册全部图库接口；在 `page.goto()` 之前调用。数据集接口另用 FakeDatasets。 */
  async install(page: Page): Promise<void> {
    await page.route(
      (url) => /^\/api\/v1\/gallery\/assets\/[^/]+\/(?:thumbnail|content)$/.test(url.pathname),
      (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
    );

    await mockApi(page, "get", "/api/v1/gallery/sources", () => ({
      body: { sources: [...this.sources.keys()].map((id) => this.source(id)) },
    }));
    await mockApi(page, "get", "/api/v1/gallery/sources/{source_id}", (request) => {
      const id = segment(request, 5);
      return this.sources.has(id) ? { body: this.source(id) } : notFound("source");
    });
    await mockApi(page, "post", "/api/v1/gallery/imports", (request) => {
      const body = this.record(request) as Schemas["GalleryImportRequest"];
      const name = body.display_name || body.root_path.split("/").filter(Boolean).at(-1) || body.root_path;
      const handle = this.addSource({ name, tree: { "": 2 }, lastScannedAt: null });
      return { status: 201, body: this.source(handle.sourceId) };
    });
    await mockApi(page, "post", "/api/v1/gallery/sources/{source_id}/scan", (request) => {
      const id = segment(request, 5);
      this.record(request);
      if (!this.sources.has(id)) return notFound("source");
      return {
        status: 202,
        body: { source_id: id, operation_id: `scan-${id}`, state: "running" as const, started_at: TIME, finished_at: null, error_code: "" as const, stats: null },
      };
    });
    await mockApi(page, "post", "/api/v1/gallery/sources/{source_id}/relink", (request) => {
      const id = segment(request, 5);
      this.record(request);
      const source = this.sources.get(id);
      if (!source) return notFound("source");
      this.sources.set(id, { ...source, availability: "available" });
      return { body: this.source(id) };
    });
    await mockApi(page, "delete", "/api/v1/gallery/sources/{source_id}", (request) => {
      const id = segment(request, 5);
      this.record(request);
      if (!this.sources.delete(id)) return notFound("source");
      return { body: { source_id: id, removed: true as const } };
    });

    await mockApi(page, "get", "/api/v1/gallery/directories/{directory_id}/entries", (request) => {
      const id = segment(request, 5);
      if (!this.directories.has(id)) return notFound("directory");
      const params = new URL(request.url()).searchParams;
      const scope = params.get("include_descendants") === "true" ? this.subtree(id) : new Set([id]);
      const children = [...this.directories.values()]
        .filter((directory) => directory.parent_id === id)
        .map((directory) => this.directory(directory.directory_id));
      const directories = this.page(children, request, "directory_cursor");
      const assets = this.page(this.active((asset) => scope.has(asset.directory_id ?? "")), request, "asset_cursor");
      return {
        body: {
          directory: this.directory(id),
          directories: directories.items,
          assets: assets.items,
          directory_cursor: directories.next,
          asset_cursor: assets.next,
          include_descendants: scope.size > 1,
          limit: assets.limit,
        },
      };
    });
    await mockApi(page, "get", "/api/v1/gallery/directories/{directory_id}/ancestors", (request) => {
      const id = segment(request, 5);
      const directory = this.directories.get(id);
      if (!directory) return notFound("directory");
      const ancestors: Schemas["GalleryDirectoryAncestorResponse"][] = [];
      for (let parent = this.directories.get(directory.parent_id ?? ""); parent; parent = this.directories.get(parent.parent_id ?? "")) {
        ancestors.unshift({ directory_id: parent.directory_id, name: parent.name });
      }
      return { body: { directory_id: id, ancestors } };
    });
    await mockApi(page, "get", "/api/v1/gallery/search", (request) => {
      const params = new URL(request.url()).searchParams;
      const query = (params.get("query") ?? "").toLowerCase();
      const scope = params.get("scope") as Schemas["GallerySearchPageResponse"]["scope"];
      const directories = scope === "directory" ? this.subtree(params.get("directory_id") ?? "") : null;
      const matches = this.active(
        (asset) =>
          asset.name.toLowerCase().includes(query) &&
          (scope !== "source" || asset.source_id === params.get("source_id")) &&
          (directories === null || directories.has(asset.directory_id ?? "")),
      );
      const page = this.page(matches, request, "asset_cursor");
      return { body: { assets: page.items, asset_cursor: page.next, limit: page.limit, scope } };
    });

    await mockApi(page, "post", "/api/v1/gallery/file-operations/trash", (request) => {
      const body = this.record(request) as Schemas["GalleryTrashRequest"];
      const ids = [...new Set(body.asset_ids ?? [])];
      if (ids.some((id) => !this.assets.has(id))) return notFound("asset");
      if (ids.some((id) => this.assets.get(id)!.lifecycle_state !== "active")) {
        return { status: 409, body: errorEnvelope("asset_not_active", "图片当前不在来源中") };
      }
      const txtPaths = ids.flatMap((id) => {
        const asset = this.assets.get(id)!;
        return asset.txt_relative_path && asset.txt_state !== "missing" && asset.txt_state !== "pair_conflict"
          ? [asset.txt_relative_path]
          : [];
      });
      const operation: FakeOperation = { operation_id: `op${++this.sequence}`, created_at: TIME, asset_ids: ids, txt_paths: txtPaths, state: "trashed" };
      this.operations.push(operation);
      this.setLifecycle(ids, "trashed");
      return { body: { operation_id: operation.operation_id, kind: "trash" as const, item_count: ids.length, has_txt_count: operation.txt_paths.length, status: "committed" as const } };
    });
    const restore = (request: Request, index: number) => {
      this.record(request);
      const operation = this.operations.find((item) => item.operation_id === segment(request, index));
      if (!operation || operation.state !== "trashed") return { status: 409, body: errorEnvelope("trash_operation_not_found", "操作不存在") };
      operation.state = "restored";
      this.setLifecycle(operation.asset_ids, "active");
      const count = operation.asset_ids.length;
      return { body: { operation_id: `op${++this.sequence}`, kind: "restore" as const, item_count: count, has_txt_count: operation.txt_paths.length, status: "committed" as const } };
    };
    await mockApi(page, "post", "/api/v1/gallery/file-operations/{operation_id}/undo", (request) => restore(request, 5));
    await mockApi(page, "post", "/api/v1/gallery/trash/{operation_id}/restore", (request) => restore(request, 5));
    await mockApi(page, "get", "/api/v1/gallery/trash", () => ({
      body: {
        operations: this.trashed()
          .reverse()
          .map((operation) => ({
            operation_id: operation.operation_id,
            created_at: operation.created_at,
            item_count: operation.asset_ids.length,
            has_txt_count: operation.txt_paths.length,
            disk_usage_bytes: operation.asset_ids.length * 120_000,
            item_error_count: 0,
          })),
        next_cursor: null,
      },
    }));
    await mockApi(page, "delete", "/api/v1/gallery/trash/{operation_id}", (request) => {
      this.record(request);
      const operation = this.trashed().find((item) => item.operation_id === segment(request, 5));
      if (!operation) return { status: 409, body: errorEnvelope("trash_operation_not_found", "操作不存在") };
      operation.state = "purged";
      const count = operation.asset_ids.length;
      return { body: { operation_id: operation.operation_id, kind: "purge" as const, item_count: count, has_txt_count: operation.txt_paths.length, status: "committed" as const } };
    });
    await mockApi(page, "delete", "/api/v1/gallery/trash", (request) => {
      this.record(request);
      const operations = this.trashed();
      for (const operation of operations) operation.state = "purged";
      return {
        body: { purged_operations: operations.length, purged_items: operations.reduce((sum, item) => sum + item.asset_ids.length, 0) },
      };
    });

    await mockApi(page, "post", "/api/v1/gallery/assets/{asset_id}/rename", (request) => {
      const id = segment(request, 5);
      const body = this.record(request) as Schemas["GalleryRenameRequest"];
      const asset = this.assets.get(id);
      if (!asset) return notFound("asset");
      const name = `${body.new_stem}${asset.extension}`;
      const parent = asset.relative_path.split("/").slice(0, -1).join("/");
      this.assets.set(id, { ...asset, name, relative_path: parent ? `${parent}/${name}` : name });
      return { body: { operation_id: `op${++this.sequence}`, kind: "rename" as const, item_count: 1, has_txt_count: 1, status: "committed" as const } };
    });
    await mockApi(page, "get", "/api/v1/gallery/assets/{asset_id}/annotation", (request) => {
      const id = segment(request, 5);
      const annotation = this.annotations.get(id);
      const asset = this.assets.get(id);
      if (!annotation || !asset) return notFound("asset");
      return { body: { asset_id: id, ...annotation, txt_state: annotation.content === null ? ("missing" as const) : asset.txt_state } };
    });
    await mockApi(page, "put", "/api/v1/gallery/assets/{asset_id}/annotation", (request) => {
      const id = segment(request, 5);
      const body = this.record(request) as Schemas["GalleryAnnotationPutRequest"];
      const annotation = this.annotations.get(id);
      if (!annotation) return notFound("asset");
      if (body.expected_txt_version !== annotation.txt_version || body.expected_disk_version !== annotation.disk_version) {
        return { status: 409, body: errorEnvelope("txt_version_conflict", "版本不符") };
      }
      annotation.content = body.content;
      annotation.txt_version += 1;
      annotation.disk_version = `v${annotation.txt_version}`;
      return { body: { asset_id: id, ...annotation, txt_state: "normal" as const } };
    });
  }
}
