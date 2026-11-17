package activity

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
)

func ptr[T any](value T) *T { return &value }

func newTestRegistry() (*Registry, *Bus, *float64) {
	bus := NewBus(0)
	registry := NewRegistry(bus)
	now := 1000.0
	registry.clock = func() float64 { return now }
	return registry, bus, &now
}

func startJob(t *testing.T, registry *Registry, kind, title string, opts ...StartOptions) *Job {
	t.Helper()
	job, err := registry.Start(kind, title, opts...)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func updateJob(t *testing.T, registry *Registry, id string, opts UpdateOptions) *Job {
	t.Helper()
	job, err := registry.Update(id, opts)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func publishedJobs(t *testing.T, bus *Bus) []Job {
	t.Helper()
	events, complete := bus.EventsAfter(0)
	if !complete {
		t.Fatal("test exceeded buffer")
	}
	jobs := make([]Job, 0, len(events))
	for _, event := range events {
		if event.Kind != JobEvent {
			t.Fatalf("unexpected event %s", event.Kind)
		}
		var payload struct {
			Job Job `json:"job"`
		}
		if err := json.Unmarshal(event.Data, &payload); err != nil {
			t.Fatal(err)
		}
		jobs = append(jobs, payload.Job)
	}
	return jobs
}

func TestRegistryLifecycleAndShape(t *testing.T) {
	registry, bus, now := newTestRegistry()
	job := startJob(t, registry, "tagger.tag", "打标 3 张", StartOptions{ID: "tagger:1", Total: ptr(3), Ref: map[string]string{"dataset_id": "d1"}})
	payload, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var shape map[string]any
	if err := json.Unmarshal(payload, &shape); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(shape))
	for key := range shape {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	want := []string{"current", "finished_at", "id", "kind", "message", "ref", "started_at", "status", "title", "total", "updated_at"}
	if !reflect.DeepEqual(keys, want) || shape["current"] != nil || shape["finished_at"] != nil {
		t.Fatalf("unexpected shape %s", payload)
	}
	*now += 5
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(1)})
	*now += 5
	finished, err := registry.Finish(job.ID, FinishOptions{Current: ptr(3)})
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != StatusSucceeded || finished.FinishedAt == nil || *finished.FinishedAt != *now || registry.HasActive() {
		t.Fatalf("unexpected final state %+v", finished)
	}
	jobs := publishedJobs(t, bus)
	if len(jobs) != 3 || jobs[0].Status != StatusRunning || jobs[1].Status != StatusRunning || jobs[2].Status != StatusSucceeded {
		t.Fatalf("unexpected lifecycle %+v", jobs)
	}
	if jobs[0].Current != nil {
		t.Fatal("later updates changed an earlier event")
	}
}

func TestRegistryThrottlesProgressAndFlushesLatest(t *testing.T) {
	registry, bus, now := newTestRegistry()
	job := startJob(t, registry, "gallery.export", "导出", StartOptions{Total: ptr(100)})
	*now += 0.1
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(10)})
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(20), Message: ptr("dir-a")})
	if len(publishedJobs(t, bus)) != 1 || !registry.HasPendingPublish() {
		t.Fatal("progress was not throttled")
	}
	if registry.Flush() != 1 || registry.HasPendingPublish() || registry.Flush() != 0 {
		t.Fatal("flush did not clear dirty state")
	}
	jobs := publishedJobs(t, bus)
	if *jobs[1].Current != 20 || jobs[1].Message != "dir-a" || jobs[1].UpdatedAt != *now {
		t.Fatalf("flush did not publish latest state: %+v", jobs[1])
	}
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(100)})
	updateJob(t, registry, job.ID, UpdateOptions{Status: StatusFailed, Message: ptr("disk_full")})
	jobs = publishedJobs(t, bus)
	if len(jobs) != 4 || *jobs[2].Current != 100 || jobs[3].Status != StatusFailed {
		t.Fatalf("immediate publish missing: %+v", jobs)
	}
}

func TestRegistryPublishIntervalAndSignificantFields(t *testing.T) {
	registry, bus, now := newTestRegistry()
	job := startJob(t, registry, "gallery.scan", "扫描", StartOptions{Current: ptr(0)})
	*now += 0.25
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(1)})
	if len(publishedJobs(t, bus)) != 2 {
		t.Fatal("250ms progress boundary was not published")
	}
	for index, update := range []UpdateOptions{
		{Title: ptr("扫描 A")}, {Total: ptr(20)}, {Ref: map[string]string{"source_id": "s1"}}, {Status: StatusQueued},
	} {
		updateJob(t, registry, job.ID, update)
		if len(publishedJobs(t, bus)) != index+3 {
			t.Fatalf("significant update %d was throttled", index)
		}
	}
	updateJob(t, registry, job.ID, UpdateOptions{Title: ptr(""), Ref: map[string]string{}})
	if state := registry.Get(job.ID); state.Title != "" || len(state.Ref) != 0 {
		t.Fatalf("clear failed: %+v", state)
	}
}

func TestRegistryNoopUnknownAndInvalidStatus(t *testing.T) {
	registry, bus, now := newTestRegistry()
	job := startJob(t, registry, "gallery.scan", "扫描")
	*now += 10
	state := updateJob(t, registry, job.ID, UpdateOptions{Message: ptr(""), Status: StatusRunning})
	if len(publishedJobs(t, bus)) != 1 || state.UpdatedAt != job.UpdatedAt {
		t.Fatal("no-op modified state")
	}
	if job, err := registry.Update("missing", UpdateOptions{Current: ptr(1)}); err != nil || job != nil {
		t.Fatal("unknown update must be nil")
	}
	if job, err := registry.Finish("missing"); err != nil || job != nil {
		t.Fatal("unknown finish must be nil")
	}
	if registry.Get("missing") != nil {
		t.Fatal("unknown get must be nil")
	}
	if _, err := registry.Start("x", "x", StartOptions{Status: "exploded"}); err == nil {
		t.Fatal("invalid start status accepted")
	}
	if _, err := registry.Update("missing", UpdateOptions{Status: "exploded"}); err == nil {
		t.Fatal("invalid update status accepted")
	}
	if _, err := registry.Finish(job.ID, FinishOptions{Status: StatusRunning}); err == nil {
		t.Fatal("nonterminal finish accepted")
	}
}

func TestRegistryListPrunesAndRestarts(t *testing.T) {
	registry, _, now := newTestRegistry()
	registry.retainFinished = 2
	for index := range 4 {
		startJob(t, registry, "crawl.batch", fmt.Sprintf("b%d", index), StartOptions{ID: fmt.Sprintf("crawl:%d", index)})
		*now++
	}
	for index := range 3 {
		if _, err := registry.Finish(fmt.Sprintf("crawl:%d", index)); err != nil {
			t.Fatal(err)
		}
		*now++
	}
	listed := registry.List()
	ids := make([]string, 0, len(listed))
	for _, job := range listed {
		ids = append(ids, job.ID)
	}
	if !reflect.DeepEqual(ids, []string{"crawl:3", "crawl:2", "crawl:1"}) || registry.Get("crawl:0") != nil {
		t.Fatalf("unexpected retained order %v", ids)
	}
	if !reflect.DeepEqual(registry.ActiveIDs("crawl."), []string{"crawl:3"}) || len(registry.ActiveIDs("tagger.")) != 0 {
		t.Fatal("active prefix filter failed")
	}
	restarted := startJob(t, registry, "crawl.batch", "restart", StartOptions{ID: "crawl:1"})
	if restarted.Status != StatusRunning || restarted.FinishedAt != nil || restarted.Message != "" || restarted.StartedAt != *now {
		t.Fatalf("restart did not reset %+v", restarted)
	}
	if got := registry.List(); got[0].ID != "crawl:3" || got[1].ID != "crawl:1" {
		t.Fatalf("active sort failed: %+v", got)
	}
}

func TestRegistryDefaultRetentionAndStableTies(t *testing.T) {
	registry, _, _ := newTestRegistry()
	for index := range 202 {
		startJob(t, registry, "x", "done", StartOptions{ID: fmt.Sprintf("job:%03d", index), Status: StatusSucceeded})
	}
	startJob(t, registry, "x", "active", StartOptions{ID: "active"})
	jobs := registry.List()
	if len(jobs) != 201 || jobs[0].ID != "active" || jobs[1].ID != "job:002" || registry.Get("job:001") != nil {
		t.Fatalf("default retention/tie order failed: count=%d, first=%+v", len(jobs), jobs[:2])
	}
}

func TestRegistrySnapshotsAndCountNormalization(t *testing.T) {
	registry, bus, _ := newTestRegistry()
	current, total := -1, 4
	ref := map[string]string{"dataset_id": "original"}
	job := startJob(t, registry, "x", "x", StartOptions{Current: &current, Total: &total, Ref: ref})
	if *job.Current != 0 || !strings.HasPrefix(job.ID, "x:") || len(job.ID) != 14 {
		t.Fatalf("defaults failed: %+v", job)
	}
	current, total, ref["dataset_id"] = 99, 99, "changed"
	*job.Current, *job.Total, job.Ref["dataset_id"] = 77, 77, "returned"
	listed := registry.List()
	listed[0].Ref["dataset_id"] = "listed"
	state := registry.Get(job.ID)
	if *state.Current != 0 || *state.Total != 4 || state.Ref["dataset_id"] != "original" {
		t.Fatalf("mutable state escaped: %+v", state)
	}
	if first := publishedJobs(t, bus)[0]; *first.Total != 4 || first.Ref["dataset_id"] != "original" {
		t.Fatal("event snapshot changed")
	}
	updateJob(t, registry, job.ID, UpdateOptions{Current: ptr(-2), Total: ptr(-5)})
	if state := registry.Get(job.ID); *state.Total != 0 || *state.Current != 0 {
		t.Fatal("negative counts not clamped")
	}
}

func TestRegistryConcurrentReadsUpdatesAndFlush(t *testing.T) {
	bus := NewBus(0)
	registry := NewRegistry(bus)
	var workers sync.WaitGroup
	for worker := range 4 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			job, err := registry.Start("scan", "scan", StartOptions{ID: fmt.Sprintf("scan:%d", worker), Total: ptr(50)})
			if err != nil {
				t.Error(err)
				return
			}
			for index := range 50 {
				if _, err := registry.Update(job.ID, UpdateOptions{Current: ptr(index + 1)}); err != nil {
					t.Error(err)
				}
				registry.List()
				registry.Get(job.ID)
				registry.HasActive()
				registry.HasPendingPublish()
				registry.Flush()
			}
			if _, err := registry.Finish(job.ID); err != nil {
				t.Error(err)
			}
		}()
	}
	workers.Wait()
	if registry.HasActive() || registry.HasPendingPublish() || len(registry.List()) != 4 {
		t.Fatal("concurrent operations lost final state")
	}
}
