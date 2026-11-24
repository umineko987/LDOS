import { describe, expect, it } from "vitest";
import type { DiscoveryCandidate } from "./discovery.ts";
import { newWorkbenchAttempt, readWorkbenchCheckpoint, saveWorkbenchCheckpoint, workbenchAddress, workbenchCheckpointSource } from "./workbench.ts";

function candidate(site: string, url: string): DiscoveryCandidate {
  return { site, url, key: url, id: null, label: url, addressType: null, mediaCount: null, confidence: null };
}

describe("workbench submission and navigation", () => {
  it("copies the exact selected IDs and Danbooru tokens into the attempt", () => {
    const ids = ["4", "3"];
    const tokens = ["token-4", "token-3"];
    const attempt = newWorkbenchAttempt({ site: "danbooru", ids, tokens });
    ids.reverse();
    tokens.push("token-2");
    expect(attempt).toMatchObject({ ids: ["4", "3"], tokens: ["token-4", "token-3"] });
    expect(newWorkbenchAttempt({ site: "danbooru", ids, tokens }).key).not.toBe(attempt.key);
  });

  it("opens supported discovery addresses in the matching source workbench", () => {
    const gallery = "https://e-hentai.org/g/2/aabbccddee/";
    const artist = "https://www.pixiv.net/users/12/artworks";
    const profile = "https://x.com/artist/media";
    expect(workbenchAddress(candidate("exhentai", gallery))).toEqual({ site: "exhentai", url: gallery });
    expect(workbenchAddress(candidate("pixiv", artist))).toEqual({ site: "pixiv", url: artist });
    expect(workbenchAddress(candidate("twitter", profile))).toEqual({ site: "twitter", url: profile });
    expect(workbenchAddress(candidate("danbooru", "https://danbooru.donmai.us/posts?tags=cat+order%3Aid_desc")))
      .toEqual({ site: "danbooru", query: "cat order:id_desc" });
    expect(workbenchAddress(candidate("pixiv", "https://www.pixiv.net/artworks/12"))).toBeNull();
    expect(workbenchAddress(candidate("pawchive", "https://pawchive.pw/patreon/user/12"))).toBeNull();
    expect(workbenchAddress(candidate("twitter", "not a URL"))).toBeNull();
    expect(workbenchAddress(candidate("twitter", "ftp://x.com/artist"))).toBeNull();
  });

  it("stores a canonical timeline identity without user info, search or fragments", () => {
    const profile = "https://x.com/artist/media";
    expect(workbenchCheckpointSource("twitter", "search", "", "http://name:secret@mobile.twitter.com/ARTIST?share=token#media")).toBe(profile);
    expect(workbenchCheckpointSource("twitter", "search", "", "https://x.com/artist/media/")).toBe(profile);
    const artist = "https://www.pixiv.net/users/12/artworks";
    expect(workbenchCheckpointSource("pixiv", "search", "", "https://pixiv.net/en/users/12?ref=token#artworks")).toBe(artist);
    expect(workbenchCheckpointSource("pixiv", "search", "", artist)).toBe(artist);
    expect(workbenchCheckpointSource("pixiv", "search", "", "invalid")).toBeNull();
    expect(workbenchCheckpointSource("exhentai", "search", "", "https://e-hentai.org/g/2/aabbccddee/")).toBeNull();
    expect(workbenchCheckpointSource("danbooru", "search", "cat order:id_desc", "")).toContain("cat order:id_desc");
  });
  it("keeps submission checkpoints separate across datasets and source references", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => { values.set(key, value); },
      getItem: (key: string) => values.get(key) ?? null,
    };
    saveWorkbenchCheckpoint(storage, "dataset-a", "artist", "4");
    saveWorkbenchCheckpoint(storage, "dataset-a", "artist", "5");
    expect(readWorkbenchCheckpoint(storage, "dataset-a", "artist")).toBe("5");
    expect(readWorkbenchCheckpoint(storage, "dataset-b", "artist")).toBeNull();
    expect(readWorkbenchCheckpoint(storage, "dataset-a", "different-artist")).toBeNull();
  });
});
