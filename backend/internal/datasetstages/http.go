package datasetstages

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"

	"ldos/backend/internal/captions"
)

func AcceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		pieces := strings.Split(part, ";")
		coding := strings.ToLower(strings.TrimSpace(pieces[0]))
		if coding != "gzip" && coding != "*" {
			continue
		}
		quality := 1.0
		for _, p := range pieces[1:] {
			k, v, _ := strings.Cut(p, "=")
			if strings.EqualFold(strings.TrimSpace(k), "q") {
				quality, _ = strconv.ParseFloat(strings.TrimSpace(v), 64)
			}
		}
		return quality > 0
	}
	return false
}
func pageOptions(r *http.Request, clean bool) (PageOptions, error) {
	o := PageOptions{State: "all", IncludeAutomatic: true, Limit: 50}
	if clean {
		o.Limit = 100
	}
	q := r.URL.Query()
	if q.Has("state") {
		o.State = q.Get("state")
	}
	o.Reason = q.Get("reason")
	var e error
	for key, p := range map[string]*int{"offset": &o.Offset, "limit": &o.Limit} {
		if q.Has(key) {
			*p, e = strconv.Atoi(q.Get(key))
			if e != nil {
				return o, fail(422, "validation_error", "分页参数无效")
			}
		}
	}
	if q.Has("include_automatic") {
		o.IncludeAutomatic, e = strconv.ParseBool(q.Get("include_automatic"))
		if e != nil {
			return o, fail(422, "validation_error", "include_automatic 无效")
		}
	}
	return o, nil
}
func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/stages/tag/run", func(w http.ResponseWriter, r *http.Request) {
		o := struct {
			Models    []string `json:"models"`
			BatchSize int      `json:"batch_size"`
		}{BatchSize: 8}
		if e := captions.Decode(w, r, &o, false); e != nil {
			captions.Respond(w, 202, nil, e)
			return
		}
		v, e := s.RunTag(r.Context(), r.PathValue("dataset_id"), o.Models, o.BatchSize)
		captions.Respond(w, 202, v, e)
	})
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/tagger/candidates", func(w http.ResponseWriter, r *http.Request) {
		models := []string{}
		for _, key := range strings.Split(r.URL.Query().Get("models"), ",") {
			if key = strings.TrimSpace(key); key != "" {
				models = append(models, key)
			}
		}
		floor := CandidateFloor
		if raw := r.URL.Query().Get("floor"); raw != "" {
			v, e := strconv.ParseFloat(raw, 64)
			if e != nil {
				captions.Respond(w, 200, nil, fail(422, "validation_error", "floor 无效"))
				return
			}
			floor = v
		}
		etag, body, e := s.Candidates(r.Context(), r.PathValue("dataset_id"), models, floor)
		if e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		w.Header().Set("Vary", "Accept-Encoding")
		if !captions.ETagMatches(r.Header.Get("If-None-Match"), etag) && len(body) >= 1024 && AcceptsGzip(r.Header.Get("Accept-Encoding")) {
			var buf bytes.Buffer
			z, _ := gzip.NewWriterLevel(&buf, 5)
			_, _ = z.Write(body)
			_ = z.Close()
			body = buf.Bytes()
			w.Header().Set("Content-Encoding", "gzip")
		}
		captions.CachedJSON(w, r, etag, body)
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/captions/from-tagger", func(w http.ResponseWriter, r *http.Request) {
		o := FromTaggerOptions{Mode: "merge", SampleLimit: 20, Thresholds: map[string]map[string]float64{}}
		if e := captions.Decode(w, r, &o, false); e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		v, e := s.CaptionsFromTagger(r.Context(), r.PathValue("dataset_id"), o)
		captions.Respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/stages/{stage}/run", func(w http.ResponseWriter, r *http.Request) {
		var o RunOptions
		if e := captions.Decode(w, r, &o, true); e != nil {
			captions.Respond(w, 202, nil, e)
			return
		}
		v, e := s.Run(r.Context(), r.PathValue("dataset_id"), r.PathValue("stage"), o)
		captions.Respond(w, 202, v, e)
	})
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/stages/{stage}/triage", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Summary(r.Context(), r.PathValue("dataset_id"), r.PathValue("stage"))
		captions.Respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/stages/dedup/groups", func(w http.ResponseWriter, r *http.Request) {
		o, e := pageOptions(r, false)
		if e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		v, e := s.DedupGroups(r.Context(), r.PathValue("dataset_id"), o)
		captions.Respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/stages/clean/items", func(w http.ResponseWriter, r *http.Request) {
		o, e := pageOptions(r, true)
		if e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		v, e := s.CleanItems(r.Context(), r.PathValue("dataset_id"), o)
		captions.Respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/stages/{stage}/apply", func(w http.ResponseWriter, r *http.Request) {
		var o struct {
			RunID  string          `json:"run_id"`
			Groups []GroupDecision `json:"groups"`
		}
		if e := captions.Decode(w, r, &o, false); e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		v, e := s.Apply(r.Context(), r.PathValue("dataset_id"), r.PathValue("stage"), o.RunID, o.Groups)
		captions.Respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/stages/{stage}/undo", func(w http.ResponseWriter, r *http.Request) {
		var o struct {
			BatchID string `json:"batch_id"`
		}
		if e := captions.Decode(w, r, &o, true); e != nil {
			captions.Respond(w, 200, nil, e)
			return
		}
		v, e := s.Undo(r.Context(), r.PathValue("dataset_id"), r.PathValue("stage"), o.BatchID)
		captions.Respond(w, 200, v, e)
	})
}
