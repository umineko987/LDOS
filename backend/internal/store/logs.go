package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

var (
	urlUserinfo    = regexp.MustCompile(`(?i)(\b(?:https?|socks4|socks5h?|ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|anytls|mieru)://)[^\s/@]+(?::[^\s/@]*)?@`)
	querySecret    = regexp.MustCompile(`(?i)([?&;/](?:token|access_token|api[_-]?key|auth|password|passwd|secret|session|cookie|signature|sig|code|email|username|keystamp|fileindex)=)[^&#\s]+`)
	keyValueSecret = regexp.MustCompile(`(?i)(\b(?:authorization|proxy-authorization|cookie|set-cookie|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)[^\s,;]+`)
	bearerSecret   = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
	secretKey      = regexp.MustCompile(`(?i)token|password|passwd|secret|cookie|api.?key|authorization`)
)

func redactText(text string, limit int) string {
	text = urlUserinfo.ReplaceAllString(text, "${1}***:***@")
	text = querySecret.ReplaceAllString(text, "${1}***")
	// Redact the full auth scheme before masking the header value, so the
	// credential after "Authorization: Bearer" cannot be left behind.
	text = bearerSecret.ReplaceAllString(text, "${1} ***")
	text = keyValueSecret.ReplaceAllString(text, "${1}***")
	if limit > 0 {
		runes := []rune(text)
		if len(runes) > limit {
			text = string(runes[:limit-1]) + "…"
		}
	}
	return text
}

func redactData(value any) any {
	switch v := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(v))
		for key, item := range v {
			if secretKey.MatchString(key) {
				result[key] = "***"
			} else {
				result[key] = redactData(item)
			}
		}
		return result
	case []any:
		result := make([]any, len(v))
		for i, item := range v {
			result[i] = redactData(item)
		}
		return result
	case []string:
		result := make([]string, len(v))
		for i, item := range v {
			result[i] = redactText(item, 0)
		}
		return result
	case string:
		return redactText(v, 0)
	default:
		return value
	}
}

func (r *TaskRepository) addEvent(ctx context.Context, tx *sql.Tx, id, eventType string, payload map[string]any) error {
	if payload == nil {
		payload = map[string]any{}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	// Normalize typed maps, slices and pointers supplied by Go callers before
	// recursively redacting them. UseNumber preserves large numeric event IDs.
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	var normalized any
	if err = decoder.Decode(&normalized); err != nil {
		return err
	}
	encoded, err = json.Marshal(redactData(normalized))
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO task_events(task_id,ts,event_type,payload_json) VALUES (?,?,?,?)", id, r.clock(), eventType, string(encoded))
	return err
}

func (r *TaskRepository) AddEvent(ctx context.Context, id, eventType string, payload map[string]any) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		return r.addEvent(ctx, tx, id, eventType, payload)
	})
}

// LogRow represents one line in a batch. Timestamp is Unix seconds and a nil
// AttemptID is used for task-level logs.
type LogRow struct {
	TaskID    string
	AttemptID *string
	Timestamp float64
	Stream    string
	Line      string
}

func (r *TaskRepository) SetMaxLogsPerTask(maximum int) {
	r.store.writeMu.Lock()
	defer r.store.writeMu.Unlock()
	r.maxLogs = max(100, maximum)
}

// AppendLogsBulk returns the last inserted log ID, or zero for an empty batch.
// Prune counters become visible only after the entire transaction commits.
func (r *TaskRepository) AppendLogsBulk(ctx context.Context, rows []LogRow) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	prepared := append([]LogRow(nil), rows...)
	for i := range prepared {
		prepared[i].Line = redactText(prepared[i].Line, 8000)
	}
	r.store.writeMu.Lock()
	defer r.store.writeMu.Unlock()
	nextCounts := make(map[string]int)
	for _, row := range prepared {
		if _, ok := nextCounts[row.TaskID]; !ok {
			nextCounts[row.TaskID] = r.sincePrune[row.TaskID]
		}
		nextCounts[row.TaskID]++
	}
	var lastID int64
	err := r.store.writeLocked(ctx, func(tx *sql.Tx) error {
		stmt, err := tx.PrepareContext(ctx, "INSERT INTO task_logs(task_id,attempt_id,ts,stream,line) VALUES (?,?,?,?,?)")
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, row := range prepared {
			res, err := stmt.ExecContext(ctx, row.TaskID, row.AttemptID, row.Timestamp, row.Stream, row.Line)
			if err != nil {
				return err
			}
			lastID, err = res.LastInsertId()
			if err != nil {
				return err
			}
		}
		for taskID, count := range nextCounts {
			if count > r.maxLogs/4 {
				_, err = tx.ExecContext(ctx, `DELETE FROM task_logs WHERE task_id=? AND id NOT IN (SELECT id FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?)`, taskID, taskID, r.maxLogs)
				if err != nil {
					return err
				}
				nextCounts[taskID] = 0
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	for taskID, count := range nextCounts {
		r.sincePrune[taskID] = count
	}
	return lastID, nil
}

func (r *TaskRepository) AppendLog(ctx context.Context, taskID string, attemptID *string, stream, line string) (int64, error) {
	return r.AppendLogsBulk(ctx, []LogRow{{TaskID: taskID, AttemptID: attemptID, Timestamp: r.clock(), Stream: stream, Line: line}})
}

// GetLogs returns ascending IDs. A nonnil tail takes precedence over since/limit.
func (r *TaskRepository) GetLogs(ctx context.Context, taskID string, since int64, tail *int, limit int) ([]map[string]any, error) {
	if tail != nil {
		rows, err := queryMaps(ctx, r.store.reader, "SELECT * FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?", taskID, clamp(*tail, 1, 5000))
		slices.Reverse(rows)
		return rows, err
	}
	return queryMaps(ctx, r.store.reader, "SELECT * FROM task_logs WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?", taskID, max(0, since), clamp(limit, 1, 5000))
}

func (r *TaskRepository) GetEvents(ctx context.Context, taskID string, since int64, limit int) ([]map[string]any, error) {
	rows, err := queryMaps(ctx, r.store.reader, "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?", taskID, max(0, since), clamp(limit, 1, 5000))
	for _, row := range rows {
		decodeColumn(row, "payload_json", "payload", "{}", map[string]any{})
	}
	return rows, err
}
