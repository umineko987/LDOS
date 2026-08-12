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
