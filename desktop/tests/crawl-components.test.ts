import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/core/api/client";
import type { PersistenceService } from "../src/core/persistence/service";
import { sanitizeCrawlSearchResponse } from "../src/apps/crawl/model";
import CandidateRow from "../src/apps/crawl/CandidateRow.svelte";
import Crawl from "../src/apps/crawl/Crawl.svelte";
import Desktop from "../src/shell/Desktop.svelte";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import { createDesktopRuntime } from "./fixtures/desktop";
import candidateSource from "../src/apps/crawl/CandidateRow.svelte?raw";
import controllerSource from "../src/apps/crawl/controller.ts?raw";
import crawlSource from "../src/apps/crawl/Crawl.svelte?raw";
import modelSource from "../src/apps/crawl/model.ts?raw";
import serviceSource from "../src/apps/crawl/service.ts?raw";
import stateSource from "../src/apps/crawl/state.ts?raw";
import thumbnailSource from "../src/apps/crawl/thumbnail.ts?raw";

const crawlCss = readFileSync(new URL("../src/apps/crawl/crawl.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const persistence = Object.freeze({ readActiveBatchId: () => null }) as PersistenceService;
const onNavigate = vi.fn();

describe("Svelte Crawl integration", () => {
  it("renders the Crawl workspace and accessible search and batch controls", () => {
    const body = render(Crawl, { props: { api, persistence, onNavigate } }).body;
    for (const marker of [
      "data-crawl-app",
      'data-domain-owner="crawl"',
      '<h1 id="crawl-heading">采集</h1>',
      "来源与顺序",
      "搜索与候选地址",
      'role="combobox"',
      'aria-controls="crawl-suggestions"',
      'aria-live="polite"',
      "创建批次",
      'aria-label="图片采集工作区"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
    expect(body).not.toContain("P2 Shell");
  });

  it("explains linked-account discovery without promising native X or Pixiv search", () => {
    const body = render(Crawl, { props: { api, persistence, onNavigate } }).body;
    for (const marker of [
      "X / Twitter · Danbooru 画师目录关联账户",
      "Pixiv · Danbooru 画师目录关联账户",
      "Danbooru、EH 与 Pawchive / Pawoo 支持站内搜索",
      "X / Twitter 与 Pixiv 从 Danbooru 画师目录查找关联账户",
      "采集时需要相应授权",
      '<details class="crawl-discovery-note"',
      "来源发现范围",
      'aria-label="启用 X / Twitter · Danbooru 画师目录关联账户"',
      'aria-label="Pixiv · Danbooru 画师目录关联账户 代理覆盖"',
    ]) expect(body).toContain(marker);
    for (const unsupportedClaim of [
      "X / Twitter 站内搜索",
      "Pixiv 站内搜索",
      "X / Twitter 原生搜索",
      "Pixiv 原生搜索",
    ]) expect(body).not.toContain(unsupportedClaim);
  });

  it("mounts Crawl in the Desktop page without a placeholder", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("crawl");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="crawl"');
    expect(body).toContain("data-crawl-app");
    expect(body).not.toContain('data-application-content="crawl"');
    expect(desktopSource).toContain('<Crawl {api} {persistence} onNavigate={navigate} />');
  });

  it("renders only sanitized candidate facts and a stable business key", () => {
    const projection = sanitizeCrawlSearchResponse({ sources: [{
      site: "exhentai",
      status: "succeeded",
      addresses: [{
        id: "gallery-safe",
        label: "安全画廊",
        address_type: "gallery",
        url: "https://e-hentai.org/g/3001/a000000001/?token=never",
        thumbnail_url: "https://ehgt.org/w/safe.webp",
        metadata: { tags: ["artist:safe"] },
      }],
      weak_evidence: [],
    }] });
    const candidate = projection.snapshot.candidates["candidate:exhentai:gallery-safe"];
    const body = render(CandidateRow, {
      props: { candidate, first: true, last: true, onSelected: vi.fn(), onMove: vi.fn() },
    }).body;
    expect(body).toContain('data-candidate-key="candidate:exhentai:gallery-safe"');
    expect(body).toContain("安全画廊");
    expect(body).toContain("访问令牌已隐藏");
    expect(body).toContain("https://ehgt.org/w/safe.webp");
    expect(body).not.toContain("token=never");
    expect(body).not.toContain("e-hentai.org/g/");
  });

  it("keeps keyed projections, output ownership, and all I/O behind shared boundaries", () => {
    expect(crawlSource).toContain("{#each sources as source, index (source.key)}");
    expect(crawlSource).toContain("{#each candidates as candidate, index (candidate.key)}");
    expect(crawlSource).toContain("{#each facet.tags as tag (tag.key)}");
    expect(candidateSource).toContain("data-candidate-key={candidate.key}");
    expect(modelSource).toContain("candidates: Readonly<Record<CrawlCandidateKey, CrawlCandidate>>");
    expect(modelSource).toContain("candidateOrder: Readonly<Record<CrawlSourceKey, readonly CrawlCandidateKey[]>>");
    expect(modelSource).toContain("operations: ReadonlyMap<CrawlCandidateKey, CrawlOperation>");
    expect(controllerSource).toContain("operations.clear()");
    expect(crawlSource).toContain('outputDir = ""');
    expect(crawlSource.match(/createCrawlStore\s*\(/g)).toHaveLength(1);
    expect(serviceSource).toContain("idempotencyKey: true");

    const combined = [crawlSource, candidateSource, controllerSource, serviceSource, stateSource, modelSource, thumbnailSource].join("\n");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /globalThis\.fetch/,
      /XMLHttpRequest/,
      /\b(?:localStorage|sessionStorage|indexedDB)\b/,
      /\bsetInterval\s*\(/,
      /innerHTML/,
      /console\./,
    ]) expect(combined).not.toMatch(forbidden);
    expect(crawlSource).not.toContain("error.details");
  });

  it("keeps thumbnail cleanup explicit and application internals flat", () => {
    for (const marker of [
      'image.loading = "lazy"',
      'image.decoding = "async"',
      'removeEventListener("load"',
      'removeEventListener("error"',
      'removeAttribute("src")',
      "return () =>",
      "controller.destroy()",
    ]) expect(`${thumbnailSource}\n${crawlSource}`).toContain(marker);
    expect(crawlCss).not.toMatch(/(?:-webkit-)?backdrop-filter\s*:/);
    expect(crawlCss).not.toMatch(/^\s*filter\s*:/m);
    expect(crawlCss).toContain(".crawl-workspace__track");
    expect(crawlCss).toContain("overflow: auto");
    expect(crawlCss).toContain("@media (forced-colors: active)");
  });
});
