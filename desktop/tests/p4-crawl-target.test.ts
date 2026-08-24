import { describe, expect, it, vi } from "vitest";

import { sanitizeCrawlSearchResponse } from "../src/apps/crawl/model";
import { createCrawlStore } from "../src/apps/crawl/state";
import candidateSource from "../src/apps/crawl/CandidateRow.svelte?raw";
import crawlSource from "../src/apps/crawl/Crawl.svelte?raw";

describe("P4 Crawl target migrated from the legacy P0 source probe", () => {
  it("updates one selected candidate without replacing source or order identities", () => {
    const projection = sanitizeCrawlSearchResponse({ sources: [{
      site: "danbooru",
      status: "succeeded",
      addresses: [{
        id: "one",
        label: "One",
        address_type: "artist_tag",
        url: "https://danbooru.donmai.us/posts?tags=one",
      }, {
        id: "two",
        label: "Two",
        address_type: "artist_tag",
        url: "https://danbooru.donmai.us/posts?tags=two",
      }],
      weak_evidence: [],
    }] });
    const store = createCrawlStore();
    store.beginSearch();
    store.commitSearch(projection.snapshot);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    const before = store.getState();
    const first = before.candidates["candidate:danbooru:one"];
    const second = before.candidates["candidate:danbooru:two"];

    store.setCandidateSelected(first.key, true);

    const after = store.getState();
    expect(listener).toHaveBeenCalledOnce();
    expect(after.candidates[first.key]).not.toBe(first);
    expect(after.candidates[second.key]).toBe(second);
    expect(after.sources).toBe(before.sources);
    expect(after.sourceOrder).toBe(before.sourceOrder);
    expect(after.candidateOrder).toBe(before.candidateOrder);
  });

  it("moves only the keyed projection and never rebuilds lists imperatively", () => {
    const projection = sanitizeCrawlSearchResponse({ sources: [{
      site: "danbooru",
      status: "succeeded",
      addresses: ["one", "two", "three"].map((id) => ({
        id,
        label: id,
        address_type: "artist_tag",
        url: `https://danbooru.donmai.us/posts?tags=${id}`,
      })),
      weak_evidence: [],
    }] });
    const store = createCrawlStore();
    store.beginSearch();
    store.commitSearch(projection.snapshot);
    const before = store.getState();
    store.moveCandidate("candidate:danbooru:two", -1);
    const after = store.getState();
    expect(after.candidateOrder["source:danbooru"]).toEqual([
      "candidate:danbooru:two",
      "candidate:danbooru:one",
      "candidate:danbooru:three",
    ]);
    expect(after.candidates).toBe(before.candidates);
    expect(after.sources).toBe(before.sources);
    expect(crawlSource).toContain("{#each sources as source, index (source.key)}");
    expect(crawlSource).toContain("{#each candidates as candidate, index (candidate.key)}");
    expect(candidateSource).toContain("data-candidate-key={candidate.key}");
    expect(`${crawlSource}\n${candidateSource}`).not.toContain("replaceChildren(");
  });
});
