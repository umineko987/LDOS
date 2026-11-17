package store

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestTypedEventPayloadRedaction(t *testing.T) {
	s := openTestStore(t)
	create(t, s, "task")
	secret := "https://user:private@host/?token=hidden"
	payload := map[string]any{
		"typed_map":     map[string]string{"api_key": "private"},
		"typed_slice":   []map[string]string{{"password": "private"}},
		"pointer":       &secret,
		"large_integer": int64(9007199254740993),
	}
	check(t, s.AddEvent(testContext, "task", "typed", payload))
	var encoded string
	check(t, s.reader.QueryRow("SELECT payload_json FROM task_events WHERE event_type='typed'").Scan(&encoded))
	if strings.Contains(encoded, "private") || strings.Contains(encoded, "hidden") {
		t.Fatal("typed payload leaked a secret: " + encoded)
	}
	if !strings.Contains(encoded, "9007199254740993") {
		t.Fatal("event integer precision lost: " + encoded)
	}
	if payload["typed_map"].(map[string]string)["api_key"] != "private" {
		t.Fatal("mutated caller payload")
	}
	if err := s.AddEvent(testContext, "task", "invalid", map[string]any{"invalid": make(chan int)}); err == nil {
		t.Fatal("accepted non-JSON event payload")
	}
	var decoded map[string]any
	check(t, json.Unmarshal([]byte(encoded), &decoded))
	if decoded["typed_map"].(map[string]any)["api_key"] != "***" {
		t.Fatal(decoded)
	}
}

func TestConcurrentLogs(t *testing.T) {
	s := openTestStore(t)
	create(t, s, "task")
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			for range 10 {
				if _, err := s.AppendLog(testContext, "task", nil, "stdout", "line"); err != nil {
					t.Error(err)
				}
				if _, err := s.GetLogs(testContext, "task", 0, nil, 5); err != nil {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	rows, err := s.GetLogs(testContext, "task", 0, nil, 500)
	check(t, err)
	if len(rows) != 100 {
		t.Fatalf("got %d logs, want 100", len(rows))
	}
	for i, row := range rows {
		if row["id"] != int64(i+1) {
			t.Fatal("logs out of order")
		}
	}
}
