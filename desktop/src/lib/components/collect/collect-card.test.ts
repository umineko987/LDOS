import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import { m } from "#lib/paraglide/messages.js";
import CollectCard from "./collect-card.svelte";

const baseItem = {
  id: "42",
  title: "A film still",
  author: "Alice",
  width: 1600,
  height: 900,
  file_ext: "png",
  media_count: 1,
  url: "https://danbooru.donmai.us/posts/42",
  downloadable: true,
  local_state: "none",
} as const;

describe("collect-card", () => {
  it("renders preview image with crossorigin=anonymous and metadata", async () => {
    const { body } = await render(CollectCard, {
      props: {
        item: { ...baseItem, media_count: 3 },
        index: 0,
        previewUrl: "http://127.0.0.1:8787/api/v1/collect/media/tok",
        selected: false,
        excluded: false,
        onclick: () => {},
        onselectuntil: () => {},
      },
    });

    expect(body).toContain('crossorigin="anonymous"');
    expect(body).toContain('src="http://127.0.0.1:8787/api/v1/collect/media/tok"');
    expect(body).toContain("1600×900 · PNG");
    expect(body).toContain(m.collect_v2_badge_pages({ count: 3 }));
    expect(body).toContain('aria-pressed="false"');
  });

  it("renders selected gold indicator and library reuse / dataset lock badges", async () => {
    const { body: selectedBody } = await render(CollectCard, {
      props: {
        item: { ...baseItem, local_state: "in_library", local_asset_id: "asset-1" },
        index: 0,
        previewUrl: null,
        selected: true,
        excluded: false,
        onclick: () => {},
        onselectuntil: () => {},
      },
    });
    expect(selectedBody).toContain('aria-pressed="true"');
    expect(selectedBody).toContain("bg-gold");
    expect(selectedBody).toContain(m.collect_v2_badge_in_library());
    expect(selectedBody).toContain("lucide-image-off");

    const { body: datasetBody } = await render(CollectCard, {
      props: {
        item: { ...baseItem, local_state: "in_dataset" },
        index: 0,
        previewUrl: null,
        selected: false,
        excluded: false,
        onclick: () => {},
        onselectuntil: () => {},
      },
    });
    expect(datasetBody).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(datasetBody).toContain(m.collect_v2_badge_in_dataset());
  });
});
