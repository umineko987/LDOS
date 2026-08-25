# Third-party notices and release evidence

ImageWeave desktop bundles are assembled only from locked inputs. The canonical assembler writes a target-specific inventory to:

- `backend/licenses/third-party-components.json` — machine-readable component name, exact version, declared license, source, artifact hash/integrity when available, and bundled license-file paths;
- `backend/licenses/THIRD-PARTY-NOTICES.md` — the same inventory for people;
- `backend/licenses/{cargo,npm,rust}/` and the Python runtime's installed `*.dist-info/licenses/` directories — license and notice files shipped with that target.

Both inventories and every referenced license file are covered by `backend/release-files.sha256` and `backend/release-manifest.json`. `python scripts/desktop_release.py verify-tree` and `verify-bundle` reject a missing inventory, a missing license file, an untrusted source URL, a target mismatch, or altered bytes.

## Locked distribution inputs

| Distributed input | Locked version / identity | License | Source and lock evidence |
| --- | --- | --- | --- |
| CPython | 3.13.15 | PSF-2.0 | [CPython v3.13.15 source](https://github.com/python/cpython/tree/v3.13.15); the archive's `LICENSE.txt` hash is pinned in `desktop/release/runtime-lock.json`. |
| python-build-standalone | 20260807 | MPL-2.0 | [Release 20260807](https://github.com/astral-sh/python-build-standalone/releases/tag/20260807); per-target archive hashes and the MPL license hash are pinned in `desktop/release/runtime-lock.json`. |
| gallery-dl | `1.32.7-dev`, gitlink `2790ceb303ee4986ef7f683cc16d3799bb4356ce` | GPL-2.0-only | [Exact Codeberg source](https://codeberg.org/mikf/gallery-dl/src/commit/2790ceb303ee4986ef7f683cc16d3799bb4356ce); the clean submodule gitlink and `gallery-dl-codeberg/LICENSE` are verified during assembly. |
| Rust standard library | 1.98.0 | Apache-2.0 OR MIT | [Rust 1.98.0 source](https://github.com/rust-lang/rust/tree/1.98.0); `rust-toolchain.toml` pins the toolchain and the installed standard-library copyright inventories are copied into each bundle. |
| Svelte runtime | 5.56.10 | MIT | [Locked npm tarball](https://registry.npmjs.org/svelte/-/svelte-5.56.10.tgz); version, SRI integrity and license are in `desktop/package-lock.json`. |
| Tauri JavaScript API | 2.11.1 | Apache-2.0 OR MIT | [Locked npm tarball](https://registry.npmjs.org/@tauri-apps/api/-/api-2.11.1.tgz); version, SRI integrity and license are in `desktop/package-lock.json`. |

The complete Python distribution set is installed with hashes from `gallery-dl-backend/requirements.txt` and `requirements-dedup-cpu.txt`. The complete target-specific Rust crate set is resolved from `desktop/src-tauri/Cargo.lock` with Cargo metadata. Those generated inventories are authoritative because Linux and Windows resolve different native crates and Python wheels; this document intentionally does not present a stale cross-platform union as bundle contents.

The Tauri executable dynamically uses operating-system WebView and desktop libraries. Those system components are prerequisites, not files bundled by ImageWeave, and therefore are not represented as distributed components.

## Resources deliberately not distributed

The current lock records `dedup_models`, `mihomo`, and `browser_runtime` as unavailable optional resources. No model weights, mihomo executable, browser/Chromium runtime, proxy secret, user configuration, database, cache, log, or output file is included. The backend keeps its existing readiness semantics: `/healthz` is the startup gate, while missing optional resources may leave `/readyz` at HTTP 503 without blocking the desktop UI.

## Verification

From a clean tracked checkout with the target prerequisites installed:

```bash
python scripts/desktop_release.py build --cache-dir .release-cache
```

For an already assembled tree or bundle:

```bash
python scripts/third_party_notices.py \
  --tree desktop/src-tauri/release/backend \
  --target linux-x86_64
python scripts/desktop_release.py verify-tree \
  --tree desktop/src-tauri/release/backend
python scripts/desktop_release.py verify-bundle --bundle PATH_TO_BUNDLE
```

The first command is target-specific; use `windows-x86_64` on the Windows assembly job.
