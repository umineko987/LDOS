# Managed credential core (Linux)

Native Go storage, status, export and invalidation of managed cookies and auth
metadata. Browser/session orchestration lives in `internal/authorization` and
`internal/authbrowser`; Pixiv OAuth/cache lives in `internal/pixivauth`. These
packages are mounted by the Go development service without a Python auth process.

## Integration API

```go
func New(managedDir string) (*Store, error)
func (*Store) CookiesFor(ctx context.Context, site string) (string, error)
func (*Store) Available(ctx context.Context, site, cookiesFile string) (bool, error)
func (*Store) Invalidate(ctx context.Context, site, cookiesFile, message string) (bool, error)
func (*Store) Snapshot(ctx context.Context, site string) (CookieStatus, map[string]any, error)
func (*Store) SaveCookies(ctx context.Context, site string, data []byte, fields map[string]any) error
func (*Store) SetMetadata(ctx context.Context, key string, fields map[string]any) error
func (*Store) Clear(ctx context.Context, site string) error
```

- Pass `allowed_cookie_roots[0]/managed` itself to `New`. It uses
  `twitter.cookies.txt`, `exhentai.cookies.txt`, and `auth-metadata.json`.
  No `Close` is needed; each operation closes its descriptors.
- Normalize surrounding whitespace/case and aliases `x`, `eh`, `e-hentai`.
- `CookiesFor`: only Twitter (`auth_token`, `ct0`) and EH (`ipb_member_id`,
  `ipb_pass_hash`). Missing/malformed cookies, missing required names, truthy
  `metadata[site].invalidated_at`, and unsupported sites return `"", nil`.
  Present cookies trigger full-file validation; later malformed records cannot
  be ignored after the required names are found. No expiry, domain relevance,
  nonempty-value, or remote authentication check is added.
- `Available`: validate only this site's managed cookie path. Empty paths, other
  sites, and external credentials return `true, nil` without opening/chmodding
  external files or reading managed metadata. This is intentionally not a
  general credential validator. Path identity supports relative paths and
  missing leaves, like `Path.resolve(strict=False)`. Managed symlinks, including
  external aliases resolving to the managed export, are rejected, not bypassed.
- `Invalidate`: caller must already classify an authentication failure. Only
  this site's own export is eligible, even if currently missing/malformed.
  Case-insensitive substrings excluded: `tweets are protected`,
  `has blocked your account`, `blocked your account`,
  `insufficient privileges to access this endpoint`, `temporarily banned`,
  `gallery not available`. Return `false, nil` for external/unsupported/excluded
  calls; `true, nil` only after committing metadata.
- Authorization calls use canonical site names. `Snapshot` reads parsed cookie
  status and site metadata under one lock. `SaveCookies` writes the export before
  replacing that site's metadata; a successful login removes old invalidation.
  `Clear` removes only the site's export/metadata, preserving other sites, proxy
  settings and browser profiles. `SetMetadata` also stores the private runtime
  authorization proxy override.
- Preserve unrelated sites, arbitrary fields, and JSON number precision. Update
  only `method=managed_browser`, `browser=project_chrome`, Unix-seconds
  `invalidated_at`, `invalid_reason=登录凭证失效`. Worker messages are used solely
  for exclusions: never stored, returned, or logged.
- Errors are safe sentinels (`ErrUnsafePath`, `ErrStorage`,
  `ErrInvalidMetadata`) or standard context cancellation/deadline errors; they
  never wrap filesystem paths, cookie contents, JSON excerpts, or worker text.
  Callers must not convert errors into unconditional availability/success.

## Compatibility and security boundaries

Behavior was checked against `gdl_backend/auth.py` credential/status/metadata
methods, `file_security.py`, and CPython 3.14
`http.cookiejar.MozillaCookieJar._really_load` / `Cookie.__init__`. Netscape
loading follows the actual loader, not a generic whitespace parser: header
magic, seven tab fields, `#HttpOnly_`, comments/blank lines, trailing empty
values, domain-dot assertion, nameless cookies, duplicates, numeric expiry
conversion, and universal newlines. Expired/session cookies remain eligible
(`ignore_discard=True`, `ignore_expires=True`). Some surprising accepted flag
and numeric forms deliberately mirror MozillaCookieJar.

Intentional safety constraints versus the Python implementation:

- UTF-8 required; metadata is strict JSON with an object root, maximum 1 MiB.
  Invalid/non-object/oversized metadata errors rather than silently replacing
  it with `{}`. Invalidation leaves those bytes unchanged. Non-object *site*
  entries retain Python's empty-site interpretation; nonstandard `NaN` and
  `Infinity` JSON are rejected. Metadata is read after cookie validity for
  `CookiesFor`, and always before a non-excluded invalidation.
- Cookie file maximum 8 MiB; line content maximum 64 KiB (excluding newline).
  Oversized/malformed/non-UTF-8 cookies are unavailable.
- Managed directories are 0700; managed files/temp files are 0600. New parent
  directories are private; permissions on existing ancestor directories are
  not changed. Reject symlinks in every managed path component, dangling
  symlinks, special files, and multiply linked files.
- Linux `openat`/`O_NOFOLLOW` with directory descriptors prevents symlink
  redirection of reads/chmod/writes. Same-directory exclusive temporary files,
  file sync, atomic rename, and directory sync implement replacement. A sync
  failure after rename can report an error after the change became visible.
- A directory-inode flock serializes operations across cooperating Go Store
  instances/processes; lock waiting honors context cancellation. Legacy Python
  writers and arbitrary external writers do **not** participate in this lock.
  Do not concurrently run two credential owners. Returned cookie paths are not
  immutable handles or a guarantee of successful worker authentication.
- No mtime-only cache: rewrites and invalidation changes are observed on each
  call. No file contents are read outside a caller-supplied managed directory.

## Focused verification

All fixtures are generated in `t.TempDir()`; no real credentials, browser, GUI,
network, or Python runtime are involved. From `backend/`:

```sh
go test -race -count=1 ./internal/credentials
go vet ./internal/credentials
```

Tests cover parser edge cases and bounds, aliases, expiry ignoring, invalidation
truthiness, preserved multi-site metadata/numbers, exclusions, external-file
pass-through, redaction, atomic replacement, concurrent stores, permissions,
symlinks/hard links/special files, and cancellation during lock contention.
