# Standalone gallery-dl executor

`ldos_gallery` is the deliberately small Python boundary: gallery-dl entry glue,
runtime stable-part/heartbeat hooks, and static extractor metadata selection. It
imports no `gdl_backend`, tasks, HTTP, auth, database or scheduling implementation.
It uses the standard library and the vendored gallery_dl package; the interpreter
must already provide gallery-dl's own dependencies (including requests).

Pass this directory to `gallery.New(settings, executorsRoot)`. `RepoPath` is the
vendor checkout containing `gallery_dl/__init__.py`. The Go runner sets the import
path to these two directories, drops inherited PYTHONPATH, disables user-site
imports/bytecode writes, and supervises every process group. No old module fallback
is available. The application/default-backend switch is a separate integration.

## Protocol

Download glue (Go controls all gallery CLI options and credential environment):

```text
python -m ldos_gallery.worker_entry --marker ID --gallery-root REPO -- GALLERY_ARGS...
```

Offline resolve (one URL exactly, one JSON object on stdout):

```text
python -m ldos_gallery.worker_entry --marker ID --gallery-root REPO --resolve -- URL
{"site":"twitter","subcategory":"tweet","extractor":"TwitterTweetExtractor","supported":true,"host":"x.com"}
```

Resolve calls `gallery_dl.extractor.find` only; it does not call `gallery_dl.main`,
load configuration, iterate/initialize an extractor or perform a download. The
five fields follow the old site.py mapping, including unsupported host/unknown
fallback and twimg/generic/directlink/recursive normalization. Invalid vendor
roots and import failures are execution errors. `Runner.Resolve(ctx, url)` provides
a five-second deadline and combined 16 KiB capture limit, strict required-field
parsing, and the existing cancellation/reaping/group cleanup. No OutputDir,
credentials, user config or cache path is passed to the resolve subprocess.

Worker marker args, `GDL_WORKER_USERNAME` / `GDL_WORKER_PASSWORD` handoff,
`GDL_ACTIVITY_FILE` / `GDL_ACTIVITY_STARTED_FILE`, stable `.part` naming,
per-chunk flush and at-most-once-per-second activity touches retain their old
behavior. Hooks remain runtime-only; the vendored checkout is unchanged.

## Nonvisual offline tests

From the repository root, with an existing interpreter containing gallery-dl's
dependencies (the example uses the project `.venv`; do not install anything):

```sh
root="$PWD"
python="$root/.venv/bin/python"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
env -i PATH=/usr/bin:/bin HOME="$tmp" \
  XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" XDG_DATA_HOME="$tmp/data" \
  PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="$root/backend/executors/tests:$root/backend/executors:$root/gallery-dl-codeberg" \
  "$python" -B -s -P -m unittest discover \
  -s "$root/backend/executors/tests" -p 'test_*.py' -v
```

The tests use temporary HOME/XDG/work directories and vendored static URLs.
`tests/sitecustomize.py` is a test-only audit guard blocking socket operations
(including DNS) and SQLite connections, including subprocesses; never add the
tests directory to production PYTHONPATH. No GUI or network server is launched.
Tests cover CLI protocol/errors, known/unknown site metadata, no config load or
extractor execution, credential handoff, vendor identity, stable part paths,
idempotent hooks, buffered chunk visibility, and both receive heartbeat paths.
Real authenticated downloads/resume over HTTP and default-runtime integration
are intentionally outside this offline verification.
