package store

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestUnknownHistoricalSchemaRejected(t *testing.T) {
	for _, table := range []string{"tasks", "datasets"} {
		t.Run(table, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "unknown.sqlite")
			s, err := Open(path)
			check(t, err)
			create(t, s, "keep")
			check(t, s.Close())
			db := rawDatabase(t, path)
			column := "artifact_bytes"
			if table == "datasets" {
				column = "trigger_word"
			}
			_, err = db.Exec("ALTER TABLE " + table + " DROP COLUMN " + column)
			check(t, err)
			_, err = db.Exec("UPDATE meta SET value='17' WHERE key='schema_version'")
			check(t, err)
			if s, err = Open(path); err == nil {
				s.Close()
				t.Fatal("accepted unsupported schema")
			} else if !strings.Contains(err.Error(), "unsupported SQLite schema for "+table) {
				t.Fatal(err)
			}
			var version string
			check(t, db.QueryRow("SELECT value FROM meta WHERE key='schema_version'").Scan(&version))
			if version != "17" {
				t.Fatal("unknown schema marker changed")
			}
			var count int
			check(t, db.QueryRow("SELECT COUNT(*) FROM tasks WHERE id='keep'").Scan(&count))
			if count != 1 {
				t.Fatal("existing task removed")
			}
		})
	}
}

func TestSchemaValidationCoversAllBusinessTables(t *testing.T) {
	s := openTestStore(t)
	tables, err := queryMaps(testContext, s.reader, "SELECT name FROM sqlite_master WHERE type='table'")
	check(t, err)
	covered := make(map[string]string)
	for _, table := range requiredSchemaColumns {
		covered[table.table] = table.columns
	}
	for _, table := range tables {
		name := table["name"].(string)
		if name == "sqlite_sequence" || strings.HasPrefix(name, "gallery_search_index_") {
			continue
		}
		columns, exists := covered[name]
		if !exists {
			t.Errorf("missing validation for table %s", name)
			continue
		}
		rows, err := queryMaps(testContext, s.reader, "PRAGMA table_info("+name+")")
		check(t, err)
		if len(rows) != len(strings.Fields(columns)) {
			t.Errorf("incomplete column validation for table %s", name)
		}
	}
}
