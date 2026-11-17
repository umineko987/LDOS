> **Under development**

# LDOS

**LoRA Dataset Operating System**

[简体中文](README.md)

LDOS is a local LoRA dataset workbench built around [gallery-dl](https://codeberg.org/mikf/gallery-dl). Each dataset moves through a pipeline: collect → clean → dedup → tag → review → export.

## Features

- **Dataset pipeline**: collect (ordered acquisition batches from source search, or images added from the library), clean (rule-based screening plus keyboard triage), dedup (near-duplicates from perceptual hashes and SSCD/DINO models, compared side by side), tag (local tagger models), review, and export (captions and trigger word written to a target folder).
- **Tag studio**: filter by tag queries, add, remove or replace tags in bulk, preview the diff before writing, and undo; keep a blacklist and a tag frequency table.
- **Dataset atlas**: a scatter map of the whole dataset from image embeddings, with clusters, their top tags and outliers; lasso a region to tag it or remove it from the dataset.
- **Library**: browse, search and rename downloaded images, edit their sidecar TXT captions, with a recycle bin; add folders or selected images to a dataset.
- **Jobs**: live progress for acquisition, scan, tagging and export jobs, with a notice when each finishes or fails.
- **Proxies, site authentication and models**: manage proxy sources, connection probes, site credentials and managed browser sessions; download and manage local models.
- **Local desktop workspace**: A mygo + Svelte interface, currently supported on Linux, backed by a local Go service. The backend listens on loopback by default and stores task and gallery state in local SQLite and filesystem data.

## Quick Start

LDOS currently supports Linux x86_64. Install GTK 3 / WebKitGTK 4.1, Node.js 26, Go 1.27.3, and Python 3.13 or 3.14 with venv/pip.

On Debian/Ubuntu, install the desktop dependencies:

```sh
sudo apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev
```

Clone the repository with its submodules, then prepare the Go backend, Python executors and CPU model environment:

```sh
git clone --recurse-submodules https://github.com/KKKneko/LDOS.git
cd LDOS
./scripts/setup-linux.sh --device cpu
```

Setup preserves an existing `gallery-dl-backend/config.json`. New installations allow manual proxy pool startup and leave automatic startup disabled. After adding a subscription, start the pool from the network settings page. Login and model downloads share their proxy setting; acquisition uses site policies.

Install frontend dependencies and open the development window:

```sh
cd desktop
npm ci
npm run generate
npm run dev
```

`dev` builds the Go backend, generates mygo bindings, and starts Vite and the desktop window. Close the window and stop the development process in your terminal when finished. To run only the backend, use `./scripts/run.sh` from the repository root; `./scripts/doctor.sh --json` checks the runtime environment.

## Build and Run

From `desktop/`:

```sh
npm run build
npm run desktop:start
```

The outputs are `backend/build/ldos-backend` and `desktop/build/linux-amd64/ldos`. Source mode still requires the source tree, gallery-dl submodule, Python executor environments and configuration. Moving the desktop binary alone does not include these resources.

Use `python3 scripts/desktop_release.py build` to assemble a standalone archive from a clean checkout. Standalone mygo packages and AppImage distribution have not completed release validation. CI, desktop builds and release targets support Linux x86_64 only.

## Configuration and Data

- The configuration file is `gallery-dl-backend/config.json`; override it with `GDL_BACKEND_CONFIG`. Relative paths resolve from the configuration file.
- `GDL_BACKEND_HOST` / `GDL_BACKEND_PORT` override the listening address and port, which use loopback by default.
- Credentials, proxy subscriptions, databases, downloads and local models stay in the configured local directories and are excluded from version control.
- README files contain the installation and development entry points. Design notes, development references and local editor/agent settings remain local. Source code, tests, CI, build scripts and licenses remain part of the repository.

## Tests

Run from the repository root:

```sh
(cd backend && go test -race -timeout 5m ./... && go vet ./...)
(cd desktop && npm test && npm run check)
.venv/bin/python -m unittest discover -s tests -v
PYTHONPATH=backend/executors gallery-dl-backend/.venv/bin/python -m unittest discover -s backend/executors/tests -v
python3 scripts/export_openapi.py --check
```

Python tests additionally require `gallery-dl-backend/requirements-test.txt` in both virtual environments. Regression tests cover proxy startup and fallback, search deadlines and cancellation, queue refresh, and image/caption access after deduplication. Real gallery authentication tests use the submodule and executor environment. GUI behavior, live site permissions and actual model quality require separate validation.

See the [Go backend README](backend/README.md) for runtime boundaries and the [E2E README](desktop/e2e/README.md) for browser tests.
