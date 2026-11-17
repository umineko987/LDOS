package tasks

import (
	"context"
	"errors"
	"testing"
)

func TestEnqueueUsesDelegatedNetworkValidationAndSkipsReplay(t *testing.T) {
	service, _, fake := newTaskTestService(t)
	calls := 0
	service.deps.ValidateTarget = func(_ context.Context, target string) error {
		calls++
		if target != "https://gallery.example/item" {
			t.Fatal("unexpected target", target)
		}
		return nil
	}
	service.deps.LookupIP = func(context.Context, string) ([]string, error) {
		t.Fatal("delegated validation must not repeat local DNS")
		return nil, nil
	}
	key := "delegated-network"
	body := Create{URL: "https://gallery.example/item"}
	row, created, err := service.Enqueue(context.Background(), body, &key)
	if err != nil || !created {
		t.Fatal(row, created, err)
	}
	replay, created, err := service.Enqueue(context.Background(), body, &key)
	if err != nil || created || replay["id"] != row["id"] || calls != 1 || fake.resolveCalls != 1 {
		t.Fatal("incorrect replay", err, calls)
	}
}

func TestEnqueuePropagatesDelegatedTargetRejection(t *testing.T) {
	service, db, fake := newTaskTestService(t)
	service.deps.ValidateTarget = func(context.Context, string) error { return errors.New("proxy DNS rejected private target") }
	_, _, err := service.Enqueue(context.Background(), Create{URL: "https://gallery.example/item"}, nil)
	var rejection *Error
	if !errors.As(err, &rejection) || rejection.Status != 422 || fake.resolveCalls != 0 || fake.lookupCalls != 0 {
		t.Fatal("validation bypassed", err, fake)
	}
	row, err := db.QueryRow(context.Background(), "SELECT COUNT(*) AS n FROM tasks")
	if err != nil || row["n"] != int64(0) {
		t.Fatal("rejected target persisted", row, err)
	}
}
