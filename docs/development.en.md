# Linux development guide

[简体中文](development.md)

## Quick Start

Linux x86_64 only. The host provides GTK 3 / WebKitGTK 4.1; source builds use Go 1.27.3 and Node.js 26.3.1 (bundled npm 11.16.0). Provide system `python3` (3.11.4 or newer) for bootstrap; no preinstalled inference Python or Torch is needed.

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

Setup uses the [release lock](../desktop/release/runtime-lock.json) to download and verify CPython 3.13.15 under `.local/runtimes/` and creates separate gallery and model venvs. CPU is the default; `--device cuda` selects the CUDA 12.8 lock (compatible NVIDIA driver required). `--tagger-torch` adds CPU Canary/PixAI dependencies. Weights are on demand; pass `--with-models` to prefetch SSCD/DINOv2. Advanced users can pass `--python PATH` (3.11–3.14).

The Linux x86_64 Mihomo version also comes from the release lock.

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

See the [Go backend README](../backend/README.md) for runtime boundaries and the [E2E README](../desktop/e2e/README.md) for browser tests.
