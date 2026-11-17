package activity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func publish(t *testing.T, bus *Bus, kind string, data any) *Event {
	t.Helper()
	event, err := bus.Publish(kind, data)
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func nextEvent(t *testing.T, stream *Subscription) *Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	event, err := stream.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func assertMarker(t *testing.T, event *Event, kind, id, reason string) {
	t.Helper()
	var data struct {
		LastEventID string `json:"last_event_id"`
		Reason      string `json:"reason"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		t.Fatal(err)
	}
	if event.Kind != kind || event.ID != id || data.LastEventID != id || data.Reason != reason {
		t.Fatalf("unexpected marker: %+v, data=%s", event, event.Data)
	}
}

func TestBusFreshSubscriberAndImmutableSnapshots(t *testing.T) {
	bus := NewBus(0)
	publish(t, bus, "before", nil)
	stream := bus.Subscribe("")
	defer stream.Close()
	assertMarker(t, nextEvent(t, stream), HelloEvent, bus.LastEventID(), "")
	payload := map[string]any{"nested": map[string]string{"name": "old"}}
	event := publish(t, bus, "after", payload)
	payload["nested"].(map[string]string)["name"] = "new"
	event.Data[0] = '!'
	got := nextEvent(t, stream)
	if got.Kind != "after" || got.Seq != 2 || string(got.Data) != `{"nested":{"name":"old"}}` {
		t.Fatalf("unexpected event: %+v", got)
	}
	got.Data[0] = '!'
	replay, complete := bus.EventsAfter(1)
	if !complete || string(replay[0].Data) != `{"nested":{"name":"old"}}` {
		t.Fatalf("subscriber modified replay: %s", replay[0].Data)
	}
	stream.Close()
	if bus.SubscriberCount() != 0 {
		t.Fatal("subscription not released")
	}
}

func TestBusConcurrentPublishOrderedReplay(t *testing.T) {
	bus := NewBus(0)
	stream := bus.Subscribe("")
	defer stream.Close()
	nextEvent(t, stream)
	var workers sync.WaitGroup
	for worker := range 4 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range 50 {
				if _, err := bus.Publish("tick", map[string]int{"worker": worker, "index": index}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	indexes := [4]int{}
	for expected := uint64(1); expected <= 200; expected++ {
		event := nextEvent(t, stream)
		var payload struct{ Worker, Index int }
		if err := json.Unmarshal(event.Data, &payload); err != nil {
			t.Fatal(err)
		}
		if event.Seq != expected || payload.Index != indexes[payload.Worker] {
			t.Fatalf("out of order: seq=%d, payload=%+v", event.Seq, payload)
		}
		indexes[payload.Worker]++
	}
	workers.Wait()
}

func TestBusReplayAndResync(t *testing.T) {
	bus := NewBus(4)
	for index := range 10 {
		publish(t, bus, "tick", map[string]int{"index": index})
	}
	stream := bus.Subscribe(bus.formatID(6))
	defer stream.Close()
	for seq := uint64(7); seq <= 10; seq++ {
		if got := nextEvent(t, stream); got.Seq != seq {
			t.Fatalf("got seq %d, want %d", got.Seq, seq)
		}
	}
	if events, complete := bus.EventsAfter(5); complete || len(events) != 0 {
		t.Fatal("overflow was replayable")
	}
	for _, cursor := range []string{"other-1", bus.formatID(99), "garbage", bus.epoch + "-x", bus.epoch + "-+1", bus.epoch + "--1"} {
		t.Run(cursor, func(t *testing.T) {
			stream := bus.Subscribe(cursor)
			defer stream.Close()
			assertMarker(t, nextEvent(t, stream), ResyncEvent, bus.LastEventID(), "unknown_cursor")
		})
	}
	for _, cursor := range []string{bus.formatID(3), bus.formatID(5)} {
		stream := bus.Subscribe(cursor)
		assertMarker(t, nextEvent(t, stream), ResyncEvent, bus.LastEventID(), "buffer_overflow")
		event := publish(t, bus, "new", nil)
		if got := nextEvent(t, stream); got.ID != event.ID {
			t.Fatalf("resync did not resume: %+v", got)
		}
		stream.Close()
	}
	if seq, ok := bus.ParseEventID(" \t" + bus.epoch + "-0001 \n"); !ok || seq != 1 {
		t.Fatalf("valid padded cursor rejected: %d %v", seq, ok)
	}
}

func TestBusSlowSubscriberResync(t *testing.T) {
	bus := NewBus(2)
	stream := bus.Subscribe("")
	defer stream.Close()
	nextEvent(t, stream)
	for range 3 {
		publish(t, bus, "tick", nil)
	}
	assertMarker(t, nextEvent(t, stream), ResyncEvent, bus.LastEventID(), "buffer_overflow")
}

func TestBusCloseReopenAndCancellation(t *testing.T) {
	bus := NewBus(0)
	stream := bus.Subscribe("")
	nextEvent(t, stream)
	cursor := bus.LastEventID()
	bus.Close()
	bus.Close()
	if event, err := bus.Publish("late", make(chan int)); event != nil || err != nil {
		t.Fatal("closed bus accepted a publish")
	}
	if bus.SubscriberCount() != 0 || !bus.Closed() {
		t.Fatal("closed bus retained subscribers")
	}
	if _, err := bus.Subscribe("").Next(t.Context()); !errors.Is(err, io.EOF) {
		t.Fatalf("closed subscribe: %v", err)
	}
	bus.Reopen()
	publish(t, bus, "again", nil)
	if _, err := stream.Next(t.Context()); !errors.Is(err, io.EOF) {
		t.Fatalf("old stream revived: %v", err)
	}
	replay := bus.Subscribe(cursor)
	if event := nextEvent(t, replay); event.Seq != 1 {
		t.Fatalf("reopen lost sequence: %+v", event)
	}
	replay.Close()

	waiting := bus.Subscribe(bus.LastEventID())
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := waiting.Next(ctx); done <- err }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not wake subscriber")
	}
	if bus.SubscriberCount() != 0 {
		t.Fatal("cancel leaked subscriber")
	}
}

func TestBusValidationDoesNotAdvanceSequence(t *testing.T) {
	bus := NewBus(0)
	cursor := bus.LastEventID()
	for _, input := range []struct {
		kind string
		data any
	}{
		{"tick\nretry: 0", nil}, {"tick", make(chan int)},
	} {
		if _, err := bus.Publish(input.kind, input.data); err == nil {
			t.Fatal("invalid publish accepted")
		}
	}
	if bus.LastEventID() != cursor {
		t.Fatal("failed publish advanced sequence")
	}
	if event := publish(t, bus, "empty", nil); string(event.Data) != "{}" {
		t.Fatal("nil payload must be an object")
	}
	if !strings.HasSuffix(cursor, "-0") {
		t.Fatalf("unexpected initial cursor %s", cursor)
	}
}

func TestBusCloseWakesWaitingNext(t *testing.T) {
	bus := NewBus(1)
	stream := bus.Subscribe(bus.LastEventID())
	done := make(chan error, 1)
	go func() { _, err := stream.Next(t.Context()); done <- err }()
	bus.Close()
	select {
	case err := <-done:
		if !errors.Is(err, io.EOF) {
			t.Fatal(fmt.Errorf("close: %w", err))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("close did not wake subscriber")
	}
}
