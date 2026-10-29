// 语义地图页的模拟数据：三个簇加一张离群图，前 8 张有缩略图（两张 128² 的雪碧图，每张 2×2 格）。
// 雪碧图和缩略图是现编的纯色 PNG，像素测试按颜色认它们。

import { deflateSync } from "node:zlib";
import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";

type AtlasResponse = components["schemas"]["AtlasResponse"];
type AtlasItem = components["schemas"]["AtlasItem"];
type AtlasStateResponse = components["schemas"]["AtlasStateResponse"];

export const ATLAS_DATASET = "d1";
export const ATLAS_RUN = "1760000000000-0123abcd";
/** 雪碧图的颜色：和簇调色板、金色、红色都差得很远。 */
export const SPRITE_RGB = [20, 200, 120] as const;

interface ClusterSpec {
  readonly id: number;
  readonly prefix: string;
  readonly center: readonly [number, number];
  readonly count: number;
}

export const ATLAS_CLUSTERS: readonly ClusterSpec[] = [
  { id: 0, prefix: "a", center: [-0.5, -0.4], count: 12 },
  { id: 1, prefix: "b", center: [0.5, -0.3], count: 6 },
  { id: 2, prefix: "c", center: [0, 0.55], count: 4 },
];

export const OUTLIER = { asset_id: "o1", x: 0.85, y: 0.8, cluster: 1 } as const;

/** 每簇的点排成一圈，半径 0.06：彼此分得开，又都在簇中心 ±0.1 以内。 */
function clusterItems(spec: ClusterSpec): AtlasItem[] {
  return Array.from({ length: spec.count }, (_, index) => {
    const angle = (index / spec.count) * Math.PI * 2;
    return {
      asset_id: `${spec.prefix}${index}`,
      x: spec.center[0] + Math.cos(angle) * 0.06,
      y: spec.center[1] + Math.sin(angle) * 0.06,
      cluster: spec.id,
      outlier: 0.1,
      sha256: null,
      sprite: null,
    };
  });
}

export function atlasItems(): AtlasItem[] {
  const items = [
    ...ATLAS_CLUSTERS.flatMap(clusterItems),
    { ...OUTLIER, outlier: 0.97, sha256: null, sprite: null },
  ];
  // 前 8 张（都在簇 0）有缩略图：雪碧图 0、1，各 4 格。
  return items.map((item, index) => (index < 8 ? { ...item, sprite: [Math.floor(index / 4), index % 4] } : item));
}

export function itemPosition(assetId: string): readonly [number, number] {
  const item = atlasItems().find((entry) => entry.asset_id === assetId);
  if (!item) throw new Error(`no atlas item ${assetId}`);
  return [item.x, item.y];
}

export function clusterIds(cluster: number): string[] {
  return atlasItems()
    .filter((item) => item.cluster === cluster && item.asset_id !== OUTLIER.asset_id)
    .map((item) => item.asset_id);
}

function vectors(items: readonly AtlasItem[]): NonNullable<AtlasResponse["vectors"]> {
  const bytes = Buffer.alloc(items.length * 2);
  items.forEach((item, row) => {
    bytes.writeInt8(Math.round(item.x * 100), row * 2);
    bytes.writeInt8(Math.round(item.y * 100), row * 2 + 1);
  });
  return { dims: 2, dtype: "int8", encoding: "base64", order: "items", scales: [0.01, 0.01], data: bytes.toString("base64") };
}

export function readyAtlas({ removed = [] as readonly string[] } = {}): AtlasResponse {
  const items = atlasItems();
  const live = items.filter((item) => !removed.includes(item.asset_id));
  const clusters = ATLAS_CLUSTERS.map((spec) => {
    const size = items.filter((item) => item.cluster === spec.id).length;
    const liveSize = live.filter((item) => item.cluster === spec.id).length;
    return {
      id: spec.id,
      size,
      share: size / items.length,
      medoid_asset_id: `${spec.prefix}0`,
      x: spec.center[0],
      y: spec.center[1],
      live_size: liveSize,
      live_share: live.length ? liveSize / live.length : 0,
    };
  });
  return {
    dataset_id: ATLAS_DATASET,
    status: "ready",
    availability: { available: true, reason: "" },
    cached: false,
    stale: false,
    current_digest: "digest",
    delta: { added: 0, changed: 0, removed_asset_ids: [...removed] },
    run: { run_id: ATLAS_RUN, method: "DINOv2 → PCA → t-SNE → k-means", options: {}, params: {}, counts: {} },
    items,
    clusters,
    hints: {
      share_threshold: 0.08,
      outlier_threshold: 0.9,
      over_represented: [{ cluster: 0, share: clusters[0]!.live_share, size: clusters[0]!.live_size }],
      outliers: [OUTLIER.asset_id],
    },
    sprites: {
      format: "png",
      sheet_size: 128,
      cell_size: 64,
      columns: 2,
      per_sheet: 4,
      urls: [0, 1].map((sheet) => `/api/v1/datasets/${ATLAS_DATASET}/atlas/sprites/${sheet}?run=${ATLAS_RUN}`),
    },
    vectors: vectors(items),
  };
}

export function runningAtlas(): AtlasResponse {
  return {
    dataset_id: ATLAS_DATASET,
    status: "running",
    availability: { available: true, reason: "" },
    cached: false,
    stale: false,
    current_digest: "digest",
    delta: { added: 0, changed: 0, removed_asset_ids: [] },
    running_run_id: ATLAS_RUN,
    progress: { phase: "embed", label: "计算嵌入", done: 40, total: 160 },
  };
}

export function noAtlas(overrides: Partial<AtlasResponse> = {}): AtlasResponse {
  return {
    dataset_id: ATLAS_DATASET,
    status: "none",
    availability: { available: true, reason: "" },
    cached: false,
    stale: false,
    current_digest: "digest",
    delta: { added: 0, changed: 0, removed_asset_ids: [] },
    ...overrides,
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 纯色 RGB PNG。 */
export function solidPng(size: number, [r, g, b]: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 真彩色
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 雪碧图和悬停缩略图。 */
export async function mockAtlasImages(page: Page): Promise<void> {
  const sheet = solidPng(128, SPRITE_RGB);
  const thumbnail = solidPng(16, [120, 120, 120]);
  await page.route(/\/api\/v1\/datasets\/[^/]+\/atlas\/sprites\/\d+/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: sheet }),
  );
  await page.route(/\/api\/v1\/gallery\/assets\/[^/]+\/thumbnail/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: thumbnail }),
  );
}

/**
 * POST atlas/run 成功时是 202，api.ts 的 mockApi 只按 200/201 推正文类型，所以这里单独模拟。
 */
export async function mockAtlasRun(page: Page, reply: (request: Request) => AtlasStateResponse): Promise<void> {
  await page.route(
    (url) => /^\/api\/v1\/datasets\/[^/]+\/atlas\/run$/.test(url.pathname),
    (route, request) =>
      request.method() === "POST"
        ? route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(reply(request)) })
        : route.fallback(),
  );
}

/** 页面脚本运行前指定渲染器（和设置里的“渲染器”同一个本机存储键）。 */
export async function forceRenderer(page: Page, renderer: "canvas2d" | "webgl2"): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("ldos.renderer", value), renderer);
}
