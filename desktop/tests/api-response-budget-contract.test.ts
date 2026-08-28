import { describe, expect, it } from "vitest";

import crawlServiceSource from "../src/apps/crawl/service.ts?raw";
import diagnosticsServiceSource from "../src/apps/diagnostics/service.ts?raw";
import galleryServiceSource from "../src/apps/gallery/service.ts?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import personalizationServiceSource from "../src/apps/personalization/service.ts?raw";
import personalizationSource from "../src/apps/personalization/Personalization.svelte?raw";
import policyServiceSource from "../src/apps/policy/service.ts?raw";
import proxyServiceSource from "../src/apps/proxy/service.ts?raw";
import reviewServiceSource from "../src/apps/review/service.ts?raw";
import tasksServiceSource from "../src/apps/tasks/service.ts?raw";
import vaultServiceSource from "../src/apps/vault/service.ts?raw";
import { API_MAX_RESPONSE_CHARS } from "../src/core/api/client";

const MIB = 1024 * 1024;

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("desktop API response-budget contract", () => {
  it("keeps a guarded 16 MiB transport ceiling instead of the obsolete 64 KiB parser limit", () => {
    expect(API_MAX_RESPONSE_CHARS).toBe(16 * MIB);
  });

  it("routes every high-volume workspace read through a bounded backend projection", () => {
    const contracts: readonly [string, string, readonly string[]][] = [
      ["gallery", galleryServiceSource, ["sources}?view=desktop", "/entries?", "annotation?view=desktop", "directoryExports}/${endpointId(operationId)}?view=desktop", "const parameters = [\"view=desktop\"]"]],
      ["crawl", crawlServiceSource, ["search}?view=desktop", "crawls}?view=desktop"]],
      ["tasks", tasksServiceSource, [
        "?limit=30&view=desktop",
        "?view=desktop",
        "&view=tasks",
        "/retry?view=desktop",
        `/${"${operation}"}?view=desktop`,
      ]],
      ["review", reviewServiceSource, [
        "limit=${REVIEW_PAGE_LIMIT}&offset=${offset}&view=desktop",
        "/decisions?view=desktop",
        `/${"${operation}"}?view=desktop`,
      ]],
      ["proxy", proxyServiceSource, [
        "status}?view=desktop",
        "sources}?view=desktop",
        "action]}?view=desktop",
        "stop}?view=desktop",
        "probe}?view=desktop",
      ]],
      ["vault", vaultServiceSource, ["view=vault"]],
      ["policy", policyServiceSource, ["view=policy"]],
      ["diagnostics", diagnosticsServiceSource, [
        "/api/v1/config?view=diagnostics",
        "/api/v1/scheduler/status?view=diagnostics",
      ]],
    ];

    for (const [application, source, fragments] of contracts) {
      for (const fragment of fragments) {
        expect(source, `${application} must retain ${fragment}`).toContain(fragment);
      }
    }
  });
  it("fails when an application adds an unclassified transport call", () => {
    const inventory = [
      ["gallery", galleryServiceSource, 23],
      ["crawl", crawlServiceSource, 3],
      ["tasks", tasksServiceSource, 5],
      ["review", reviewServiceSource, 4],
      ["proxy", proxyServiceSource, 11],
      ["vault", vaultServiceSource, 9],
      ["policy", policyServiceSource, 3],
      ["diagnostics", diagnosticsServiceSource, 1],
    ] as const;
    for (const [application, source, expectedCalls] of inventory) {
      expect(count(source, /api\.(?:get|post|put|delete|request)\(/g), application).toBe(expectedCalls);
    }
    expect(count(galleryServiceSource, /view=desktop/g)).toBe(7);
    expect(count(crawlServiceSource, /view=desktop/g)).toBe(2);
    expect(count(tasksServiceSource, /view=(?:desktop|tasks)/g)).toBe(5);
    expect(count(reviewServiceSource, /view=desktop/g)).toBe(4);
    expect(count(proxyServiceSource, /view=desktop/g)).toBe(11);
  });

  it("keeps Personalization local-only and view-layer API-free", () => {
    const localOnlySources = [
      personalizationServiceSource,
      personalizationSource,
    ];
    for (const source of localOnlySources) expect(source).not.toContain("/api/v1/");
    // Gallery 组件不内联 API 路径；所有传输与 URL 构建都收敛在 service.ts。
    expect(gallerySource).not.toContain("/api/v1/");
  });
});
