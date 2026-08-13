# WebUI test fixtures

This directory is the tests-only boundary for the current glass desktop WebUI.
Production modules under `gdl_backend/webui/` must never import, fetch, or
otherwise discover files from this directory.

Fixture rules:

- use only synthetic, redistributable media and allow-listed metadata;
- never copy runtime downloads, user directory names, download URLs, local
  absolute paths, credentials, or browser storage into a fixture;
- inject state through an explicit test harness or render interface;
- do not expose a production demo switch through storage, query parameters, or
  hidden keyboard shortcuts;
- keep historical visual references under `baselines/` with a metadata sidecar
  recording the viewport, route, capture method, and SHA-256 digest.

All authoritative Node behavior suites, including the Stage 6 closeout
contract, are listed by `scripts/run-webui-coverage.py`. Python static tests
also verify the import graph, Store closure, fixture isolation, static assets,
and screenshot provenance.

## Historical baseline

`baselines/legacy-desktop-1440x900.png` is a historical pre-glass comparison,
not a current product baseline and not a pixel-golden test. Its adjacent JSON
sidecar fixes the original `#/crawl` route, 1440×900 viewport, isolated profile,
no-runtime-data source, and SHA-256 digest. It remains here only to document the
migration starting point.

## Stage 5 preview host

`stage5-preview-host.html`, its controller host, and
`stage5-preview-fixtures.js` explicitly drive loading, empty, content, error,
and deterministic progress layouts for Gallery, Schedule, and Export. They are
mounted only by `tests/stage5_preview_harness.py`. Production preview adapters
remain unavailable and make zero owned business API requests.

The Stage 6 production closure test ensures these fixture markers and modules
never enter `gdl_backend/webui/` or the wheel. The maintained project screenshot
is `assets/example.png` with provenance in `assets/example.json`; it comes from
the production `/ui/` mount under an isolated safe backend configuration and is
not part of this fixture directory.
