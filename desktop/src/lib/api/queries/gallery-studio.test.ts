import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import type { components } from "../schema";
import { undoCaptionBatch, type CaptionOpsRequest } from "./captions.ts";
import {
  cacheGalleryCaptionEdit,
  dropGalleryCaption,
  editGalleryCaption,
  galleryCaptionBatchesQuery,
  galleryCaptionOps,
  galleryCaptionsQuery,
  galleryKeptQuery,
  saveGalleryKept,
} from "./gallery-studio.ts";
import { invalidateLibrary, trashItems, undoOperation } from "./library.ts";

const a = { asset_id: "a", name: "a.png", state: "normal", text: "hat", tags: ["hat"], version: "v1" } as const;
const b = { asset_id: "b", name: "b.png", state: "missing", text: "", tags: [], version: "missing" } as const;
const list = (source_id: string, items: components["schemas"]["CaptionItem"][], etag = '"v1"') => ({ source_id, trigger_word: "", items, etag });
const assetA = { ...a, tags: [...a.tags] };
const assetB = { ...b, tags: [...b.tags] };

interface Call {
  method: string;
  url: URL;
  body: unknown;
  ifNoneMatch: string | null;
}

function fixture(reply: (call: Call) => { body?: unknown; status?: number }) {
  const calls: Call[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      const call = { method: request.method, url, body: text ? JSON.parse(text) : null, ifNoneMatch: request.headers.get("If-None-Match") };
      calls.push(call);
      const { body, status = 200 } = reply(call);
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { api, calls, client };
}

const sourcePath = "/api/v1/gallery/sources/source";

describe("gallery studio queries", () => {
  it("caches source and subtree captions independently and reuses the matching scope’s ETag", async () => {
    const { api, client, calls } = fixture(({ url, ifNoneMatch }) => {
      if (ifNoneMatch) return { status: 304 };
      return { body: url.searchParams.has("directory_id") ? list("source", [assetA], '"subtree"') : list("source", [assetA, assetB]) };
    });
    const source = galleryCaptionsQuery(api, "source", null);
    const folder = galleryCaptionsQuery(api, "source", "nested/id");
    const all = await client.fetchQuery(source);
    const nested = await client.fetchQuery(folder);
    expect(all.items.map((item) => item.asset_id)).toEqual(["a", "b"]);
    expect(nested.items.map((item) => item.asset_id)).toEqual(["a"]);
    await expect(client.fetchQuery(folder)).resolves.toBe(nested);
    expect(calls.map(({ url, ifNoneMatch }) => [url.pathname, url.searchParams.get("directory_id"), ifNoneMatch])).toEqual([
      [`${sourcePath}/captions`, null, null],
      [`${sourcePath}/captions`, "nested/id", null],
      [`${sourcePath}/captions`, "nested/id", '"subtree"'],
    ]);
  });

  it("keeps the last persisted review state on a failed save and updates it on success", async () => {
    let fail = true;
    const { api, calls, client } = fixture(({ method }) => {
      if (method === "GET") return { body: { asset_ids: ["b"] } };
      return fail ? { status: 409, body: { error: { code: "simulated_conflict" } } } : { body: { updated: 1 } };
    });
    const query = galleryKeptQuery(api, "source");
    await client.fetchQuery(query);
    await expect(saveGalleryKept(api, client, "source", ["a"], true)).rejects.toMatchObject({ status: 409 });
    expect(client.getQueryData(query.queryKey)).toEqual(new Set(["b"]));
    fail = false;
    await saveGalleryKept(api, client, "source", ["a"], true);
    expect(client.getQueryData(query.queryKey)).toEqual(new Set(["a", "b"]));
    expect(calls.map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
      ["GET", `${sourcePath}/kept`, null],
      ["PUT", `${sourcePath}/kept`, { asset_ids: ["a"], kept: true }],
      ["PUT", `${sourcePath}/kept`, { asset_ids: ["a"], kept: true }],
    ]);
  });

  it("updates shared captions for cached subtrees after a versioned edit without touching other sources", async () => {
    const edited = { ...assetA, text: "hat, sky", tags: ["hat", "sky"], version: "v2" };
    const { api, calls, client } = fixture(() => ({ body: { caption: edited, batch_id: "edit-id" } }));
    const all = galleryCaptionsQuery(api, "source", null);
    const folder = galleryCaptionsQuery(api, "source", "subtree");
    const other = galleryCaptionsQuery(api, "other", null);
    client.setQueryData(all.queryKey, list("source", [assetA, assetB]));
    client.setQueryData(folder.queryKey, list("source", [assetA]));
    client.setQueryData(other.queryKey, list("other", [assetB]));
    const response = await editGalleryCaption(api, "source", "a", { text: edited.text, expected_version: "v1" });
    await cacheGalleryCaptionEdit(client, "source", response);
    expect(calls[0]).toMatchObject({ method: "PUT", url: { pathname: `${sourcePath}/captions/a` }, body: { text: edited.text, expected_version: "v1" } });
    expect(client.getQueryData(all.queryKey)).toMatchObject({ etag: "", items: [edited, assetB] });
    expect(client.getQueryData(folder.queryKey)?.items).toEqual([edited]);
    expect(client.getQueryData(other.queryKey)?.items).toEqual([assetB]);
  });

  it("previews and applies the same explicit scope, then fetches history and undoes the exact batch", async () => {
    const { api, client, calls } = fixture(({ method }) => ({ body: method === "GET" ? { items: [{ batch_id: "batch-1" }] } : {} }));
    const operation = { asset_ids: ["a"], expected_versions: { a: "v1" }, ops: [{ op: "remove", tags: ["hat"] }] } satisfies CaptionOpsRequest;
    await galleryCaptionOps(api, "source", { ...operation, dry_run: true, sample_limit: 6 });
    await galleryCaptionOps(api, "source", { ...operation, dry_run: false, sample_limit: 0 });
    const history = await client.fetchQuery(galleryCaptionBatchesQuery(api, "source"));
    await undoCaptionBatch(api, history[0]!.batch_id);
    expect(calls.map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
      ["POST", `${sourcePath}/captions/ops`, { ...operation, dry_run: true, sample_limit: 6 }],
      ["POST", `${sourcePath}/captions/ops`, { ...operation, dry_run: false, sample_limit: 0 }],
      ["GET", `${sourcePath}/caption-batches`, null],
      ["POST", "/api/v1/caption-batches/batch-1/undo", null],
    ]);
  });

  it("uses reversible gallery trash and restores the same operation; trash invalidates cached browsing data", async () => {
    const { api, client, calls } = fixture(() => ({ body: { operation_id: "op-123", has_txt_count: 1, item_count: 1, status: "committed" } }));
    const all = galleryCaptionsQuery(api, "source", null);
    const folder = galleryCaptionsQuery(api, "source", "subtree");
    client.setQueryData(all.queryKey, list("source", [assetA, assetB]));
    client.setQueryData(folder.queryKey, list("source", [assetA]));
    client.setQueryData(["library", "trash"], []);
    const operation = await trashItems(api, { asset_ids: ["a"] });
    await dropGalleryCaption(client, "source", "a");
    await invalidateLibrary(client);
    expect(client.getQueryData(all.queryKey)?.items).toEqual([assetB]);
    expect(client.getQueryData(folder.queryKey)?.items).toEqual([]);
    expect(client.getQueryState(["library", "trash"])?.isInvalidated).toBe(true);
    await undoOperation(api, operation.operation_id);
    expect(calls.map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
      ["POST", "/api/v1/gallery/file-operations/trash", { asset_ids: ["a"] }],
      ["POST", "/api/v1/gallery/file-operations/op-123/undo", null],
    ]);
  });
});
