# Native Linux gallery orchestration

`gallery.New(settings, executorsRoot) (*Runner, error)` accepts local `Settings`,
not the backend config type. `executorsRoot` must contain
`ldos_gallery/worker_entry.py` (in this checkout: `backend/executors`). A missing
root or an old `gdl_backend`-only root is rejected; there is no legacy fallback.
`RepoPath` points to the vendored gallery-dl checkout; `CacheFile` remains required
by the Runner constructor but is not used by Resolve. No third-party Go dependency
is added; diagnostic masking uses `internal/redaction.Text`.

## API

- Settings: `RepoPath`, `CacheFile`, `PythonExecutable` strings;
  `TerminateGrace time.Duration`, `MaxLogLineChars int`, `ForbiddenArgs []string`.
  Defaults: python3, five-second grace (minimum effective grace 200 ms), 4000
  characters, Python GallerySettings managed-option list when the slice is nil.
- Request: `ID`, `URL`, `OutputDir`, `ProxyURL`, `CookiesFile`, `ConfigFile`,
  `CredentialsRef`, `Site`; `HTTPTimeout`, `TaskTimeout time.Duration`;
  `GalleryRetries int`, `ExtraArgs []string`, `EHDownload *EHDownloadOptions`,
  `OnStarted func(pid int, marker string) error`. Paths/policies are caller-resolved.
- `Run(ctx, RunRequest) (RunResult, error)`: embeds Request, adds `StallTimeout`
  and `OnLine func(stream, line string) error`; returns `OutputTail`.
- `Capture(ctx, CaptureRequest) (CaptureResult, error)`: embeds Request, adds
  `MaxOutputBytes int64` (zero = combined 64 MiB); returns `Stdout`, `Stderr`.
- Both results embed `ProcessResult`: `PID`, `ExitCode`, `Marker`, `TimedOut`.
  Nonzero exits are results, signals have negative exit codes, and pre-start
  failures have PID 0 / exit code -1. Task/stall timeouts set TimedOut; context
  cancellation returns the context error after cleanup. `ErrCaptureLimit`
  supports `errors.Is`. OnStarted errors also return only after cleanup.
- `Resolve(ctx context.Context, url string) (SiteInfo, error)`: independent fields
  `Site`, `Subcategory`, `Extractor`, `Supported`, `Host` with matching lowercase
  JSON names. Callers may map these to `tasks.SiteInfo`; gallery imports neither
  tasks nor httpapi. No `OutputDir` is required or created, and no cache is opened.
  A five-second context deadline (or the caller's earlier deadline) and combined
  16 KiB stdout/stderr capture budget are mandatory. It uses Capture and the same
  supervisor/active registry with unique resolve IDs, so StopAll also waits for
  resolver group cleanup. Cleanup may extend beyond the deadline by the configured
  termination grace and bounded pipe drain. A nonzero exit, malformed/missing/null
  fields, unexpected fields or trailing output is an error, not unsupported=false.
  Cancellation/deadline and `ErrCaptureLimit` remain inspectable with `errors.Is`.
- `ResolveBatch(ctx, urls)` uses the same supervisor and deadline for one group
  of local lookups. URLs are a JSON array on stdin (`--resolve-batch --`); the
  result must contain one valid `SiteInfo` per input in order. Crawl admission
  and media planning group up to 50 URLs, with a 16 KiB capture budget per URL.
- `ResolveDanbooruAuth(ctx, Request) (http.Header, error)` resolves the effective
  Danbooru account and Cookie headers offline using the worker's configuration
  precedence. Its secret-bearing response stays in private pipes, outside Capture
  diagnostics. Invalid or unsupported authentication fails explicitly instead of
  falling back to anonymous requests.
- `DanbooruRatePath()` identifies the shared rate-limit file beside `CacheFile`.
  Go API calls and Python workers use the same file for one metadata request per
  second and shared `Retry-After` cooldowns. CDN media downloads are unaffected.
- `ValidateArgs`, `BuildCommand`, `Cancel(id) bool`, `StopAll()`, `ActiveCount()`.
  Cancel/StopAll wait for cleanup; stop submitting work before StopAll. Duplicate
  active IDs are rejected. The runner remains reusable after StopAll.
- `TerminateStaleProcess(ctx, pid, marker, grace) (bool, error)` checks exact
  NUL-separated `-m ldos_gallery.worker_entry` and `--marker` arguments in /proc,
  plus process-group leadership, before TERM/grace/KILL. The optional `--resolve`, `--resolve-batch` or `--danbooru-auth`
  control flag is recognized. Exact `gdl_backend.worker_entry` identity is accepted
  only to clean up orphaned pre-migration workers; new commands never use it.

## Boundaries

- Go owns argv/abbreviation validation, credential/environment resolution, process
  sessions, timeout/stall supervision, stream draining, bounded capture, cancellation
  and process-group cleanup (even after the leader exits). No Python API/scheduler.
- Stall timing starts only after the worker's transfer-start marker. Heartbeat
  files track byte transfer and intentional Danbooru throttle/retry waits, not
  arbitrary log activity, and are removed on completion.
- Log callbacks are serialized, errors are ignored, and the last 250 lines are
  retained redacted. Lines exceeding 64 KiB are drained and replaced in the tail
  by a skip notice. Callbacks must return promptly; a log callback must not call
  blocking Cancel/StopAll on its own operation.
- Capture stdout is protocol data: only resolved literal credentials are masked.
  Do not publish it as diagnostic text; stderr receives full redaction.
- The independent `ldos_gallery` package imports only standard library and vendored
  gallery_dl (and its existing runtime dependencies). Stable `.part` naming and
  byte-write heartbeat hooks remain unchanged; third-party sources are not patched
  on disk. Worker argv still carries `--marker` before `--`; heartbeat environment
  names and patch warning/idempotency markers are preserved.
- Python import paths contain only executorsRoot and RepoPath; inherited PYTHONPATH
  is not appended. User-site imports and bytecode writes are disabled.
- Resolve runs `python -m ldos_gallery.worker_entry --marker VALUE --gallery-root
  REPO --resolve -- URL`. It calls only `gallery_dl.extractor.find(url)` and reads
  metadata; it does not call CLI `--dump-json`, initialize/iterate the extractor,
  load user config, login, access a database or perform network extraction. Host
  normalization, generic/directlink/recursive host fallback and twimg-to-twitter
  mapping preserve the legacy site.py behavior. Invalid vendor roots fail rather
  than reporting an unsupported URL.
- This is an executor split, not the complete backend migration. Runtime composition
  must supply an explicit executors directory (planned `--executors-dir`) and map
  SiteInfo at the integration boundary. Config/main/tasks/default startup, auth,
  HTTP and scheduling are outside this package change.
- Descendants retaining the worker process group are terminated. Deliberate session
  escape is not contained; orphan grandchildren are reaped by init, not this runner.
  Stale workers are not owned children and cannot be reaped with exec.Wait.
- Go tests use temporary paths and the Go test binary as a fake interpreter,
  including TERM-ignoring descendants, resolver deadlines and bounded protocol
  failures. Run `go test -race -count=1 ./internal/gallery` and
  `go vet ./internal/gallery` from backend.
- Real Python executor tests live in `backend/executors/tests`; see
  `backend/executors/README.md` for an isolated invocation. They statically resolve
  known URLs against the vendored tree, forbid socket/SQLite I/O with a test-only
  audit hook, and verify stable part naming plus both heartbeat receive hooks.
  No GUI, downloads, user config/database access or network test server is needed.
