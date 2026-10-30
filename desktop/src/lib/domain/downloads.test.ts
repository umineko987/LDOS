import { describe, expect, it } from "vitest";

import type { DownloadSettings } from "#lib/api/queries/models.ts";

import { draftChanges, HF_MIRROR_PRESET, isMirrorUrl, isProxyUrl, mirrorValue, toDraft, validateDraft, type DownloadDraft } from "./downloads.ts";

const VIEW: DownloadSettings = {
  hf_mirror: null,
  proxy_mode: "none",
  custom_proxy: null,
  custom_proxy_has_credentials: false,
  token_set: false,
};

const draft = (overrides: Partial<DownloadDraft> = {}): DownloadDraft => ({ ...toDraft(VIEW), ...overrides });

describe("download settings draft", () => {
  it("maps the saved mirror to official, preset or custom", () => {
    expect(toDraft(VIEW)).toEqual({ mirror: "official", mirrorUrl: "", proxyMode: "none", customProxy: "" });
    expect(toDraft({ ...VIEW, hf_mirror: HF_MIRROR_PRESET }).mirror).toBe("preset");
    expect(toDraft({ ...VIEW, hf_mirror: "https://mirror.example/hf", proxy_mode: "pool" })).toEqual({
      mirror: "custom",
      mirrorUrl: "https://mirror.example/hf",
      proxyMode: "pool",
      customProxy: "",
    });
  });

  it("never pre-fills the custom proxy, which the backend only returns masked", () => {
    expect(toDraft({ ...VIEW, proxy_mode: "custom", custom_proxy: "http://***@10.0.0.2:3128" }).customProxy).toBe("");
  });

  it("resolves the mirror value, trimming trailing slashes", () => {
    expect(mirrorValue(draft())).toBeNull();
    expect(mirrorValue(draft({ mirror: "preset" }))).toBe(HF_MIRROR_PRESET);
    expect(mirrorValue(draft({ mirror: "custom", mirrorUrl: "  https://m.example/// " }))).toBe("https://m.example");
  });

  it("checks mirror addresses like the backend", () => {
    expect(isMirrorUrl("https://hf-mirror.com")).toBe(true);
    expect(isMirrorUrl("http://10.0.0.2:8080/hf")).toBe(true);
    for (const bad of ["", "ftp://m.example", "https://user:pw@m.example", "https://m.example?x=1", "https://m.example#a", "https://m .example", "not a url"]) {
      expect(isMirrorUrl(bad), bad).toBe(false);
    }
    expect(isMirrorUrl(`https://m.example/${"a".repeat(300)}`)).toBe(false);
  });

  it("requires a port and no path for proxies", () => {
    expect(isProxyUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isProxyUrl("https://user:pw@proxy.example:443/")).toBe(true);
    expect(isProxyUrl("http://[::1]:8080")).toBe(true);
    for (const bad of ["http://127.0.0.1", "socks5://127.0.0.1:1080", "http://h:1/path", "http://h:1?x", "http://h :1"]) {
      expect(isProxyUrl(bad), bad).toBe(false);
    }
  });

  it("validates the draft before saving", () => {
    expect(validateDraft(draft(), VIEW)).toBeNull();
    expect(validateDraft(draft({ mirror: "custom", mirrorUrl: " " }), VIEW)).toBe("mirror_required");
    expect(validateDraft(draft({ mirror: "custom", mirrorUrl: "ftp://x" }), VIEW)).toBe("mirror_invalid");
    expect(validateDraft(draft({ customProxy: "http://h" }), VIEW)).toBe("proxy_invalid");
    expect(validateDraft(draft({ proxyMode: "custom" }), VIEW)).toBe("proxy_required");
    expect(validateDraft(draft({ proxyMode: "custom" }), { ...VIEW, custom_proxy: "http://h:1" })).toBeNull();
  });

  it("sends only the changed fields", () => {
    expect(draftChanges(VIEW, draft())).toBeNull();
    expect(draftChanges(VIEW, draft({ mirror: "preset", proxyMode: "custom", customProxy: " http://h:1 " }))).toEqual({
      hf_mirror: HF_MIRROR_PRESET,
      proxy_mode: "custom",
      custom_proxy: "http://h:1",
    });
    expect(draftChanges({ ...VIEW, hf_mirror: HF_MIRROR_PRESET }, draft({ mirror: "official" }))).toEqual({ hf_mirror: null });
  });
});
