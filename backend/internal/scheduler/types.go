package scheduler

import (
	"context"
	"errors"
	"time"

	"ldos/backend/internal/store"
)

// Repository is the native persistence contract; writes commit before returning.
type Repository interface {
	GetTask(context.Context, string) (map[string]any, error)
	QueuedTasks(context.Context, int, []string) ([]map[string]any, error)
	QueuedTaskIDs(context.Context, []string) (map[string]struct{}, error)
	IncompleteProcesses(context.Context) ([]map[string]any, error)
	RecoverIncomplete(context.Context) (int, error)
	MarkTaskCredentialsUnavailable(context.Context, string, string) (bool, error)
	ClaimTask(context.Context, string) (bool, error)
	BeginAttempt(context.Context, string) (map[string]any, error)
	SetProcess(context.Context, string, string, int, string) error
	FinishAttempt(context.Context, string, store.FinishAttemptOptions) error
	CompleteTask(context.Context, string, string, store.CompleteTaskOptions) (map[string]any, error)
	RequeueTask(context.Context, string, store.RequeueTaskOptions) (bool, error)
	RequestCancel(context.Context, string) (map[string]any, error)
	RetryTask(context.Context, string, int) (map[string]any, error)
	TaskCrawlBatchID(context.Context, string) (string, error)
	ProbeNodeIDs(context.Context, string) ([]string, error)
	SetLease(context.Context, string, string, string, string, string) error
	ClearLease(context.Context, string, string) error
	UpdateArtifacts(context.Context, string, int64, int64) error
	AppendLogsBulk(context.Context, []store.LogRow) (int64, error)
}

type RunRequest struct {
	URL, OutputDir, Site                    string
	CookiesFile, ConfigFile, CredentialsRef string
	ProxyURL                                string
	Policy                                  Policy
	ExtraArgs                               []string
	OnLine                                  func(stream, line string) error
	OnStarted                               func(pid int, marker string) error
}

type RunResult struct {
	ExitCode   *int
	OutputTail string
	TimedOut   bool
}

// Runner owns the child until it and its output readers have stopped. Cancelling
// ctx must terminate and reap the process, not only abandon its result.
type Runner interface {
	Run(context.Context, string, RunRequest) (RunResult, error)
}

type ProxyRequest struct {
	TaskID                           string
	NodeTags, ExcludeIDs, AllowedIDs []string
	ProbeBeforeUse                   bool
	ProbeURL                         *string
}
type Lease struct{ NodeID, Name, Protocol, Endpoint string }

var ErrPoolUnavailable = errors.New("proxy core unavailable")
var ErrCrawlOwned = errors.New("task belongs to crawl")

// Acquire must release any acquired lease before returning a context error.
// An unavailable core returns ErrPoolUnavailable, never (nil,nil).
type ProxyPool interface {
	Acquire(context.Context, ProxyRequest) (*Lease, error)
	Release(context.Context, string, bool, string) error
}

type Dependencies struct {
	Runner                Runner
	Proxy                 ProxyPool
	ValidateCredentials   func(context.Context, string, string) (bool, error)
	InvalidateCredentials func(context.Context, string, string, string) (bool, error)
	TerminateStale        func(context.Context, int, string) error
}

type Settings struct {
	MaxConcurrent   int
	PollInterval    time.Duration
	ShutdownGrace   time.Duration
	RetryJitter     float64
	RetryBackoffCap float64
}

func DefaultSettings() Settings {
	return Settings{MaxConcurrent: 20, PollInterval: 500 * time.Millisecond, ShutdownGrace: 15 * time.Second, RetryJitter: 0.5, RetryBackoffCap: 300}
}

// ConfigurationError marks missing/invalid worker configuration as nonretryable.
type ConfigurationError struct{ Err error }

func (e ConfigurationError) Error() string { return e.Err.Error() }
func (e ConfigurationError) Unwrap() error { return e.Err }

func stringField(row map[string]any, key string) string { value, _ := row[key].(string); return value }
func intField(row map[string]any, key string) int {
	switch value := row[key].(type) {
	case int64:
		return int(value)
	case int:
		return value
	case float64:
		return int(value)
	}
	return 0
}
func boolField(row map[string]any, key string) bool { value, _ := row[key].(bool); return value }
func stringsField(row map[string]any, key string) []string {
	if values, ok := row[key].([]string); ok {
		return values
	}
	result := []string{}
	if values, ok := row[key].([]any); ok {
		for _, value := range values {
			if text, ok := value.(string); ok {
				result = append(result, text)
			}
		}
	}
	return result
}
