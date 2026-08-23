import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{svelte,ts}", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("P1 frontend boundaries", () => {
  it("keeps fetch inside the one API client", () => {
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith("/core/api/client.ts") || path.endsWith(".test.ts")) continue;
      expect(source, path).not.toMatch(/\bfetch\s*\(|globalThis\.fetch/);
    }
  });

  it("does not introduce a second production UI entry", () => {
    const forbiddenEntry = ["ui", "next"].join("-");
    for (const [path, source] of Object.entries(sources)) {
      expect(`${path}\n${source}`).not.toContain(forbiddenEntry);
    }
  });
});
