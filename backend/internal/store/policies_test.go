package store

import "encoding/json"
import (
	"database/sql"
	"strings"
	"testing"
)

func TestSitePolicies(t *testing.T) {
	s := openTestStore(t)
	rows, err := s.ListSitePolicies(testContext)
	check(t, err)
	if rows == nil || len(rows) != 0 {
		t.Fatalf("empty list: %#v", rows)
	}
	row, err := s.GetSitePolicy(testContext, "missing")
	check(t, err)
	if row != nil {
		t.Fatal(row)
	}
	policy := map[string]any{"concurrency": 2, "timeout_seconds": 60, "retries": 3, "enabled": true}
	written, err := s.PutSitePolicy(testContext, "z.example", policy)
	check(t, err)
	row, err = s.GetSitePolicy(testContext, "z.example")
	check(t, err)
	equalJSON(t, row, written)
	equalJSON(t, row["policy"], policy)
	// Store accepts the service's dictionary as-is, without field normalization.
	policy = map[string]any{"kept": "原样"}
	_, err = s.PutSitePolicy(testContext, "z.example", policy)
	check(t, err)
	_, err = s.PutSitePolicy(testContext, "a' OR 1=1 --", map[string]any{})
	check(t, err)
	rows, err = s.ListSitePolicies(testContext)
	check(t, err)
	if len(rows) != 2 || rows[0]["site"] != "a' OR 1=1 --" || rows[1]["site"] != "z.example" {
		t.Fatal(rows)
	}
	equalJSON(t, rows[1]["policy"], policy)
	deleted, err := s.DeleteSitePolicy(testContext, "a' OR 1=1 --")
	check(t, err)
	if !deleted {
		t.Fatal("missing delete result")
	}
	deleted, err = s.DeleteSitePolicy(testContext, "a' OR 1=1 --")
	check(t, err)
	if deleted {
		t.Fatal("deleted missing row")
	}
	if _, err = s.PutSitePolicy(testContext, "z.example", map[string]any{"bad": make(chan int)}); err == nil {
		t.Fatal("accepted unserializable policy")
	}
	row, err = s.GetSitePolicy(testContext, "z.example")
	check(t, err)
	equalJSON(t, row["policy"], policy)
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TRIGGER reject_policy BEFORE UPDATE ON site_policies BEGIN SELECT RAISE(ABORT,'fixture failure'); END`)
		return err
	}))
	if row, err = s.PutSitePolicy(testContext, "z.example", map[string]any{"replacement": true}); err == nil || row != nil {
		t.Fatal("reported success after rejected update")
	}
	row, err = s.GetSitePolicy(testContext, "z.example")
	check(t, err)
	equalJSON(t, row["policy"], policy)
}

func TestInvalidPolicyJSONReturnsError(t *testing.T) {
	s := openTestStore(t)
	for _, raw := range []string{"invalid", "", "{"} {
		check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
			_, err := tx.Exec(`INSERT INTO site_policies(site,policy_json,updated_at) VALUES ('bad',?,1)
				ON CONFLICT(site) DO UPDATE SET policy_json=excluded.policy_json`, raw)
			return err
		}))
		if row, err := s.GetSitePolicy(testContext, "bad"); err == nil || row != nil || !strings.Contains(err.Error(), "invalid policy JSON") {
			t.Fatalf("invalid JSON returned %#v, %v", row, err)
		}
		if rows, err := s.ListSitePolicies(testContext); err == nil || rows != nil {
			t.Fatalf("invalid JSON list returned %#v, %v", rows, err)
		}
	}
}

func TestPolicyNumbersRetainStrictTypes(t *testing.T) {
	s := openTestStore(t)
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO site_policies(site,policy_json,updated_at) VALUES ('danbooru','{"max_concurrency":3.0,"retry_limit":1}',1)`)
		return err
	}))
	row, err := s.GetSitePolicy(testContext, "danbooru")
	check(t, err)
	policy := row["policy"].(map[string]any)
	if policy["max_concurrency"] != json.Number("3.0") || policy["retry_limit"] != json.Number("1") {
		t.Fatal(policy)
	}
	check(t, s.withWrite(testContext, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE site_policies SET policy_json='{} {}' WHERE site='danbooru'`)
		return err
	}))
	if _, err := s.GetSitePolicy(testContext, "danbooru"); err == nil {
		t.Fatal("trailing policy JSON accepted")
	}
}
