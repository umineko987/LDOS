# Managed proxy sources

`Store` is the Go port of `gdl_backend/proxy_source_store.py`. `New` freezes the supplied configuration baseline and uses `<runtimeDir>/proxy/managed-sources.json` (version 1) for a complete runtime override. Empty overrides retain `source=runtime`.

`Snapshot` falls back to the frozen baseline when the override is corrupt or unsafe, with `HasRuntimeOverride=true` and `RuntimeOverrideValid=false`. Mutations reject that override; `ResetOverride` can remove a corrupt regular file, but rejects symlinks and non-regular targets. Snapshot slices are copied and formatted snapshots omit private source values.

Mutations validate the complete candidate, compare the raw-file SHA-256 token, and atomically replace a same-directory 0600 temporary file under a 0700 directory. The mutex linearizes callers of one store; the file token provides optimistic detection of external changes, including whitespace-only edits. It is not an interprocess transaction lock. All directory components are opened with descriptor-relative `O_NOFOLLOW`; node files also have bounded reads, regular-file checks, and strict UTF-8 decoding.

`SetNodeFile` resolves relative paths against `projectDir` and enforces `AllowedNodeRoots`. Existing configured node files retain the original compatibility exception: complete-state validation reads them without the API allowlist, while still rejecting symlinks. `ReadNodeFile(path, nil)` has that same behavior; an explicitly empty roots slice rejects all paths.

`PublicSnapshot` is the public projection. Raw snapshots contain secrets and must not be serialized directly to an API. Projection omits URL userinfo/path/query/fragment, node credentials and transport configuration, sanitizes names with NFKC and secret masking, and displays relative or basename-only file paths. Full source IDs and configured revisions use the original versioned SHA-256 prefixes and Python-compatible canonical JSON. Approved x/net IDNA transitional mapping retains legacy mappings such as `ß` to `ss`; the common Unicode host cases have Python golden fixtures.

## Errors

All returned operational errors support `errors.As(err, &sourceError)` with `var sourceError *proxysources.Error`. `Error()` and the fields exposed for API errors contain safe messages and reasons, never raw sources or filesystem error text.

| Category | Code | Typical Reason |
| --- | --- | --- |
| `corrupt` | `proxy_sources_store_error` | `invalid_json`, `invalid_structure`, `unsupported_version`, `invalid_updated_at`, `invalid_source_value`, `invalid_node_file_value`, `invalid_target`, `too_large`, `read_failed` |
| `conflict` | `proxy_sources_store_error` | `external_change`, `opaque_id_collision` |
| `not_found` | `proxy_source_not_found` | `not_found` |
| `path_forbidden` | `proxy_source_path_forbidden` | `outside_allowed_roots`, `symlink`, `managed_path_forbidden`, `managed_path_symlink`, `managed_target_not_file` |
| `validation` | `invalid_proxy_subscription` | `empty`, `too_long`, `control_character`, `malformed`, `unsupported_scheme`, `too_many` |
| `validation` | `invalid_proxy_inline_node` | `empty`, `too_long`, `control_character`, `unsupported_or_empty`, `too_many`, `total_too_large` |
| `validation` | `invalid_proxy_node_file` | `invalid_path`, `unavailable`, `not_regular`, `too_large`, `invalid_encoding`, `empty_parse` |
| `validation` | `invalid_proxy_source_id` | `invalid_source_id` |
| `store_error` | `proxy_sources_store_error` | `write_failed`, `delete_failed` |

`Details` contains `reason` and, for an invalid batch node, its zero-based `index`; `Index` also exposes the latter directly. Unlike Python's validation-only category, Go's `Category` consistently identifies the error class, while `Code` identifies the invalid input kind.

## Verification and scope

The 17 offline test functions in `store_test.go` cover baseline/override/reset, subscription and inline CRUD, v1 schema rejection, private atomic writes, safe errors/projections, Python ID/revision fixtures, Unicode normalization, node-file allowlists/BOM/size/encoding/FIFO rejection, intermediate/leaf/broken symlinks, external changes, and concurrent mutations. All filesystem fixtures use `t.TempDir()`.

From `backend/`, with the Go toolchain on PATH:

```sh
GOPROXY=off go test -race -count=1 ./internal/proxysources
GOPROXY=off go vet ./internal/proxysources
```

Both passed for this implementation. This package implements no HTTP handler, subscription fetching, transport core, proxy pool, or Windows support. It depends on the separately implemented `internal/proxyparse` API and the already approved `golang.org/x/sys`, `golang.org/x/net`, and `golang.org/x/text` modules.
