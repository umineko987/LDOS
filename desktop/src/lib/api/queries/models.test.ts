import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { isApiError } from "../errors.ts";
import {
  downloadSettingsQuery,
  installModels,
  modelKeys,
  modelsQuery,
  updateDownloadSettings,
  type DownloadSettings,
} from "./models.ts";

function apiReturning(status: number, payload: unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const fetchWith = <T>(options: { queryKey: readonly unknown[] }) =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(options as never) as Promise<T>;

const DOWNLOADS: DownloadSettings = {
  hf_mirror: null,
  proxy_mode: "none",
  custom_proxy: null,
  custom_proxy_has_credentials: false,
  token_set: true,
  token_hint: "…abcd",
};

describe("model queries", () => {
  it("keeps models and download settings under separate keys", () => {
    expect(modelKeys.list()).toEqual(["models", "list"]);
    expect(modelKeys.downloads()).toEqual(["settings", "downloads"]);
  });

  it("reads the model table", async () => {
    const { api, requests } = apiReturning(200, { items: [] });
    await expect(fetchWith(modelsQuery(api))).resolves.toEqual({ items: [] });
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/models");
  });

  it("posts install requests with the license flag", async () => {
    const { api, requests } = apiReturning(202, { started: [], items: [] });
    await expect(installModels(api, { keys: ["cl"], accept_license: true })).resolves.toEqual({ started: [], items: [] });
    expect(requests[0]!.method).toBe("POST");
    expect(await requests[0]!.json()).toEqual({ keys: ["cl"], accept_license: true });
  });

  it("turns backend refusals into ApiError", async () => {
    const { api, requests } = apiReturning(422, { error: { code: "model_license_required", message: "需要先同意许可" } });
    const failure = await installModels(api, { keys: ["cl"] }).catch((error: unknown) => error);
    expect(isApiError(failure) && failure.code).toBe("model_license_required");
    expect(await requests[0]!.json()).toEqual({ accept_license: false, keys: ["cl"] });
  });

  it("reads and updates the download settings", async () => {
    const { api, requests } = apiReturning(200, DOWNLOADS);
    await expect(fetchWith(downloadSettingsQuery(api))).resolves.toEqual(DOWNLOADS);
    await updateDownloadSettings(api, { hf_token: "hf_secret_value" });
    expect(requests[1]!.method).toBe("PUT");
    expect(new URL(requests[1]!.url).pathname).toBe("/api/v1/settings/downloads");
    expect(await requests[1]!.json()).toEqual({ clear_hf_token: false, hf_token: "hf_secret_value" });
  });
});
