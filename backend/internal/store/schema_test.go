package store

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"testing"
)

func rawDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", databaseDSN(path, false))
	check(t, err)
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return db
}

func TestHistoricalAdditiveUpgrades(t *testing.T) {
	for _, version := range []int{1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18} {
		t.Run(strconv.Itoa(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "historical.sqlite")
			s, err := Open(path)
			check(t, err)
			before := create(t, s, "preserved-task")
			check(t, s.Close())
			db := rawDatabase(t, path)
			_, err = db.Exec("UPDATE meta SET value=? WHERE key='schema_version'", strconv.Itoa(version))
			check(t, err)
			// Recreate only documented historical omissions in this temporary DB.
			for _, col := range additiveColumns {
				remove := false
				switch col.table {
				case "tasks", "crawl_addresses", "crawl_reviews", "caption_batches", "caption_batch_items":
					remove = true // legacy same-version additions
				case "gallery_sources":
					remove = version <= 9
				case "gallery_directories":
					remove = version < 11
				case "gallery_file_operation_items":
					remove = version < 11 || (version < 12 && col.name == "review_snapshot_json")
				case "gallery_reviews":
					remove = version < 14
				case "dataset_export_jobs":
					remove = version < 17
				case "dataset_decisions":
					remove = version < 18
				}
				if !remove {
					continue
				}
				if col.table == "dataset_export_jobs" {
					_, err = db.Exec("DROP INDEX IF EXISTS idx_dataset_export_jobs_dataset")
					check(t, err)
				}
				_, err = db.Exec("ALTER TABLE " + col.table + " DROP COLUMN " + col.name)
				check(t, err)
			}
			_, err = db.Exec("INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES ('data','keep','custom',1,1)")
			check(t, err)
			if version >= 8 {
				_, err = db.Exec("INSERT INTO site_policies VALUES ('example','{\"keep\":true}',1)")
				check(t, err)
			}
			check(t, db.Close())
			s, err = Open(path)
			check(t, err)
			defer s.Close()
			after := get(t, s, "preserved-task")
			delete(after, "latest_attempt")
			delete(after, "lease")
			equalJSON(t, after, before)
			var got string
			check(t, s.reader.QueryRow("SELECT value FROM meta WHERE key='schema_version'").Scan(&got))
			if got != strconv.Itoa(CurrentSchemaVersion) {
				t.Fatal(got)
			}
			check(t, s.reader.QueryRow("SELECT name FROM datasets WHERE id='data'").Scan(&got))
			if got != "keep" {
				t.Fatal("dataset changed")
			}
			if version >= 8 {
				check(t, s.reader.QueryRow("SELECT policy_json FROM site_policies WHERE site='example'").Scan(&got))
				if got != `{"keep":true}` {
					t.Fatal("policy changed")
				}
			}
			check(t, s.Ping(testContext))
			create(t, s, "after-upgrade")
		})
	}
}

func TestRejectInvalidAndFutureVersions(t *testing.T) {
	for _, version := range []string{"0", "-1", strconv.Itoa(CurrentSchemaVersion + 1), "invalid"} {
		t.Run(version, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "unsupported.sqlite")
			db := rawDatabase(t, path)
			_, err := db.Exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep')")
			check(t, err)
			_, err = db.Exec("INSERT INTO meta VALUES ('schema_version',?)", version)
			check(t, err)
			if s, err := Open(path); err == nil {
				s.Close()
				t.Fatal("accepted unsupported version")
			}
			var got string
			check(t, db.QueryRow("SELECT value FROM meta").Scan(&got))
			if got != version {
				t.Fatal("version changed on failure")
			}
			check(t, db.QueryRow("SELECT value FROM retained").Scan(&got))
			if got != "keep" {
				t.Fatal("existing data changed")
			}
			var count int
			check(t, db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").Scan(&count))
			if count != 2 {
				t.Fatal("schema changed on failure")
			}
		})
	}
}

func TestPreserveLegacyPoliciesAndReviewSnapshots(t *testing.T) {
	for _, version := range []int{7, 12} {
		t.Run(strconv.Itoa(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "legacy.sqlite")
			s, err := Open(path)
			check(t, err)
			check(t, s.Close())
			db := rawDatabase(t, path)
			_, err = db.Exec("UPDATE meta SET value=? WHERE key='schema_version'", strconv.Itoa(version))
			check(t, err)
			const legacyPolicy = `{"max_concurrency":3,"retry_limit":1,"legacy":{"retain":true}}`
			_, err = db.Exec("INSERT INTO site_policies VALUES ('twitter',?,123)", legacyPolicy)
			check(t, err)
			_, err = db.Exec("INSERT INTO gallery_reviews(review_id,status,selection_json,snapshot_json,created_at,updated_at) VALUES ('review','ready','[{\"source_id\":\"old-source\"}]','[{\"asset_id\":\"old-asset\"}]',1,2)")
			check(t, err)
			before, err := queryMap(testContext, db, "SELECT * FROM gallery_reviews WHERE review_id='review'")
			check(t, err)
			check(t, db.Close())
			s, err = Open(path)
			check(t, err)
			after, err := s.QueryRow(testContext, "SELECT * FROM gallery_reviews WHERE review_id='review'")
			check(t, err)
			equalJSON(t, after, before)
			var marker, policy, original string
			check(t, s.reader.QueryRow("SELECT value FROM meta WHERE key='legacy_gallery_review:review'").Scan(&marker))
			if marker != strconv.Itoa(version) {
				t.Fatal(marker)
			}
			check(t, s.reader.QueryRow("SELECT policy_json FROM site_policies WHERE site='twitter'").Scan(&policy))
			if version < 8 {
				check(t, s.reader.QueryRow("SELECT value FROM meta WHERE key='legacy_site_policy:twitter'").Scan(&original))
				if original != legacyPolicy || policy != `{"max_concurrency":3,"retry_limit":1}` {
					t.Fatal("legacy policy values lost", original, policy)
				}
			} else if policy != legacyPolicy {
				t.Fatal("modern policy changed")
			}
			check(t, s.Close())
			// Reopening a migrated database cannot overwrite the original snapshot.
			s, err = Open(path)
			check(t, err)
			defer s.Close()
			check(t, s.reader.QueryRow("SELECT value FROM meta WHERE key='schema_version'").Scan(&marker))
			if marker != strconv.Itoa(CurrentSchemaVersion) {
				t.Fatal(marker)
			}
		})
	}
}

func TestFTSFailureDoesNotAdvanceVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad-fts.sqlite")
	db := rawDatabase(t, path)
	_, err := db.Exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
		INSERT INTO meta VALUES ('schema_version','17');
		CREATE TABLE gallery_search_index(asset_id TEXT,source_id TEXT,file_name TEXT,relative_path TEXT,txt_content TEXT);
		INSERT INTO gallery_search_index VALUES ('keep','s','name','name','content')`)
	check(t, err)
	if s, err := Open(path); err == nil {
		s.Close()
		t.Fatal("accepted non-FTS index")
	}
	var version string
	check(t, db.QueryRow("SELECT value FROM meta WHERE key='schema_version'").Scan(&version))
	if version != "17" {
		t.Fatal(version)
	}
	var count int
	check(t, db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").Scan(&count))
	if count != 2 {
		t.Fatalf("partial schema was committed: %d tables", count)
	}
	check(t, db.QueryRow("SELECT COUNT(*) FROM gallery_search_index WHERE asset_id='keep'").Scan(&count))
	if count != 1 {
		t.Fatal("modified existing content")
	}
}
