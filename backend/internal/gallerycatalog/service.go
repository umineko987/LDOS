// Package gallerycatalog owns the native v18 gallery catalog and its managed files.
// It is independent of internal/gallery, which only executes gallery-dl.
package gallerycatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

type Row = map[string]any

type Dependencies struct {
	Store    *store.Store
	Settings config.Settings
	Jobs     *activity.Registry
}

// Error exposes a stable code. Filesystem/SQL error strings never cross HTTP.
type Error struct {
	Code    string
	Status  int
	Details Row
	Cause   error
}

func (e *Error) Error() string               { return e.Code }
func (e *Error) Unwrap() error               { return e.Cause }
func failure(code string, status int) *Error { return &Error{Code: code, Status: status} }
func errorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if errors.Is(err, context.Canceled) {
		return "scan_interrupted"
	}
	return "io_error"
}

type Service struct {
	db                *store.Store
	settings          config.Settings
	jobs              *activity.Registry
	ctx               context.Context
	cancel            context.CancelFunc
	mu                sync.Mutex
	started, stopping bool
	wg                sync.WaitGroup
	scans             map[string]Row
	exports           map[string]*exportOperation
	targets           map[string]string
	idempotency       map[string]idempotentExport
	locks             *FilesystemLocks
	hashQueue         chan string
	hashPending       map[string]bool
	scanListeners     []func(string)
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil {
		return nil, errors.New("gallerycatalog: Store is required")
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Service{db: deps.Store, settings: deps.Settings, jobs: deps.Jobs, ctx: ctx, cancel: cancel,
		scans: map[string]Row{}, exports: map[string]*exportOperation{}, targets: map[string]string{}, idempotency: map[string]idempotentExport{}, locks: NewFilesystemLocks(), hashQueue: make(chan string, 8192), hashPending: map[string]bool{}}
	return s, nil
}

func (s *Service) Start() error {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return failure("service_stopping", 503)
	}
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.started = true
	s.mu.Unlock()
	if _, err := s.Recover(s.ctx); err != nil {
		s.mu.Lock()
		s.started = false
		s.mu.Unlock()
		return err
	}
	if err := s.RecoverReconciliations(s.ctx); err != nil {
		s.mu.Lock()
		s.started = false
		s.mu.Unlock()
		return err
	}
	if !s.launch(s.hashWorker) {
		return failure("service_stopping", 503)
	}
	return nil
}
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	for _, op := range s.exports {
		op.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *Service) launch(fn func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return false
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); fn() }()
	return true
}

// FilesystemLocks serializes all native readers/writers that require a stable
// source tree. Callers must acquire all keys at once, in particular cross-source
// moves. The release function must be called before calling another locking API.
type FilesystemLocks struct {
	mu    sync.Mutex
	locks map[string]chan struct{}
}

func NewFilesystemLocks() *FilesystemLocks {
	return &FilesystemLocks{locks: map[string]chan struct{}{}}
}
func (l *FilesystemLocks) Hold(ctx context.Context, keys ...string) (func(), error) {
	keys = unique(keys)
	sort.Strings(keys)
	held := []chan struct{}{}
	release := func() {
		for i := len(held) - 1; i >= 0; i-- {
			<-held[i]
		}
	}
	for _, key := range keys {
		l.mu.Lock()
		ch := l.locks[key]
		if ch == nil {
			ch = make(chan struct{}, 1)
			l.locks[key] = ch
		}
		l.mu.Unlock()
		select {
		case ch <- struct{}{}:
			held = append(held, ch)
		case <-ctx.Done():
			release()
			return nil, ctx.Err()
		}
	}
	return release, nil
}
func (s *Service) FilesystemLocks() *FilesystemLocks { return s.locks }

type sourceScopeKey struct{}
type sourceScope struct {
	owner  *FilesystemLocks
	ids    map[string]bool
	active bool
	mu     sync.Mutex
}

func (s *Service) sourceScope(ctx context.Context, ids []string) (bool, error) {
	scope, _ := ctx.Value(sourceScopeKey{}).(*sourceScope)
	if scope == nil || scope.owner != s.locks {
		return false, nil
	}
	scope.mu.Lock()
	defer scope.mu.Unlock()
	if !scope.active {
		return false, nil
	}
	for _, sid := range ids {
		if !scope.ids[sid] {
			return false, failure("source_lock_scope_expansion", 409)
		}
	}
	return true, nil
}
func (s *Service) LockSources(ctx context.Context, ids ...string) (func(), error) {
	if held, e := s.sourceScope(ctx, ids); held || e != nil {
		return func() {}, e
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = "source:" + id
	}
	return s.locks.Hold(ctx, keys...)
}

// WithSources gives nested synchronous callbacks a private, lifetime-bound lock
// ownership token. Acquire the complete source set before invoking the callback;
// widening a held scope is rejected to preserve deterministic lock ordering.
func (s *Service) WithSources(ctx context.Context, ids []string, fn func(context.Context) error) error {
	if held, e := s.sourceScope(ctx, ids); e != nil {
		return e
	} else if held {
		return fn(ctx)
	}
	release, e := s.LockSources(ctx, ids...)
	if e != nil {
		return e
	}
	defer release()
	scope := &sourceScope{owner: s.locks, ids: map[string]bool{}, active: true}
	for _, sid := range ids {
		scope.ids[sid] = true
	}
	defer func() { scope.mu.Lock(); scope.active = false; scope.mu.Unlock() }()
	return fn(context.WithValue(ctx, sourceScopeKey{}, scope))
}
func (s *Service) AddScanListener(fn func(string)) {
	s.mu.Lock()
	s.scanListeners = append(s.scanListeners, fn)
	s.mu.Unlock()
}

func now() float64               { return float64(time.Now().UnixNano()) / 1e9 }
func str(m Row, k string) string { v, _ := m[k].(string); return v }
func number(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case bool:
		if x {
			return 1
		}
	}
	return 0
}
func num(m Row, k string) int64  { return number(m[k]) }
func truth(m Row, k string) bool { return number(m[k]) != 0 }
func clone(m Row) Row {
	out := Row{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func jsonText(v any) string { b, _ := json.Marshal(v); return string(b) }
func unique(a []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range a {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }
func asArgs(a []string) []any {
	r := make([]any, len(a))
	for i, v := range a {
		r[i] = v
	}
	return r
}
func id() string { return uuid.NewString() }

var galleryNamespace = uuid.NewSHA1(uuid.NameSpaceURL, []byte("ldos:gallery"))

func AssetID(sourceID, relativePath string) string {
	return uuid.NewSHA1(galleryNamespace, []byte("asset:"+sourceID+":"+relativePath)).String()
}
func DirectoryID(sourceID, relativePath string) string {
	return uuid.NewSHA1(galleryNamespace, []byte("directory:"+sourceID+":"+relativePath)).String()
}
func reconciliationID(sourceID, batchID string) string {
	return uuid.NewSHA1(galleryNamespace, []byte("review-reconciliation:"+sourceID+":"+batchID)).String()
}
func (s *Service) exec(ctx context.Context, q string, args ...any) error {
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(ctx, q, args...); return e })
}
func jobMessage(err error) string {
	if err == nil {
		return ""
	}
	return errorCode(err)
}
func (s *Service) finishJob(id string, err error, current int) {
	if s.jobs == nil {
		return
	}
	message := jobMessage(err)
	status := activity.StatusSucceeded
	if err != nil {
		status = activity.StatusFailed
	}
	if errors.Is(err, context.Canceled) {
		status = activity.StatusCancelled
	}
	_, _ = s.jobs.Finish(id, activity.FinishOptions{Status: status, Message: &message, Current: &current, Total: &current})
}
func (s *Service) progressJob(id string, current int, total *int) {
	if s.jobs != nil {
		_, _ = s.jobs.Update(id, activity.UpdateOptions{Current: &current, Total: total})
	}
}
func checkRows(r sql.Result, err error, code string) error {
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return failure(code, http.StatusConflict)
	}
	return nil
}
func wrapIO(err error, code string) error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return err
	}
	return &Error{Code: code, Status: 409, Cause: err}
}
func textError(code string, value any) *Error {
	return &Error{Code: code, Status: 422, Details: Row{"value": fmt.Sprint(value)}}
}
