import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import { m } from "#lib/paraglide/messages.js";
import WorkbenchCard from "./workbench-card.svelte";

const props = {
  id: "post-42",
  title: "A film still",
  preview: "https://example.test/still.jpg",
  meta: "1600×900 · JPG",
  status: "",
  selected: false,
  disabled: false,
  focused: false,
  checkpoint: false,
  onfocusitem: () => {},
  ontoggle: () => {},
};

async function renderCard(overrides: Partial<typeof props> = {}) {
  const { body } = await render(WorkbenchCard, { props: { ...props, ...overrides } });
  return body;
}

describe("workbench card", () => {
  it("puts the preview and caption in a native toggle button with a sibling inspect button", async () => {
    const body = await renderCard();
    const [selection, inspect] = body.match(/<button\b[^>]*>(?:(?!<button\b)[\s\S])*?<\/button>/g) ?? [];

    expect(body.match(/<button\b/g)).toHaveLength(2);
    expect(selection).toContain('type="button"');
    expect(selection).toContain(`aria-label="${m.collect_workbench_select_item({ title: props.title })}"`);
    expect(selection).toContain('aria-pressed="false"');
    expect(selection).toContain(`<img src="${props.preview}"`);
    expect(selection).toContain(props.meta);
    expect(selection).not.toContain("data-inspect");
    expect(inspect).toContain('type="button"');
    expect(inspect).toContain("data-inspect");
    expect(inspect).toContain(`aria-label="${m.collect_workbench_open_item({ title: props.title })}"`);
    expect(inspect).toContain('aria-expanded="false"');
    expect(inspect).not.toContain("aria-pressed");
  });

  it("marks selection with both a check icon and a ring", async () => {
    const body = await renderCard({ selected: true });

    expect(body).toContain('aria-pressed="true"');
    expect(body).toContain("lucide-check");
    expect(body).toContain("ring-2 ring-gold");
  });

  it("disables only selection when unavailable and still renders fallback and checkpoint", async () => {
    const status = "Already in dataset";
    const body = await renderCard({ disabled: true, focused: true, preview: "", status, checkpoint: true });
    const [selection, inspect] = body.match(/<button\b[^>]*>/g) ?? [];

    expect(selection).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(inspect).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(inspect).toContain('aria-expanded="true"');
    expect(body).not.toContain("<img");
    expect(body).toContain("lucide-image-off");
    expect(body).toContain(m.collect_workbench_last_submitted());
    expect(body).toContain(status);
  });
});
