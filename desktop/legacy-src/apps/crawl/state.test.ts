import { describe, expect, it, vi } from "vitest";

import { sanitizeCrawlSearchResponse } from "./model";
import {
  crawlCandidates,
  crawlSources,
  createCrawlStore,
  selectedCrawlCandidates,
  visibleEhFacets,
} from "./state";

function response() {
  return {
    sources: [{
      site: "exhentai",
      status: "succeeded",
      addresses: [{
        id: "one",
        label: "One",
        address_type: "gallery",
        url: "https://e-hentai.org/g/1/aaaaaaaaaa/",
        metadata: { tags: ["artist:one", "language:chinese"] },
      }, {
        id: "two",
        label: "Two",
        address_type: "gallery",
        url: "https://e-hentai.org/g/2/bbbbbbbbbb/",
        metadata: { tags: ["artist:two"] },
      }],
      weak_evidence: [{
        id: "weak",
        label: "Weak",
        address_type: "gallery",
        url: "https://e-hentai.org/g/3/cccccccccc/",
        metadata: { tags: ["artist:one"] },
      }],
      tag_facets: [{
        namespace: "artist",
        label: "画师",
        gallery_count: 3,
        tags: [
          { tag: "artist:one", count: 2 },
          { tag: "artist:two", count: 1 },
          { tag: "artist:hidden", count: 4 },
        ],
      }],
    }, {
      site: "danbooru",
      status: "succeeded",
      addresses: [{
        id: "artist",
        label: "Artist",
        address_type: "artist_tag",
        url: "https://danbooru.donmai.us/posts?tags=artist",
      }],
      weak_evidence: [],
    }],
  };
}

describe("the one Crawl domain state owner", () => {
  it("commits one sanitized response into entity maps and independent order", () => {
    const store = createCrawlStore();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.beginSearch()).toBe(true);
    listener.mockClear();
    const projection = sanitizeCrawlSearchResponse(response());
    expect(store.commitSearch(projection.snapshot)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(crawlSources(store.getState()).map(({ site }) => site)).toEqual(["exhentai", "danbooru"]);
    expect(crawlCandidates(store.getState()).map(({ submitId }) => submitId)).toEqual(["one", "two"]);
    expect(Object.keys(store.getState().candidates)).toHaveLength(4);
  });

  it("updates only the affected keyed candidate and derived selection", () => {
    const store = createCrawlStore();
    store.beginSearch();
    store.commitSearch(sanitizeCrawlSearchResponse(response()).snapshot);
    const before = store.getState();
    const one = before.candidates["candidate:exhentai:one"];
    const two = before.candidates["candidate:exhentai:two"];
    expect(store.setCandidateSelected(one.key, true)).toBe(true);
    const after = store.getState();
    expect(after.candidates[one.key]).not.toBe(one);
    expect(after.candidates[two.key]).toBe(two);
    expect(after.candidateOrder).toBe(before.candidateOrder);
    expect(after.sourceOrder).toBe(before.sourceOrder);
    expect(selectedCrawlCandidates(after).map(({ key }) => key)).toEqual([one.key]);
    expect(store.setCandidateSelected(one.key, true)).toBe(false);
  });

  it("moves only the related source/order item and respects visible EH order", () => {
    const store = createCrawlStore();
    store.beginSearch();
    store.commitSearch(sanitizeCrawlSearchResponse(response()).snapshot);
    const sourceOrder = store.getState().sourceOrder;
    const candidateOrder = store.getState().candidateOrder;
    expect(store.moveCandidate("candidate:exhentai:two", -1)).toBe(true);
    expect(store.getState().candidateOrder["source:exhentai"]).toEqual([
      "candidate:exhentai:two", "candidate:exhentai:one", "candidate:exhentai:weak",
    ]);
    expect(store.getState().sourceOrder).toBe(sourceOrder);
    expect(store.moveSource("source:danbooru", -1)).toBe(true);
    expect(store.getState().sourceOrder).toEqual(["source:danbooru", "source:exhentai"]);
    expect(store.getState().candidateOrder["source:exhentai"]).not.toBe(candidateOrder["source:exhentai"]);
  });

  it("derives EH tags only from the currently visible candidate set", () => {
    const store = createCrawlStore();
    store.beginSearch();
    store.commitSearch(sanitizeCrawlSearchResponse(response()).snapshot);
    expect(visibleEhFacets(store.getState())[0].tags.map(({ key }) => key)).toEqual([
      "artist:one", "artist:two",
    ]);
    expect(store.setEhTagFilter("artist:one", "include")).toBe(true);
    expect(crawlCandidates(store.getState()).map(({ key }) => key)).toEqual(["candidate:exhentai:one"]);
    expect(visibleEhFacets(store.getState())[0].tags.map(({ key }) => key)).toEqual(["artist:one"]);
    expect(store.setWeakEvidenceVisible(true)).toBe(true);
    expect(crawlCandidates(store.getState()).map(({ key }) => key)).toEqual([
      "candidate:exhentai:one", "candidate:exhentai:weak",
    ]);
    store.setCandidateSelected("candidate:exhentai:weak", true);
    expect(store.setWeakEvidenceVisible(false)).toBe(true);
    expect(store.getState().candidates["candidate:exhentai:weak"].selected).toBe(false);
    expect(store.clearEhTagFilter()).toBe(true);
    expect(store.clearEhTagFilter()).toBe(false);
    expect(() => store.setEhTagFilter("bad", "include")).toThrow("invalid_eh_tag_key");
  });

  it("preserves authority on errors, owns create feedback, and cleans subscribers", () => {
    const store = createCrawlStore();
    const projection = sanitizeCrawlSearchResponse(response());
    store.beginSearch();
    store.commitSearch(projection.snapshot);
    const candidates = store.getState().candidates;
    store.beginSearch();
    store.failSearch({
      code: "network_error",
      requestId: "",
      targetApp: "diagnostics",
      title: "失败",
      message: "失败",
      nextStep: "重试",
    });
    expect(store.getState().candidates).toBe(candidates);
    store.beginSearch();
    store.commitSearch(projection.snapshot);
    expect(store.getState().phase).toBe("recovery");
    store.setCandidateSelected("candidate:exhentai:one", true);
    expect(store.beginCreate()).toBe(true);
    expect(store.finishCreate("done")).toBe(true);
    expect(store.getState()).toMatchObject({ busy: "", message: "done" });
    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    store.destroy();
    expect(store.setMessage("after destroy")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
