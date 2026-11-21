# Native Go SQLite store

Import `ldos/backend/internal/store`. Production code uses `modernc.org/sqlite` directly, never a Python API or initializer. `Store` embeds `*TaskRepository`, so every repository method below is also callable directly on `*Store`. No HTTP handlers are included.

## Connection and schema

```go
func Open(path string) (*Store, error)
func (s *Store) Close() error
func (s *Store) Ping(ctx context.Context) error
```

- One writer, serialized `BEGIN IMMEDIATE` transactions, WAL, foreign keys, busy timeout 10 seconds, synchronous NORMAL. Separate pooled readers are `mode=ro` and `query_only=ON`; detailed task reads use a consistent read transaction.
- Schema v19 adds gallery-owned caption batches and persistent per-image keep decisions to the v18 gallery/dataset schema. Business services use the same serialized writer through `WriteTransaction`.
- DDL, upgrades, compatibility checks and the schema marker commit atomically. FTS5 failure, missing required columns and unsupported versions fail without advancing the marker.
- Legacy upgrades preserve data. For version `<8`, original site policies are retained in `meta` under `legacy_site_policy:*` while current policies are normalized. For version `<13`, gallery review rows remain intact and receive `legacy_gallery_review:*` markers. Review services treat those snapshots as read-only until reanalysis, so old decisions cannot move current files.
- The v18 → v19 migration preserves dataset caption batches and undo journals, carries old review exclusions forward to export, and does not turn dataset approvals into gallery-wide keep flags. New directories use 0700; existing parent permissions are retained. Database/WAL/SHM files use 0600. Existing symlinks in path components or SQLite sidecars are rejected.
- File databases only (`:memory:` is not supported by this API). Tests use `t.TempDir()`, never user runtime files. `Close` is idempotent.

## Task reads

```go
func (r *TaskRepository) ListTasks(ctx context.Context, status, site string, limit, offset int) ([]map[string]any, error)
func (r *TaskRepository) GetTask(ctx context.Context, id string) (map[string]any, error)
func (r *TaskRepository) GetTaskByIdempotency(ctx context.Context, key string) (map[string]any, error)
func (r *TaskRepository) QueuedTasks(ctx context.Context, limit int, excludeSites []string) ([]map[string]any, error)
func (r *TaskRepository) QueuedTaskIDs(ctx context.Context, ids []string) (map[string]struct{}, error)
func (r *TaskRepository) IncompleteProcesses(ctx context.Context) ([]map[string]any, error)
func (r *TaskRepository) GetLogs(ctx context.Context, taskID string, since int64, tail *int, limit int) ([]map[string]any, error)
func (r *TaskRepository) GetEvents(ctx context.Context, taskID string, since int64, limit int) ([]map[string]any, error)
```

Task projections decode `extra_args_json`, `policy_json`, `tried_proxy_ids_json` to their suffix-free keys, and expose `cancel_requested` as bool. `GetTask` adds `latest_attempt` (with bool `retryable`) and `lease`. Missing objects return `(nil, nil)`; empty collections return nonnil empty slices. SQLite integer fields are `int64`, REAL fields `float64`; decoded JSON follows `encoding/json` types.

`ListTasks` filters nonempty status/site, sorts created_at descending, clamps limit to 1..500 and offset to >=0. Queue reads filter due noncancelled queued rows, priority descending then created_at ascending; excluded sites are sorted/deduplicated and capped at 64. Logs/events sort ascending ID; a nonnil tail returns the most recent 1..5000 logs in ascending order and overrides since/limit.

## Task writes

```go
func (r *TaskRepository) CreateTask(ctx context.Context, values map[string]any, idempotencyKey string) (map[string]any, bool, error)
func (r *TaskRepository) MarkTaskCredentialsUnavailable(ctx context.Context, id, site string) (bool, error)
func (r *TaskRepository) ClaimTask(ctx context.Context, id string) (bool, error)
func (r *TaskRepository) BeginAttempt(ctx context.Context, id string) (map[string]any, error)
func (r *TaskRepository) SetProcess(ctx context.Context, taskID, attemptID string, pid int, marker string) error
func (r *TaskRepository) FinishAttempt(ctx context.Context, attemptID string, options FinishAttemptOptions) error
func (r *TaskRepository) CompleteTask(ctx context.Context, id, status string, options CompleteTaskOptions) (map[string]any, error)
func (r *TaskRepository) RequeueTask(ctx context.Context, id string, options RequeueTaskOptions) (bool, error)
func (r *TaskRepository) RequestCancel(ctx context.Context, id string) (map[string]any, error)
func (r *TaskRepository) RetryTask(ctx context.Context, id string, additionalAttempts int) (map[string]any, error)
func (r *TaskRepository) SetLease(ctx context.Context, taskID, attemptID, nodeID, endpoint, site string) error
func (r *TaskRepository) ClearLease(ctx context.Context, taskID, attemptID string) error
func (r *TaskRepository) UpdateArtifacts(ctx context.Context, id string, count, totalBytes int64) error
func (r *TaskRepository) RecoverIncomplete(ctx context.Context) (int, error)
func (r *TaskRepository) AddEvent(ctx context.Context, id, eventType string, payload map[string]any) error
func (r *TaskRepository) AppendLog(ctx context.Context, taskID string, attemptID *string, stream, line string) (int64, error)
func (r *TaskRepository) AppendLogsBulk(ctx context.Context, rows []LogRow) (int64, error)
func (r *TaskRepository) SetMaxLogsPerTask(maximum int)
```

```go
type FinishAttemptOptions struct {
    Status string
    ExitCode *int
    ErrorClass string
    ErrorMessage string
    Retryable bool
    ProxyNodeID *string
    ProxyEndpoint *string
}
type CompleteTaskOptions struct {
    ExitCode *int
    ErrorClass string
    ErrorMessage string
    ExpectedAttemptID string
}
type RequeueTaskOptions struct {
    NextRunAt float64
    ExitCode *int
    ErrorClass string
    ErrorMessage string
    TriedProxyIDs []string
    ExpectedAttemptID string
}
type LogRow struct {
    TaskID string
    AttemptID *string
    Timestamp float64
    Stream string
    Line string
}
```

- `CreateTask` requires url/site/output_dir/proxy_mode/max_attempts; accepts id, priority, subcategory, extractor, cookies_file, config_file, credentials_ref, extra_args, policy. Empty idempotency key means SQL NULL. The bool is **created**, not duplicate. A hit ignores new values and returns the existing detailed task with attempt and lease. New creation returns the base task projection, preserving the legacy shape.
- `BeginAttempt` returns `{id, attempt_no, task}`. Missing task yields `ErrNotFound`; invalid state yields `ErrInvalidState` (also used by RetryTask/CompleteTask state validation).
- `FinishAttempt` only finishes the attempt; the supervisor still calls CompleteTask/RequeueTask for the task decision. Pass `ExpectedAttemptID` for scheduler callbacks to prevent stale attempts from mutating a newer run. Empty means the legacy unguarded administrative path.
- ClaimTask intentionally follows the old queued/cancel check, not the due timestamp; select due work with QueuedTasks first. ClearLease with empty attempt ID clears any task lease, otherwise only the matching attempt's lease.
- Recovery does not run automatically in Open and does not kill processes. Inspect IncompleteProcesses and safely stop matching orphan processes first. Recovery atomically marks running attempts orphaned, clears leases/process fields, and chooses cancelled/queued/failed using cancellation and attempt budget.
- Manual retry preserves attempt history and sets budget to prior attempts + max(1,additionalAttempts), resetting backoff anchor to the prior count.
- Events/logs/errors are redacted before persistence. Authorization scheme credentials are redacted before header masking (fixing the legacy order's token exposure). Typed nested Go JSON payloads are normalized before redaction.
- Default log retention is 5000/task, minimum configurable retention 100. Legacy threshold pruning is preserved; retention may temporarily exceed the target by up to one-quarter between prunes. Batch insertion/pruning is atomic and counters publish only after commit.

## Site policies

```go
func (s *Store) ListSitePolicies(ctx context.Context) ([]map[string]any, error)
func (s *Store) GetSitePolicy(ctx context.Context, site string) (map[string]any, error)
func (s *Store) PutSitePolicy(ctx context.Context, site string, policy map[string]any) (map[string]any, error)
func (s *Store) DeleteSitePolicy(ctx context.Context, site string) (bool, error)
```

Policy field validation/normalization belongs to the policy handler. Store parameterizes UPSERT and reads the result in the same write transaction. Lists sort by site. Projections are `{site, policy, updated_at}`. Invalid stored JSON returns an error, never a fallback empty policy. Missing Get returns nil; Delete bool means an existing row was deleted.

## Verification

Run `go test -race ./internal/store` from `backend/`. Coverage includes native initialization, temporary legacy v18 database reopening, exact full-schema columns/indexes/foreign keys against the old initializer, task lifecycle JSON trace parity, additive migration fixtures, explicit incompatible/future/invalid-schema rejection with rollback, FTS queries, query-only/WAL/foreign keys, path security, concurrent idempotency/claim/logs, stale attempts, cancellation/retry/recovery, atomic event failure rollback, log pruning and policy reads/writes.

The only Python invocation is the test-only `testdata/legacy_fixture.py` oracle, which imports the old schema/task repository against a Go-owned temporary file. Production does not import or execute Python. This is focused compatibility verification, not the entire legacy Python suite. No GUI/browser is started.
