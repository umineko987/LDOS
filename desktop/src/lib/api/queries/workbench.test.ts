import { describe, expect, it, vi } from "vitest";

import { createApi } from "../client.ts";
import { ApiError } from "../errors.ts";
import type { operations } from "../schema";
import { browseWorkbench, collectWorkbench } from "./workbench.ts";

type Browse = operations["browse_workbench"];
type BrowseBody = Browse["requestBody"]["content"]["application/json"];
type BrowseResult = Browse["responses"][200]["content"]["application/json"];
type Collect = operations["collect_workbench"];
type CollectResult = Collect["responses"][200]["content"]["application/json"];
type ErrorBody = Collect["responses"]["default"]["content"]["application/json"];

const origin = "http://127.0.0.1:8787";
const datasetId = "fixture/dataset";
const workbenchPath = `/api/v1/datasets/${encodeURIComponent(datasetId)}/workbench`;
const galleryUrl = "https://e-hentai.org/g/12/aabbccddee/";

function mockApi(...responses: Response[]) {
  const fetchImpl = vi.fn<(request: Request) => Promise<Response>>();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return { api: createApi(origin, { fetchImpl }), fetchImpl };
}

function gallerySnapshot(snapshot_id: string, limit: number): BrowseResult {
  return {
    snapshot_id,
    items: Array.from({ length: limit }, (_, index) => {
      const page = index + 1;
      return {
        id: String(page), title: `Synthetic page ${page}`, page, media_count: 1,
        preview_url: `${workbenchPath}/media/${snapshot_id}/${page}`,
      };
    }),
    has_more: true,
    total: 90,
  };
}

function errorResponse(status: number, code: string, message: string) {
  const body = { error: { code, message, details: null, request_id: "fixture-request" } } satisfies ErrorBody;
  return Response.json(body, { status });
}

const sources = [
  { site: "pixiv", url: "https://www.pixiv.net/users/42/artworks", limit: 1000 },
  { site: "twitter", url: "https://x.com/fixture_artist/media", limit: 1000 },
  { site: "exhentai", url: galleryUrl, limit: 500 },
] satisfies BrowseBody[];

const collectAttempt = {
  site: "exhentai",
  snapshotId: "fixture-snapshot",
  ids: ["12"],
  key: "workbench-fixture-collect",
} as const;

const batch = { batch_id: "fixture-batch" } satisfies CollectResult;

async function expectRequest(request: Request, operation: "browse" | "collect", body: BrowseBody | Collect["requestBody"]["content"]["application/json"]) {
  expect(request.method).toBe("POST");
  expect(request.url).toBe(`${origin}${workbenchPath}/${operation}`);
  expect(request.headers.get("Content-Type")).toBe("application/json");
  expect(await request.json()).toEqual(body);
}

describe("collection workbench client contract", () => {
  it.each(sources)("browses $site through the dataset API and resolves the local preview path", async (body) => {
    const response = {
      snapshot_id: "fixture-snapshot",
      items: [{ id: "1", title: "Synthetic item", media_count: 1, preview_url: `${workbenchPath}/media/fixture-snapshot/1` }],
      has_more: false,
    } satisfies BrowseResult;
    const { api, fetchImpl } = mockApi(Response.json(response));

    const preview = await browseWorkbench(api, datasetId, body.site, body.url, body.limit);

    expect(preview).toEqual(response);
    expect(api.resourceUrl(preview.items[0]!.preview_url)).toBe(`${origin}${workbenchPath}/media/fixture-snapshot/1`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expectRequest(fetchImpl.mock.calls[0]![0], "browse", body);
  });

  it("submits EH pages 12–38 except 17 against the expanded snapshot and reuses the key on retry", async () => {
    const first = gallerySnapshot("fixture-initial", 40);
    const expanded = gallerySnapshot("fixture-expanded", 64);
    const { api, fetchImpl } = mockApi(
      Response.json(first),
      Response.json(expanded),
      errorResponse(504, "request_timeout", "Synthetic timeout"),
      Response.json(batch),
    );
    const initial = await browseWorkbench(api, datasetId, "exhentai", galleryUrl, 40);
    expect(initial).toEqual(first);
    const refreshed = await browseWorkbench(api, datasetId, "exhentai", galleryUrl, 64);
    expect(refreshed).toEqual(expanded);
    const ids = Array.from({ length: 27 }, (_, index) => String(index + 12)).filter((id) => id !== "17");
    const attempt = { ...collectAttempt, snapshotId: refreshed.snapshot_id, ids };

    await expect(collectWorkbench(api, datasetId, attempt)).rejects.toMatchObject({ status: 504, code: "request_timeout" });
    await expect(collectWorkbench(api, datasetId, attempt)).resolves.toEqual(batch);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await expectRequest(fetchImpl.mock.calls[0]![0], "browse", { site: "exhentai", url: galleryUrl, limit: 40 });
    await expectRequest(fetchImpl.mock.calls[1]![0], "browse", { site: "exhentai", url: galleryUrl, limit: 64 });
    for (const [request] of fetchImpl.mock.calls.slice(2)) {
      expect(request.headers.get("Idempotency-Key")).toBe(attempt.key);
      await expectRequest(request, "collect", { snapshot_id: "fixture-expanded", ids });
    }
  });

  it("exposes validation failures from browse as ApiError", async () => {
    const { api } = mockApi(errorResponse(422, "invalid_workbench_limit", "Synthetic validation error"));

    await expect(browseWorkbench(api, datasetId, "exhentai", galleryUrl, 501)).rejects.toEqual(
      expect.objectContaining({ name: "ApiError", status: 422, code: "invalid_workbench_limit", requestId: "fixture-request" }),
    );
  });

  it.each([
    [410, "workbench_snapshot_expired"],
    [409, "workbench_idempotency_conflict"],
  ])("preserves collect error %i (%s) for callers", async (status, code) => {
    const { api } = mockApi(errorResponse(status, code, "Synthetic collect error"));
    const result = collectWorkbench(api, datasetId, collectAttempt);

    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status, code, message: "Synthetic collect error", requestId: "fixture-request" });
  });
});
