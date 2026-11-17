package datasets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

type handler func(*http.Request) (any, int, error)

func endpoint(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, status, e := fn(r)
		w.Header().Set("Content-Type", "application/json")
		if e != nil {
			var de *Error
			if !errors.As(e, &de) {
				de = failure(500, "internal_error", "内部错误")
			}
			details := de.Details
			w.WriteHeader(de.Status)
			_ = json.NewEncoder(w).Encode(Record{"error": Record{"code": de.Code, "message": de.Message, "details": details, "request_id": w.Header().Get("X-Request-ID")}})
			return
		}
		if status == 0 {
			status = 200
		}
		w.WriteHeader(status)
		if status != 204 {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
}
func (s *Service) Register(mux *http.ServeMux) {
	bind := func(pattern string, fn handler) { mux.HandleFunc(pattern, endpoint(fn)) }
	bind("GET /api/v1/datasets", func(r *http.Request) (any, int, error) {
		rows, e := s.List(r.Context())
		return Record{"items": rows}, 200, e
	})
	bind("POST /api/v1/datasets", func(r *http.Request) (any, int, error) {
		b, e := decodeRequest(r, datasetSchema(true))
		if e != nil {
			return nil, 0, e
		}
		v, e := s.Create(r.Context(), CreateOptions{Name: str(b["name"]), Kind: str(b["kind"]), TriggerWord: str(b["trigger_word"]), Config: object(b["config"])})
		return v, 201, e
	})
	bind("GET /api/v1/datasets/{dataset_id}", func(r *http.Request) (any, int, error) {
		v, e := s.Get(r.Context(), r.PathValue("dataset_id"))
		return v, 200, e
	})
	bind("PATCH /api/v1/datasets/{dataset_id}", func(r *http.Request) (any, int, error) {
		b, e := decodeRequest(r, datasetSchema(false))
		if e != nil {
			return nil, 0, e
		}
		v, e := s.Update(r.Context(), r.PathValue("dataset_id"), b)
		return v, 200, e
	})
	bind("DELETE /api/v1/datasets/{dataset_id}", func(r *http.Request) (any, int, error) {
		return nil, 204, s.Delete(r.Context(), r.PathValue("dataset_id"))
	})
	bind("GET /api/v1/datasets/{dataset_id}/funnel", func(r *http.Request) (any, int, error) {
		v, e := s.Funnel(r.Context(), r.PathValue("dataset_id"))
		return v, 200, e
	})
	bind("GET /api/v1/datasets/{dataset_id}/roots", func(r *http.Request) (any, int, error) {
		v, e := s.ListRoots(r.Context(), r.PathValue("dataset_id"))
		return Record{"items": v}, 200, e
	})
	bind("POST /api/v1/datasets/{dataset_id}/roots", func(r *http.Request) (any, int, error) {
		b, e := decodeRequest(r, rootsSchema())
		if e != nil {
			return nil, 0, e
		}
		id := r.PathValue("dataset_id")
		var v Record
		switch {
		case b["directory_id"] != nil:
			v, _, e = s.AttachDirectory(r.Context(), id, str(b["directory_id"]))
		case b["source_id"] != nil:
			v, _, e = s.AttachSource(r.Context(), id, str(b["source_id"]))
		default:
			v, _, e = s.AttachPath(r.Context(), id, str(b["path"]), str(b["display_name"]))
		}
		return v, 201, e
	})
	bind("DELETE /api/v1/datasets/{dataset_id}/roots/{root_id}", func(r *http.Request) (any, int, error) {
		return nil, 204, s.DetachRoot(r.Context(), r.PathValue("dataset_id"), r.PathValue("root_id"))
	})
	bind("GET /api/v1/datasets/{dataset_id}/members", func(r *http.Request) (any, int, error) {
		limit, e := queryLimit(r, 100, 500)
		if e != nil {
			return nil, 0, e
		}
		stage, e := queryStage(r)
		if e != nil {
			return nil, 0, e
		}
		q := r.URL.Query()
		decision := q.Get("decision")
		var issues []Record
		for _, rule := range []requestField{literalRule("decision", false, false, "excluded", "approved", "undecided", "kept"), stringRule("query", 0, 200, false, false), stringRule("cursor", 0, 2048, false, false)} {
			if q.Has(rule.name) {
				_, found := rule.validate(q.Get(rule.name), []any{"query", rule.name})
				issues = append(issues, found...)
			}
		}
		if len(issues) > 0 {
			return nil, 0, validationError(issues...)
		}
		if _, ok := q["cursor"]; ok && q.Get("cursor") == "" {
			return nil, 0, failure(422, "invalid_dataset_cursor", "分页游标无效")
		}
		v, e := s.MembersPage(r.Context(), r.PathValue("dataset_id"), MemberOptions{Stage: stage, Decision: decision, Query: q.Get("query"), Cursor: q.Get("cursor"), Limit: limit})
		return v, 200, e
	})
	bind("POST /api/v1/datasets/{dataset_id}/decisions", func(r *http.Request) (any, int, error) {
		b, e := decodeRequest(r, decisionsSchema())
		if e != nil {
			return nil, 0, e
		}
		list := b["asset_ids"].([]any)
		ids := make([]string, len(list))
		for i, value := range list {
			ids[i] = value.(string)
		}
		v, e := s.Decide(r.Context(), r.PathValue("dataset_id"), str(b["stage"]), ids, str(b["decision"]), str(b["reason"]))
		return v, 200, e
	})
	bind("GET /api/v1/datasets/{dataset_id}/stage-runs", func(r *http.Request) (any, int, error) {
		limit, e := queryLimit(r, 50, 500)
		if e != nil {
			return nil, 0, e
		}
		stage, e := queryStage(r)
		if e != nil {
			return nil, 0, e
		}
		v, e := s.ListStageRuns(r.Context(), r.PathValue("dataset_id"), stage, limit)
		return Record{"items": v}, 200, e
	})
	bind("GET /api/v1/datasets/{dataset_id}/hashing", func(r *http.Request) (any, int, error) {
		v, e := s.HashingStatus(r.Context(), r.PathValue("dataset_id"))
		return v, 200, e
	})
	bind("POST /api/v1/datasets/{dataset_id}/hashing", func(r *http.Request) (any, int, error) {
		v, e := s.EnqueueHashing(r.Context(), r.PathValue("dataset_id"))
		return v, 202, e
	})
	bind("GET /api/v1/datasets/{dataset_id}/crawls", func(r *http.Request) (any, int, error) {
		v, e := s.ListCrawls(r.Context(), r.PathValue("dataset_id"))
		return Record{"items": v}, 200, e
	})
	bind("POST /api/v1/datasets/{dataset_id}/crawls", func(r *http.Request) (any, int, error) {
		raw, e := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		if e != nil || !json.Valid(raw) || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
			return nil, 0, validation()
		}
		v, e := s.StartCrawl(r.Context(), r.PathValue("dataset_id"), raw, r.Header.Get("Idempotency-Key"))
		return v, 202, e
	})
	bind("POST /api/v1/datasets/{dataset_id}/exports", func(r *http.Request) (any, int, error) {
		b, e := decodeRequest(r, exportSchema())
		if e != nil {
			return nil, 0, e
		}
		dry := boolOption(b, "dry_run", false)
		delete(b, "dry_run")
		if dry {
			v, e := s.PreviewExport(r.Context(), r.PathValue("dataset_id"), b)
			return Record{"dry_run": true, "plan": v, "job": nil}, 200, e
		}
		v, e := s.CreateExport(r.Context(), r.PathValue("dataset_id"), b)
		return Record{"dry_run": false, "plan": nil, "job": v}, 202, e
	})
	bind("GET /api/v1/datasets/{dataset_id}/exports", func(r *http.Request) (any, int, error) {
		limit, e := queryLimit(r, 50, 200)
		if e != nil {
			return nil, 0, e
		}
		v, e := s.ListExports(r.Context(), r.PathValue("dataset_id"), limit)
		return Record{"items": v}, 200, e
	})
	bind("GET /api/v1/exports/{export_id}", func(r *http.Request) (any, int, error) {
		v, e := s.GetExport(r.Context(), r.PathValue("export_id"))
		return v, 200, e
	})
	bind("POST /api/v1/exports/{export_id}/cancel", func(r *http.Request) (any, int, error) {
		v, e := s.CancelExport(r.Context(), r.PathValue("export_id"))
		return v, 200, e
	})
	bind("POST /api/v1/exports/{export_id}/resume", func(r *http.Request) (any, int, error) {
		v, e := s.ResumeExport(r.Context(), r.PathValue("export_id"))
		return v, 202, e
	})
}

// Callback adapters make main's wiring explicit without importing peer packages.
type CatalogCallbacks struct {
	Import func(context.Context, string, string) (string, error)
	Scan   func(context.Context, string) error
}

func (c CatalogCallbacks) ImportSource(ctx context.Context, p, name string) (string, error) {
	return c.Import(ctx, p, name)
}
func (c CatalogCallbacks) StartScan(ctx context.Context, id string) error { return c.Scan(ctx, id) }

type CrawlCallback func(context.Context, json.RawMessage, string) (string, error)

func (f CrawlCallback) StartCrawl(ctx context.Context, body json.RawMessage, key string) (string, error) {
	return f(ctx, body, key)
}
