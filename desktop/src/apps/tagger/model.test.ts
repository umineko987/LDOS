import { assert, expect, test } from "vitest";
import {
  formatBytes,
  normalizeThreshold,
  sanitizeCatalog,
  sanitizeStatus,
} from "./model";
import { createTaggerService, TAGGER_ENDPOINTS } from "./service";

function fakeApi() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push({ method: "GET", path });
      if (path === TAGGER_ENDPOINTS.models) {
        return [{
          key: "wd-vit-v3", repo: "SmilingWolf/wd-vit-tagger-v3", revision: "r1",
          adapter: "wd_onnx", gated: false, license: "open",
          default_thresholds: { general: 0.35, character: 0.85 }, installed: true,
        }, {
          key: "cl-tagger-v2", repo: "cella110n/cl_tagger_v2", revision: "r2",
          adapter: "cl_onnx", gated: true, license: "custom",
          default_thresholds: { general: 0.55 }, installed: false,
        }];
      }
      return {
        phase: "tagging", stage: "inferring", done: 3, total: 10, message: "",
        download: { "wd-vit-v3": { file: "model.onnx", done: 5, total: 9 } },
        last_result: {
          total: 2, per_model: { "wd-vit-v3": { inferred: 2, cache_hits: 0 } },
          decode_errors: [], captions_written: 2, captions_skipped: 0,
        },
        enabled: true,
      };
    },
    async post(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      return { phase: "tagging" };
    },
    resourceUrl: (path: string) => path,
  };
}

test("catalog sanitization keeps entries and flags", () => {
  const catalog = sanitizeCatalog([{
    key: "a", repo: "r", revision: "x", adapter: "wd_onnx",
    gated: true, license: "l", default_thresholds: { general: 0.4 }, installed: false,
  }]);
  expect(catalog.length).toBe(1);
  expect(catalog[0].gated).toBe(true);
  expect(catalog[0].defaultThresholds.general).toBe(0.4);
});

test("catalog rejects non-array payload", () => {
  assert.throws(() => sanitizeCatalog({}), TypeError);
});

test("status sanitization maps fields", () => {
  const status = sanitizeStatus({
    phase: "preparing", stage: "", done: 0, total: 0, message: "m",
    download: { m: { file: "f", done: 1, total: 2 } }, last_result: { total: 1, per_model: {} },
  });
  expect(status.phase).toBe("preparing");
  expect(status.download.m.total).toBe(2);
  expect(status.lastResult?.total).toBe(1);
});

test("status falls back to failed phase on garbage", () => {
  const status = sanitizeStatus({ phase: "nonsense", download: null, last_result: null });
  expect(status.phase).toBe("failed");
  expect(status.download).toEqual({});
  expect(status.lastResult).toBeNull();
});


test("normalizeThreshold empty means model default", () => {
  expect(normalizeThreshold("  ")).toBeNull();
  expect(normalizeThreshold("0.35")).toBe(0.35);
  assert.throws(() => normalizeThreshold("1.5"), TypeError);
});

test("formatBytes renders MB and GB", () => {
  expect(formatBytes(0)).toBe("0 MB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  expect(formatBytes(2.56 * 1024 * 1024 * 1024)).toBe("2.6 GB");
});

test("service run posts the exact payload shape", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  await service.run({
    models: ["wd-vit-v3"], assetIds: ["asset-1"],
    thresholds: { "wd-vit-v3": { general: 0.2 } }, categories: ["general", "character"],
    writeCaptions: true, overwriteCaptions: false,
  }, new AbortController().signal);
  const call = api.calls.find((item) => item.path === TAGGER_ENDPOINTS.run);
  expect(call?.body).toEqual({
    models: ["wd-vit-v3"], asset_ids: ["asset-1"], thresholds: { "wd-vit-v3": { general: 0.2 } },
    categories: ["general", "character"], write_captions: true, overwrite_captions: false,
  });
});

test("service run preserves independent thresholds for multiple models", async () => {
  const api = fakeApi();
  const thresholds = { "wd-vit-v3": { general: 0.4 }, "pixai-tagger-v1": { general: 0.2, style: 0.15 } };
  await createTaggerService(api as never).run({
    models: ["wd-vit-v3", "pixai-tagger-v1"], assetIds: ["asset-1"], thresholds,
    writeCaptions: true, overwriteCaptions: false,
  }, new AbortController().signal);
  expect(api.calls[0].body).toEqual({
    models: ["wd-vit-v3", "pixai-tagger-v1"], asset_ids: ["asset-1"], thresholds,
    write_captions: true, overwrite_captions: false,
  });
});

test("service prepare omits empty token and license flag", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  await service.prepare(["cl-tagger-v2"], new AbortController().signal);
  const call = api.calls.find((item) => item.path === TAGGER_ENDPOINTS.prepare);
  expect(call?.body).toEqual({ models: ["cl-tagger-v2"] });
});

test("service prepare includes token and license only when given", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  await service.prepare(["cl-tagger-v2"], new AbortController().signal, { token: "hf_x", acceptLicense: true });
  const call = api.calls.find((item) => item.path === TAGGER_ENDPOINTS.prepare);
  expect(call?.body).toEqual({ models: ["cl-tagger-v2"], token: "hf_x", accept_license: true });
});

test("service run deduplicates gallery selections and never sends raw paths", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  await service.run({
    models: ["wd-vit-v3"], assetIds: ["asset-1", "asset-2", "asset-1"],
    writeCaptions: true, overwriteCaptions: false,
  }, new AbortController().signal);
  expect(api.calls[0].body).toEqual({
    models: ["wd-vit-v3"], asset_ids: ["asset-1", "asset-2"],
    write_captions: true, overwrite_captions: false,
  });
  await service.run({
    models: ["wd-vit-v3"], assetIds: ["asset-3"], directoryIds: ["dir-1", "dir-2", "dir-1"],
    thresholds: { "wd-vit-v3": { general: 0.2, rating: 0.8 } },
    writeCaptions: true, overwriteCaptions: false,
  }, new AbortController().signal);
  expect(api.calls[1].body).toEqual({
    models: ["wd-vit-v3"], asset_ids: ["asset-3"], directory_ids: ["dir-1", "dir-2"],
    thresholds: { "wd-vit-v3": { general: 0.2, rating: 0.8 } },
    write_captions: true, overwrite_captions: false,
  });
  await service.run({
    models: ["wd-vit-v3"], assetIds: [], directoryIds: ["dir-1"],
    writeCaptions: true, overwriteCaptions: false,
  }, new AbortController().signal);
  expect(api.calls[2].body).toEqual({
    models: ["wd-vit-v3"], directory_ids: ["dir-1"], write_captions: true, overwrite_captions: false,
  });
});

test("service run rejects empty input and oversized or invalid gallery selections", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  const options = { models: ["wd-vit-v3"], assetIds: [], writeCaptions: true, overwriteCaptions: false };
  const signal = new AbortController().signal;
  await expect(service.run(options, signal)).rejects.toThrow("invalid_tagger_inputs");
  await expect(service.run({ ...options, assetIds: Array.from({ length: 201 }, (_, i) => `asset-${i}`) }, signal)).rejects.toThrow("invalid_tagger_assets");
  await expect(service.run({ ...options, directoryIds: Array.from({ length: 201 }, (_, i) => `dir-${i}`) }, signal)).rejects.toThrow("invalid_tagger_directories");
  await expect(service.run({ ...options, directoryIds: [""] }, signal)).rejects.toThrow("invalid_tagger_directories");
  expect(api.calls).toEqual([]);
});

test("service prepare keeps mirror and download proxy separate and omits a blank proxy", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  const signal = new AbortController().signal;
  await service.prepare(["cl-tagger-v2"], signal, {
    token: "hf_x", acceptLicense: true, proxyUrl: "https://mirror.example", downloadProxy: " http://127.0.0.1:7890 ",
  });
  expect(api.calls[0].body).toEqual({
    models: ["cl-tagger-v2"], token: "hf_x", accept_license: true,
    proxy_url: "https://mirror.example", download_proxy: "http://127.0.0.1:7890",
  });
  await service.prepare(["wd-vit-v3"], signal, { downloadProxy: "  " });
  expect(api.calls[1].body).toEqual({ models: ["wd-vit-v3"] });
});

test("service prepare rejects invalid download proxies before making a request", async () => {
  const api = fakeApi();
  const service = createTaggerService(api as never);
  for (const downloadProxy of ["socks5://127.0.0.1:7890", "127.0.0.1:7890", "http://localhost", "http://localhost:7890/path"]) {
    await expect(service.prepare(["wd-vit-v3"], new AbortController().signal, { downloadProxy })).rejects.toThrow("invalid_model_proxy_format");
  }
  expect(api.calls).toEqual([]);
});

test("service prepare forwards the mirror URL", async () => {
  const api = fakeApi();
  await createTaggerService(api as never).prepare(["wd-vit-v3"], new AbortController().signal, { proxyUrl: "https://mirror.example" });
  expect(api.calls[0].body).toEqual({ models: ["wd-vit-v3"], proxy_url: "https://mirror.example" });
});
