package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

var testContext = context.Background()

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "store.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func taskValues(id string) map[string]any {
	return map[string]any{"id": id, "url": "https://example.org/图片", "site": "example", "output_dir": "/tmp/fixture", "proxy_mode": "direct", "max_attempts": 3, "extra_args": []string{"--verbose"}, "policy": map[string]any{"retry": true}}
}

func create(t *testing.T, s *Store, id string) map[string]any {
	t.Helper()
	task, created, err := s.CreateTask(testContext, taskValues(id), "")
	check(t, err)
	if !created {
		t.Fatal("expected created task")
	}
	return task
}

func start(t *testing.T, s *Store, id string) string {
	t.Helper()
	ok, err := s.ClaimTask(testContext, id)
	check(t, err)
	if !ok {
		t.Fatal("claim failed")
	}
	attempt, err := s.BeginAttempt(testContext, id)
	check(t, err)
	return attempt["id"].(string)
}

func get(t *testing.T, s *Store, id string) map[string]any {
	t.Helper()
	task, err := s.GetTask(testContext, id)
	check(t, err)
	return task
}

func equalJSON(t *testing.T, got, want any) {
	t.Helper()
	g, err := json.Marshal(got)
	check(t, err)
	w, err := json.Marshal(want)
	check(t, err)
	var gn, wn any
	check(t, json.Unmarshal(g, &gn))
	check(t, json.Unmarshal(w, &wn))
	if !reflect.DeepEqual(gn, wn) {
		t.Fatalf("got %s\nwant %s", g, w)
	}
}

func TestNativeOpenAndConnectionPolicy(t *testing.T) {
	parent := t.TempDir()
	check(t, os.Chmod(parent, 0755))
	s, err := Open(filepath.Join(parent, "private", "db #?.sqlite"))
	check(t, err)
	defer s.Close()
	check(t, s.Ping(testContext))
	for _, name := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
		info, err := os.Stat(name)
		check(t, err)
		if info.Mode().Perm() != 0600 {
			t.Errorf("%s mode %o", name, info.Mode().Perm())
		}
	}
	info, err := os.Stat(parent)
	check(t, err)
	if info.Mode().Perm() != 0755 {
		t.Error("existing parent permissions changed")
	}
	info, err = os.Stat(filepath.Dir(s.path))
	check(t, err)
	if info.Mode().Perm() != 0700 {
		t.Error("new directory is not private")
	}
	var mode string
	check(t, s.writer.QueryRow("PRAGMA journal_mode").Scan(&mode))
	if mode != "wal" {
		t.Fatal(mode)
	}
	if _, err := s.reader.Exec("INSERT INTO meta VALUES ('forbidden','1')"); err == nil {
		t.Fatal("reader accepted write")
	}
	if err := s.AddEvent(testContext, "missing", "test", nil); err == nil {
		t.Fatal("foreign keys disabled")
	}
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO gallery_search_index(asset_id,source_id,file_name,relative_path,txt_content) VALUES ('a','s','photo.jpg','photo.jpg','searchable')`)
		return err
	}))
	rows, err := queryMaps(testContext, s.reader, "SELECT asset_id FROM gallery_search_index WHERE gallery_search_index MATCH ?", "searchable")
	check(t, err)
	if len(rows) != 1 || rows[0]["asset_id"] != "a" {
		t.Fatal(rows)
	}
	check(t, s.Close())
	check(t, s.Close())
	if err = s.Ping(testContext); err == nil {
		t.Fatal("ping accepted closed database")
	}
}

func TestRejectSymlinks(t *testing.T) {
	for _, kind := range []string{"leaf", "parent", "wal", "shm"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "target")
			check(t, os.WriteFile(target, []byte("keep"), 0644))
			path := filepath.Join(dir, "db.sqlite")
			switch kind {
			case "leaf":
				check(t, os.Symlink(target, path))
			case "parent":
				check(t, os.Symlink(dir, filepath.Join(dir, "linked")))
				path = filepath.Join(dir, "linked", "db.sqlite")
			default:
				check(t, os.Symlink(target, path+"-"+kind))
			}
			if s, err := Open(path); err == nil {
				s.Close()
				t.Fatal("accepted symlink")
			}
			info, err := os.Stat(target)
			check(t, err)
			if info.Mode().Perm() != 0644 {
				t.Fatal("followed symlink while chmodding")
			}
		})
	}
}

func TestConcurrentIdempotencyAndClaim(t *testing.T) {
	s := openTestStore(t)
	var created, claimed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Go(func() {
			task, fresh, err := s.CreateTask(testContext, taskValues("same"), "same-key")
			if err != nil {
				t.Error(err)
				return
			}
			if task["id"] != "same" {
				t.Error(task)
			}
			if fresh {
				created.Add(1)
			}
			ok, err := s.ClaimTask(testContext, "same")
			if err != nil {
				t.Error(err)
			}
			if ok {
				claimed.Add(1)
			}
		})
	}
	wg.Wait()
	if created.Load() != 1 || claimed.Load() != 1 {
		t.Fatalf("created %d claimed %d", created.Load(), claimed.Load())
	}
	events, err := s.GetEvents(testContext, "same", 0, 100)
	check(t, err)
	if len(events) != 2 {
		t.Fatal(events)
	}
	attempt, err := s.BeginAttempt(testContext, "same")
	check(t, err)
	check(t, s.SetLease(testContext, "same", attempt["id"].(string), "node", "http://local", "example"))
	duplicate, fresh, err := s.CreateTask(testContext, nil, "same-key")
	check(t, err)
	if fresh || duplicate["latest_attempt"] == nil || duplicate["lease"] == nil {
		t.Fatal(duplicate)
	}
	equalJSON(t, duplicate, get(t, s, "same"))
}

func TestTransactionRollbackAndSnapshot(t *testing.T) {
	s := openTestStore(t)
	create(t, s, "t")
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TRIGGER reject_start BEFORE INSERT ON task_events WHEN NEW.event_type='starting' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`)
		return err
	}))
	if claimed, err := s.ClaimTask(testContext, "t"); err == nil || claimed {
		t.Fatal("claim ignored event failure")
	}
	if get(t, s, "t")["status"] != "queued" {
		t.Fatal("state survived rollback")
	}
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec("DROP TRIGGER reject_start")
		return err
	}))
	sentinel := errors.New("rollback")
	err := s.withWrite(testContext, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE tasks SET status='running' WHERE id='t'"); err != nil {
			return err
		}
		if get(t, s, "t")["status"] != "queued" {
			t.Error("reader saw uncommitted write")
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	ok, err := s.ClaimTask(testContext, "t")
	check(t, err)
	if !ok {
		t.Fatal("writer poisoned by rollback")
	}
	ctx, cancel := context.WithCancel(testContext)
	cancel()
	if _, err := s.ListTasks(ctx, "", "", 10, 0); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestStaleAttemptGuardsAndRecovery(t *testing.T) {
	s := openTestStore(t)
	create(t, s, "t")
	first := start(t, s, "t")
	check(t, s.FinishAttempt(testContext, first, FinishAttemptOptions{Status: "failed", Retryable: true}))
	ok, err := s.RequeueTask(testContext, "t", RequeueTaskOptions{NextRunAt: 0, ExpectedAttemptID: first})
	check(t, err)
	if !ok {
		t.Fatal("requeue failed")
	}
	second := start(t, s, "t")
	check(t, s.SetLease(testContext, "t", second, "node", "http://local", "example"))
	check(t, s.ClearLease(testContext, "t", first))
	check(t, s.SetProcess(testContext, "t", first, 999, "stale"))
	task, err := s.CompleteTask(testContext, "t", "failed", CompleteTaskOptions{ExpectedAttemptID: first})
	check(t, err)
	if task["status"] != "running" || task["pid"] != nil {
		t.Fatal(task)
	}
	ok, err = s.RequeueTask(testContext, "t", RequeueTaskOptions{ExpectedAttemptID: first})
	check(t, err)
	if ok {
		t.Fatal("stale attempt requeued task")
	}
	if get(t, s, "t")["lease"] == nil {
		t.Fatal("stale callback cleared lease")
	}
	_, err = s.RequestCancel(testContext, "t")
	check(t, err)
	ok, err = s.RequeueTask(testContext, "t", RequeueTaskOptions{ExpectedAttemptID: second})
	check(t, err)
	if ok {
		t.Fatal("requeued cancelled task")
	}
	create(t, s, "remaining")
	start(t, s, "remaining")
	values := taskValues("exhausted")
	values["max_attempts"] = 1
	_, _, err = s.CreateTask(testContext, values, "")
	check(t, err)
	start(t, s, "exhausted")
	create(t, s, "starting")
	_, err = s.ClaimTask(testContext, "starting")
	check(t, err)
	count, err := s.RecoverIncomplete(testContext)
	check(t, err)
	if count != 4 {
		t.Fatal(count)
	}
	for id, status := range map[string]string{"t": "cancelled", "remaining": "queued", "exhausted": "failed", "starting": "queued"} {
		task := get(t, s, id)
		if task["status"] != status || task["lease"] != nil || task["pid"] != nil || task["last_error_class"] != "backend_restart" {
			t.Fatal(task)
		}
		if id != "starting" && task["latest_attempt"].(map[string]any)["status"] != "orphaned" {
			t.Fatal(task)
		}
	}
	count, err = s.RecoverIncomplete(testContext)
	check(t, err)
	if count != 0 {
		t.Fatal(count)
	}
	task, err = s.RetryTask(testContext, "t", 0)
	check(t, err)
	if task["max_attempts"] != int64(3) || task["backoff_anchor_attempt"] != int64(2) || task["attempt_count"] != int64(2) || task["cancel_requested"] != false {
		t.Fatal(task)
	}
	if _, err = s.RetryTask(testContext, "t", 1); !errors.Is(err, ErrInvalidState) {
		t.Fatal(err)
	}
}

func TestLogsEventsAndPruneRollback(t *testing.T) {
	s := openTestStore(t)
	create(t, s, "t")
	s.SetMaxLogsPerTask(100)
	batch := make([]LogRow, 151)
	for i := range batch {
		batch[i] = LogRow{TaskID: "t", Timestamp: float64(i), Stream: "stdout", Line: fmt.Sprintf("line %d", i)}
	}
	last, err := s.AppendLogsBulk(testContext, batch)
	check(t, err)
	logs, err := s.GetLogs(testContext, "t", 0, nil, 5000)
	check(t, err)
	if len(logs) != 100 || logs[len(logs)-1]["id"] != last || logs[0]["line"] != "line 51" {
		t.Fatal(logs)
	}
	before := s.sincePrune["t"]
	_, err = s.AppendLogsBulk(testContext, []LogRow{{TaskID: "t", Line: "rollback"}, {TaskID: "missing", Line: "fail"}})
	if err == nil || s.sincePrune["t"] != before {
		t.Fatal("failed batch committed counters")
	}
	logs, err = s.GetLogs(testContext, "t", last, nil, 100)
	check(t, err)
	if len(logs) != 0 {
		t.Fatal(logs)
	}
	id, err := s.AppendLog(testContext, "t", nil, "stderr", "Authorization: Bearer private-token https://user:pw@host/?token=querysecret password=secretvalue")
	check(t, err)
	tail := 1
	logs, err = s.GetLogs(testContext, "t", id, &tail, 1)
	check(t, err)
	line := logs[0]["line"].(string)
	for _, secret := range []string{"private-token", "user:pw", "querysecret", "secretvalue"} {
		if strings.Contains(line, secret) {
			t.Fatal(line)
		}
	}
	check(t, s.AddEvent(testContext, "t", "custom", map[string]any{"nested": map[string]any{"api_key": "private"}, "url": "https://u:p@host/"}))
	events, err := s.GetEvents(testContext, "t", 0, 5000)
	check(t, err)
	payload := events[len(events)-1]["payload"].(map[string]any)
	if payload["nested"].(map[string]any)["api_key"] != "***" {
		t.Fatal(payload)
	}
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE tasks SET extra_args_json='invalid',policy_json='',tried_proxy_ids_json='null' WHERE id='t'; UPDATE task_events SET payload_json='invalid'")
		return err
	}))
	task := get(t, s, "t")
	equalJSON(t, task["extra_args"], []any{})
	if task["policy"] != nil || task["tried_proxy_ids"] != nil {
		t.Fatal(task)
	}
	events, err = s.GetEvents(testContext, "t", 0, 5000)
	check(t, err)
	equalJSON(t, events[0]["payload"], map[string]any{})
}

func TestQueueFilteringAndCompletion(t *testing.T) {
	s := openTestStore(t)
	for i := 0; i < 4; i++ {
		values := taskValues(fmt.Sprint(i))
		values["priority"] = i
		if i == 3 {
			values["site"] = "excluded"
		}
		_, _, err := s.CreateTask(testContext, values, "")
		check(t, err)
	}
	_, err := s.RequeueTask(testContext, "2", RequeueTaskOptions{NextRunAt: unixTime() + 3600})
	check(t, err)
	rows, err := s.QueuedTasks(testContext, 100, []string{"excluded"})
	check(t, err)
	if len(rows) != 2 || rows[0]["id"] != "1" {
		t.Fatal(rows)
	}
	ids, err := s.QueuedTaskIDs(testContext, []string{"0", "1", "2", "3", "missing"})
	check(t, err)
	if len(ids) != 3 {
		t.Fatal(ids)
	}
	rows, err = s.ListTasks(testContext, "queued", "example", 0, -1)
	check(t, err)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	rows, err = s.ListTasks(testContext, "queued' OR 1=1 --", "", 50, 0)
	check(t, err)
	if len(rows) != 0 {
		t.Fatal(rows)
	}
	attempt := start(t, s, "1")
	code := 0
	check(t, s.SetProcess(testContext, "1", attempt, 123, "marker"))
	check(t, s.SetLease(testContext, "1", attempt, "n", "http://local", "example"))
	check(t, s.FinishAttempt(testContext, attempt, FinishAttemptOptions{Status: "succeeded", ExitCode: &code}))
	check(t, s.FinishAttempt(testContext, attempt, FinishAttemptOptions{Status: "failed"}))
	_, err = s.CompleteTask(testContext, "1", "succeeded", CompleteTaskOptions{ExpectedAttemptID: attempt, ExitCode: &code})
	check(t, err)
	task := get(t, s, "1")
	if task["status"] != "succeeded" || task["lease"] != nil || task["latest_attempt"].(map[string]any)["status"] != "succeeded" {
		t.Fatal(task)
	}
	check(t, s.UpdateArtifacts(testContext, "1", 5, 1024))
	task = get(t, s, "1")
	if task["artifact_count"] != int64(5) {
		t.Fatal(task)
	}
	if task, err = s.GetTask(testContext, "missing"); err != nil || task != nil {
		t.Fatal(task, err)
	}
	if _, err = s.BeginAttempt(testContext, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func schemaLayout(t *testing.T, s *Store) map[string]any {
	t.Helper()
	tables, err := queryMaps(testContext, s.reader, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
	check(t, err)
	layout := map[string]any{}
	for _, table := range tables {
		name := table["name"].(string)
		cols, err := queryMaps(testContext, s.reader, "PRAGMA table_info("+name+")")
		check(t, err)
		fks, err := queryMaps(testContext, s.reader, "PRAGMA foreign_key_list("+name+")")
		check(t, err)
		indexes, err := queryMaps(testContext, s.reader, "PRAGMA index_list("+name+")")
		check(t, err)
		for _, index := range indexes {
			delete(index, "seq")
			index["columns"], err = queryMaps(testContext, s.reader, "PRAGMA index_xinfo("+index["name"].(string)+")")
			check(t, err)
		}
		sort.Slice(indexes, func(i, j int) bool { return indexes[i]["name"].(string) < indexes[j]["name"].(string) })
		layout[name] = map[string]any{"columns": cols, "foreign_keys": fks, "indexes": indexes}
	}
	return layout
}

func TestLegacySchemaAndTaskOracle(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("test-only legacy oracle requires python3")
	}
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	output, err := exec.Command(python, "-B", "testdata/legacy_fixture.py", path).CombinedOutput()
	if err != nil {
		t.Fatalf("legacy fixture: %v\n%s", err, output)
	}
	var expected map[string]any
	check(t, json.Unmarshal(output, &expected))
	s := openTestStore(t)
	layout := schemaLayout(t, s)
	wantLayout := expected["layout"].(map[string]any)
	// Native tables are additive. Caption batch ownership intentionally changes
	// in v19 and is checked separately by the caption migration test.
	for _, name := range []string{"danbooru_import_items", "danbooru_collect_requests", "gallery_asset_keeps"} {
		if _, ok := layout[name]; !ok {
			t.Fatalf("missing native table %s", name)
		}
		delete(layout, name)
	}
	delete(layout, "caption_batches")
	delete(wantLayout, "caption_batches")
	if len(layout) != len(wantLayout) {
		t.Fatalf("table count got %d want %d", len(layout), len(wantLayout))
	}
	for table, want := range wantLayout {
		t.Run("schema_"+table, func(t *testing.T) { equalJSON(t, layout[table], want) })
	}
	s.clock = func() float64 { return 1234.5 }
	counter := 0
	s.uuid = func() string { counter++; return fmt.Sprintf("attempt-%d", counter) }
	trace := []any{}
	task, fresh, err := s.CreateTask(testContext, taskValues("legacy-task"), "legacy-key")
	check(t, err)
	trace = append(trace, []any{task, fresh})
	claimed, err := s.ClaimTask(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, claimed)
	attempt, err := s.BeginAttempt(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, attempt)
	check(t, s.SetProcess(testContext, "legacy-task", "attempt-1", 123, "marker"))
	check(t, s.SetLease(testContext, "legacy-task", "attempt-1", "node-1", "http://localhost:8888", "example"))
	trace = append(trace, get(t, s, "legacy-task"))
	task, fresh, err = s.CreateTask(testContext, nil, "legacy-key")
	check(t, err)
	trace = append(trace, []any{task, fresh})
	code := 2
	check(t, s.FinishAttempt(testContext, "attempt-1", FinishAttemptOptions{ExitCode: &code, Status: "failed", ErrorClass: "transient", ErrorMessage: "https://name:pw@example.org/?token=private", Retryable: true}))
	ok, err := s.RequeueTask(testContext, "legacy-task", RequeueTaskOptions{NextRunAt: 1500, ExitCode: &code, ErrorClass: "transient", ErrorMessage: "retry", TriedProxyIDs: []string{"b", "a", "b"}, ExpectedAttemptID: "attempt-1"})
	check(t, err)
	trace = append(trace, ok)
	trace = append(trace, get(t, s, "legacy-task"))
	task, err = s.RequestCancel(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, task)
	task, err = s.RetryTask(testContext, "legacy-task", 2)
	check(t, err)
	trace = append(trace, task)
	claimed, err = s.ClaimTask(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, claimed)
	attempt, err = s.BeginAttempt(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, attempt)
	task, err = s.RequestCancel(testContext, "legacy-task")
	check(t, err)
	trace = append(trace, task)
	recovered, err := s.RecoverIncomplete(testContext)
	check(t, err)
	trace = append(trace, recovered)
	trace = append(trace, get(t, s, "legacy-task"))
	_, err = s.AppendLog(testContext, "legacy-task", nil, "stderr", "password=private")
	check(t, err)
	attemptID := "attempt-2"
	_, err = s.AppendLog(testContext, "legacy-task", &attemptID, "stdout", "完成")
	check(t, err)
	tail := 1
	logs, err := s.GetLogs(testContext, "legacy-task", 0, &tail, 1000)
	check(t, err)
	trace = append(trace, logs)
	events, err := s.GetEvents(testContext, "legacy-task", 0, 1000)
	check(t, err)
	trace = append(trace, events)
	rows, err := s.ListTasks(testContext, "cancelled", "example", 0, -1)
	check(t, err)
	trace = append(trace, rows)
	wantTrace := expected["trace"].([]any)
	if len(trace) != len(wantTrace) {
		t.Fatal("trace length differs")
	}
	for i, want := range wantTrace {
		t.Run(fmt.Sprintf("operation_%d", i), func(t *testing.T) { equalJSON(t, trace[i], want) })
	}
	legacy, err := Open(path)
	check(t, err)
	defer legacy.Close()
	equalJSON(t, get(t, legacy, "legacy-task"), expected["task"])
	for _, table := range []string{"datasets", "gallery_review_presets"} {
		rows, err := queryMaps(testContext, legacy.reader, "SELECT * FROM "+table)
		check(t, err)
		if len(rows) != 1 {
			t.Fatalf("lost %s rows", table)
		}
	}
}
