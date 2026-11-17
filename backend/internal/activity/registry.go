package activity

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
)

type JobStatus string

const (
	StatusQueued    JobStatus = "queued"
	StatusRunning   JobStatus = "running"
	StatusSucceeded JobStatus = "succeeded"
	StatusFailed    JobStatus = "failed"
	StatusCancelled JobStatus = "cancelled"
)

func (s JobStatus) Terminal() bool {
	return s == StatusSucceeded || s == StatusFailed || s == StatusCancelled
}

func (s JobStatus) valid() bool {
	return s == StatusQueued || s == StatusRunning || s.Terminal()
}

// Job is the JSON-compatible projection returned by all registry queries.
// Timestamps are Unix seconds; optional counts/timestamps are JSON null.
type Job struct {
	ID         string            `json:"id"`
	Kind       string            `json:"kind"`
	Title      string            `json:"title"`
	Status     JobStatus         `json:"status"`
	Current    *int              `json:"current"`
	Total      *int              `json:"total"`
	Message    string            `json:"message"`
	Ref        map[string]string `json:"ref"`
	StartedAt  float64           `json:"started_at"`
	UpdatedAt  float64           `json:"updated_at"`
	FinishedAt *float64          `json:"finished_at"`
}

// StartOptions defaults to running with a generated kind:hex ID.
type StartOptions struct {
	ID      string
	Status  JobStatus
	Current *int
	Total   *int
	Message string
	Ref     map[string]string
}

// UpdateOptions leaves nil fields and an empty Status unchanged. A pointer to
// an empty string clears text; a non-nil empty Ref clears all references.
// As in the Python registry, nil counts do not clear existing counts.
type UpdateOptions struct {
	Status  JobStatus
	Current *int
	Total   *int
	Message *string
	Title   *string
	Ref     map[string]string
}

// FinishOptions defaults to succeeded and otherwise preserves existing fields.
type FinishOptions struct {
	Status  JobStatus
	Message *string
	Current *int
	Total   *int
}

type jobState struct {
	job         Job
	publishedAt float64
	dirty       bool
	order       uint64
}

// Registry owns job state and serializes updates with their bus publications.
// Use NewRegistry; callers must not mutate input maps while a call is running.
type Registry struct {
	mu                 sync.Mutex
	bus                *Bus
	jobs               map[string]*jobState
	nextOrder          uint64
	retainFinished     int
	minPublishInterval float64
	clock              func() float64
}

func NewRegistry(bus *Bus) *Registry {
	return &Registry{
		bus:                bus,
		jobs:               make(map[string]*jobState),
		retainFinished:     200,
		minPublishInterval: 0.25,
		clock:              timestamp,
	}
}

// Start accepts one optional options value and resets any existing job with
// the same ID, including terminal jobs. Every start publishes immediately.
func (r *Registry) Start(kind, title string, options ...StartOptions) (*Job, error) {
	var opts StartOptions
	if len(options) > 0 {
		opts = options[0]
	}
	if opts.Status == "" {
		opts.Status = StatusRunning
	}
	if !opts.Status.valid() {
		return nil, fmt.Errorf("unknown job status: %s", opts.Status)
	}
	if opts.ID == "" {
		opts.ID = kind + ":" + randomHex(6)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock()
	r.nextOrder++
	order := r.nextOrder
	if previous := r.jobs[opts.ID]; previous != nil {
		order = previous.order
	}
	state := &jobState{job: Job{
		ID: opts.ID, Kind: kind, Title: title, Status: opts.Status,
		Current: optionalCount(opts.Current), Total: optionalCount(opts.Total),
		Message: opts.Message, Ref: copyRef(opts.Ref), StartedAt: now, UpdatedAt: now,
	}, order: order}
	if opts.Status.Terminal() {
		state.job.FinishedAt = &now
	}
	r.jobs[opts.ID] = state
	r.pruneLocked()
	return r.publishLocked(state), nil
}

// Update returns (nil, nil) for unknown IDs. Invalid statuses return an error
// even for unknown IDs, matching the legacy validation order.
func (r *Registry) Update(id string, opts UpdateOptions) (*Job, error) {
	if opts.Status != "" && !opts.Status.valid() {
		return nil, fmt.Errorf("unknown job status: %s", opts.Status)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.jobs[id]
	if state == nil {
		return nil, nil
	}
	job := &state.job
	significant, changed := false, false
	if opts.Status != "" && opts.Status != job.Status {
		job.Status = opts.Status
		job.FinishedAt = nil
		if opts.Status.Terminal() {
			now := r.clock()
			job.FinishedAt = &now
		}
		significant = true
	}
	if opts.Title != nil && *opts.Title != job.Title {
		job.Title = *opts.Title
		significant = true
	}
	if total := optionalCount(opts.Total); total != nil && !sameCount(total, job.Total) {
		job.Total = total
		significant = true
	}
	if opts.Ref != nil && !maps.Equal(opts.Ref, job.Ref) {
		job.Ref = copyRef(opts.Ref)
		significant = true
	}
	if current := optionalCount(opts.Current); current != nil && !sameCount(current, job.Current) {
		job.Current = current
		changed = true
	}
	if opts.Message != nil && *opts.Message != job.Message {
		job.Message = *opts.Message
		changed = true
	}
	if !significant && !changed {
		return cloneJob(*job), nil
	}
	now := r.clock()
	job.UpdatedAt = now
	if job.Status.Terminal() {
		r.pruneLocked()
	}
	reachedTotal := job.Total != nil && job.Current != nil && *job.Current >= *job.Total
	if significant || reachedTotal || now-state.publishedAt >= r.minPublishInterval {
		return r.publishLocked(state), nil
	}
	state.dirty = true
	return cloneJob(*job), nil
}

// Finish accepts one optional options value. Only terminal statuses are valid.
func (r *Registry) Finish(id string, options ...FinishOptions) (*Job, error) {
	var opts FinishOptions
	if len(options) > 0 {
		opts = options[0]
	}
	if opts.Status == "" {
		opts.Status = StatusSucceeded
	}
	if !opts.Status.Terminal() {
		return nil, fmt.Errorf("not a terminal job status: %s", opts.Status)
	}
	return r.Update(id, UpdateOptions{Status: opts.Status, Message: opts.Message, Current: opts.Current, Total: opts.Total})
}

// Flush publishes all pending progress updates, regardless of elapsed time.
func (r *Registry) Flush() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	dirty := make([]*jobState, 0)
	for _, state := range r.jobs {
		if state.dirty {
			dirty = append(dirty, state)
		}
	}
	slices.SortFunc(dirty, compareOrder)
	for _, state := range dirty {
		r.publishLocked(state)
	}
	return len(dirty)
}

func (r *Registry) Get(id string) *Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	if state := r.jobs[id]; state != nil {
		return cloneJob(state.job)
	}
	return nil
}

// List places active jobs first (oldest start first), followed by terminal
// jobs (latest finish first). Equal timestamps retain insertion order.
func (r *Registry) List() []Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	states := make([]*jobState, 0, len(r.jobs))
	for _, state := range r.jobs {
		states = append(states, state)
	}
	slices.SortFunc(states, func(a, b *jobState) int {
		aDone, bDone := a.job.Status.Terminal(), b.job.Status.Terminal()
		if aDone != bDone {
			if aDone {
				return 1
			}
			return -1
		}
		if aDone {
			if result := compareTime(finishTime(b.job), finishTime(a.job)); result != 0 {
				return result
			}
		} else if result := compareTime(a.job.StartedAt, b.job.StartedAt); result != 0 {
			return result
		}
		return compareOrder(a, b)
	})
	jobs := make([]Job, 0, len(states))
	for _, state := range states {
		jobs = append(jobs, *cloneJob(state.job))
	}
	return jobs
}

func (r *Registry) ActiveIDs(kindPrefix string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0)
	for _, state := range r.jobs {
		if !state.job.Status.Terminal() && strings.HasPrefix(state.job.Kind, kindPrefix) {
			ids = append(ids, state.job.ID)
		}
	}
	slices.Sort(ids)
	return ids
}

func (r *Registry) HasActive() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, state := range r.jobs {
		if !state.job.Status.Terminal() {
			return true
		}
	}
	return false
}

func (r *Registry) HasPendingPublish() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, state := range r.jobs {
		if state.dirty {
			return true
		}
	}
	return false
}

func (r *Registry) publishLocked(state *jobState) *Job {
	state.publishedAt = r.clock()
	state.dirty = false
	job := cloneJob(state.job)
	// This payload contains only JSON-compatible fields owned by the registry.
	r.bus.Publish(JobEvent, struct {
		Job *Job `json:"job"`
	}{job})
	return job
}

func (r *Registry) pruneLocked() {
	finished := make([]*jobState, 0)
	for _, state := range r.jobs {
		if state.job.Status.Terminal() {
			finished = append(finished, state)
		}
	}
	overflow := len(finished) - r.retainFinished
	if overflow <= 0 {
		return
	}
	slices.SortFunc(finished, func(a, b *jobState) int {
		if result := compareTime(finishTime(a.job), finishTime(b.job)); result != 0 {
			return result
		}
		return compareOrder(a, b)
	})
	for _, state := range finished[:overflow] {
		delete(r.jobs, state.job.ID)
	}
}

func compareTime(a, b float64) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func compareOrder(a, b *jobState) int {
	if a.order < b.order {
		return -1
	}
	if a.order > b.order {
		return 1
	}
	return 0
}

func finishTime(job Job) float64 {
	if job.FinishedAt != nil && *job.FinishedAt != 0 {
		return *job.FinishedAt
	}
	return job.UpdatedAt
}

func optionalCount(value *int) *int {
	if value == nil {
		return nil
	}
	n := max(0, *value)
	return &n
}

func sameCount(a, b *int) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func copyRef(ref map[string]string) map[string]string {
	copy := make(map[string]string, len(ref))
	maps.Copy(copy, ref)
	return copy
}

func cloneJob(job Job) *Job {
	job.Current = optionalCount(job.Current)
	job.Total = optionalCount(job.Total)
	job.Ref = copyRef(job.Ref)
	if job.FinishedAt != nil {
		finished := *job.FinishedAt
		job.FinishedAt = &finished
	}
	return &job
}
