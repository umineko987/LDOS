# WebUI test fixtures

This directory is the test-only boundary for the glass desktop migration.
Production modules under `gdl_backend/webui/` must never import, fetch, or
otherwise discover files from this directory.

Fixture rules:

- use only synthetic, redistributable images and allow-listed metadata;
- never copy runtime downloads, user directory names, download URLs, local
  absolute paths, credentials, or browser storage into a fixture;
- inject state through an explicit test harness or render interface;
- do not expose a production demo switch through storage, query parameters, or
  hidden keyboard shortcuts;
- keep visual migration baselines under `baselines/` with a metadata sidecar
  that records the viewport, route, capture method, and SHA-256 digest.

`webui_glass_target.test.mjs` is intentionally a red target-contract suite in
phase 0. The existing coverage suite remains `webui_modules.test.mjs` until the
target behavior is implemented in later phases.

## Pre-refactor visual baseline

`baselines/legacy-desktop-1440x900.png` records the production WebUI before the
glass migration. The legacy router opens CRAWL on a fresh profile, so the
baseline route is `#/crawl` rather than an empty desktop. It was captured from
the FastAPI `/ui/` mount with temporary test settings, background services
disabled, and an isolated empty Chromium profile. No browser storage, runtime
download, or user image was available to the page.

The adjacent JSON sidecar fixes the viewport, route, browser, capture method,
and SHA-256 digest. Regenerate the image only when intentionally replacing the
migration reference; never refresh it from a normal user profile or runtime
database.
