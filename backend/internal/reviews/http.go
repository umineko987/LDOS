package reviews

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/store"
)

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/crawls/{batch_id}/review", s.httpCrawlGet)
	for _, op := range []string{"start", "retry", "apply"} {
		mux.HandleFunc("POST /api/v1/crawls/{batch_id}/review/"+op, s.httpCrawlOperation(op))
	}
	mux.HandleFunc("PUT /api/v1/crawls/{batch_id}/review/decisions", s.httpCrawlDecisions)
	mux.HandleFunc("GET /api/v1/crawls/{batch_id}/review/images/{image_id}", s.httpImage(false))
	mux.HandleFunc("GET /api/v1/gallery/review-presets", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.ListPresets(r.Context())
		respond(w, 200, Row{"items": v}, e)
	})
	mux.HandleFunc("POST /api/v1/gallery/review-presets", s.httpSavePreset(false))
	mux.HandleFunc("PUT /api/v1/gallery/review-presets/{preset_id}", s.httpSavePreset(true))
	mux.HandleFunc("DELETE /api/v1/gallery/review-presets/{preset_id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 204, nil, s.DeletePreset(r.Context(), r.PathValue("preset_id")))
	})
	mux.HandleFunc("POST /api/v1/gallery/reviews", s.httpGalleryCreate)
	mux.HandleFunc("GET /api/v1/gallery/reviews/{review_id}", s.httpGalleryGet)
	mux.HandleFunc("POST /api/v1/gallery/reviews/{review_id}/groups/{group_id}/adopt", s.httpAdopt)
	mux.HandleFunc("POST /api/v1/gallery/reviews/{review_id}/retry", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.RetryGallery(r.Context(), r.PathValue("review_id"))
		respondOperation(w, 202, v, true, true, e)
	})
	mux.HandleFunc("POST /api/v1/gallery/reviews/{review_id}/finish", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 204, nil, s.FinishGallery(r.Context(), r.PathValue("review_id")))
	})
	mux.HandleFunc("GET /api/v1/gallery/reviews/{review_id}/images/{image_id}", s.httpImage(true))
}
func respond(w http.ResponseWriter, status int, v any, e error) {
	if e != nil {
		public := &Error{Status: 500, Code: "internal_error", Message: "审核请求失败"}
		var defined *Error
		if errors.As(e, &defined) {
			public = defined
		} else if errors.Is(e, context.Canceled) || errors.Is(e, context.DeadlineExceeded) {
			public = &Error{Status: 409, Code: "review_state_conflict", Message: "审核操作已取消"}
		}
		status = public.Status
		v = Row{"error": Row{"code": public.Code, "message": public.Message, "details": public.Details, "request_id": w.Header().Get("X-Request-ID")}}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	if status != 204 {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func decodeBody(w http.ResponseWriter, r *http.Request, v any) error {
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 32*1024*1024))
	if e != nil {
		return invalid("请求体过大或不可读取")
	}
	if !utf8.Valid(data) {
		return invalid("请求体必须是 UTF-8 JSON")
	}
	var object map[string]json.RawMessage
	if e = json.Unmarshal(data, &object); e != nil || object == nil {
		return invalid("请求体必须是 JSON 对象")
	}
	for _, k := range []string{"directory_ids", "asset_ids", "selected_image_ids", "groups", "options"} {
		if raw, ok := object[k]; ok && string(bytes.TrimSpace(raw)) == "null" {
			return invalid(k + " 不能为 null")
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if e = d.Decode(v); e != nil {
		return invalid("请求字段类型、必填字段或未知字段无效")
	}
	return nil
}
func reviewView(r *http.Request, gallery bool) (bool, error) {
	view := r.URL.Query().Get("view")
	if !r.URL.Query().Has("view") {
		return gallery, nil
	}
	if view == "desktop" {
		return true, nil
	}
	if view == "legacy" && !gallery {
		return false, nil
	}
	return false, invalid("view 无效")
}
func query(r *http.Request, gallery bool) (GroupQuery, bool, error) {
	q := GroupQuery{Limit: 12}
	desktop, e := reviewView(r, gallery)
	if e != nil {
		return q, false, e
	}
	values := r.URL.Query()
	for key, pointer := range map[string]*int{"limit": &q.Limit, "offset": &q.Offset} {
		if values.Has(key) {
			v, e := strconv.Atoi(values.Get(key))
			if e != nil {
				return q, false, invalid("分页参数必须是整数")
			}
			*pointer = v
		}
	}
	if !gallery {
		q.Kind = values.Get("kind")
		if values.Has("all") {
			switch strings.ToLower(values.Get("all")) {
			case "true", "1", "yes", "on":
				q.All = true
			case "false", "0", "no", "off":
			default:
				return q, false, invalid("all 必须是布尔值")
			}
		}
	}
	q.Classification = values.Get("classification")
	if values.Has("classification") && q.Classification == "" || !gallery && values.Has("kind") && q.Kind == "" {
		return q, false, invalid("审核筛选参数无效")
	}
	if q.Limit == 0 {
		return q, false, invalid("limit 必须为 1..50")
	}
	q, e = validateQuery(q)
	return q, desktop, e
}
func (s *Service) httpCrawlGet(w http.ResponseWriter, r *http.Request) {
	q, desktop, e := query(r, false)
	if e != nil {
		respond(w, 0, nil, e)
		return
	}
	v, e := s.detail(r.Context(), identity{r.PathValue("batch_id"), false}, q, desktop)
	respond(w, 200, v, e)
}
func (s *Service) httpGalleryGet(w http.ResponseWriter, r *http.Request) {
	q, desktop, e := query(r, true)
	if e != nil {
		respond(w, 0, nil, e)
		return
	}
	v, e := s.detail(r.Context(), identity{r.PathValue("review_id"), true}, q, desktop)
	respond(w, 200, v, e)
}
func (s *Service) httpCrawlOperation(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		desktop, e := reviewView(r, false)
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		var v Row
		status := 202
		switch op {
		case "start":
			v, e = s.StartCrawl(r.Context(), r.PathValue("batch_id"))
		case "retry":
			v, e = s.RetryCrawl(r.Context(), r.PathValue("batch_id"))
		case "apply":
			status = 200
			v, e = s.ApplyCrawl(r.Context(), r.PathValue("batch_id"))
		}
		respondOperation(w, status, v, desktop, false, e)
	}
}
func (s *Service) httpCrawlDecisions(w http.ResponseWriter, r *http.Request) {
	desktop, e := reviewView(r, false)
	if e != nil {
		respond(w, 0, nil, e)
		return
	}
	var body struct {
		Groups []Decision `json:"groups"`
	}
	if e = decodeBody(w, r, &body); e != nil {
		respond(w, 0, nil, e)
		return
	}
	for n := range body.Groups {
		for j := range body.Groups[n].SelectedImageIDs {
			body.Groups[n].SelectedImageIDs[j] = strings.TrimSpace(body.Groups[n].SelectedImageIDs[j])
		}
	}
	v, e := s.UpdateCrawlDecisions(r.Context(), r.PathValue("batch_id"), body.Groups)
	respondOperation(w, 200, v, desktop, false, e)
}
func (s *Service) httpSavePreset(update bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name    string         `json:"name"`
			Options *FilterOptions `json:"options"`
		}
		e := decodeBody(w, r, &body)
		if e == nil && body.Options == nil {
			e = invalid("options 是必填字段")
		}
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		id := ""
		status := 201
		if update {
			id = r.PathValue("preset_id")
			status = 200
		}
		v, e := s.SavePreset(r.Context(), id, body.Name, *body.Options)
		respond(w, status, v, e)
	}
}
func (s *Service) httpGalleryCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DirectoryIDs []string      `json:"directory_ids"`
		AssetIDs     []string      `json:"asset_ids"`
		FilterConfig *FilterConfig `json:"filter_config"`
	}
	if e := decodeBody(w, r, &body); e != nil {
		respond(w, 0, nil, e)
		return
	}
	v, e := s.CreateGallery(r.Context(), body.DirectoryIDs, body.AssetIDs, body.FilterConfig)
	respondOperation(w, 202, v, true, true, e)
}
func (s *Service) httpAdopt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SelectedImageIDs []string `json:"selected_image_ids"`
		Version          int64    `json:"version"`
	}
	e := decodeBody(w, r, &body)
	if e == nil && body.Version < 1 {
		e = invalid("version 必须大于等于 1")
	}
	if e == nil {
		e = validateIDs(body.SelectedImageIDs, 200, false)
	}
	if e != nil {
		respond(w, 0, nil, e)
		return
	}
	v, e := s.AdoptGroup(r.Context(), r.PathValue("review_id"), r.PathValue("group_id"), unique(body.SelectedImageIDs), body.Version, false)
	respondOperation(w, 200, v, true, true, e)
}
func (s *Service) httpImage(gallery bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var v ImageContent
		var e error
		if gallery {
			v, e = s.OpenGalleryImage(r.Context(), r.PathValue("review_id"), r.PathValue("image_id"))
		} else {
			v, e = s.OpenCrawlImage(r.Context(), r.PathValue("batch_id"), r.PathValue("image_id"))
		}
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		defer v.Close()
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, v.Name, v.Modified, v)
	}
}
func respondOperation(w http.ResponseWriter, status int, v Row, desktop, gallery bool, e error) {
	if e == nil && desktop {
		v, e = projectReview(v, nil, nil, gallery)
	}
	respond(w, status, v, e)
}

// Detail reads summary, version, bindings and groups in one SQLite snapshot.
func (s *Service) detail(ctx context.Context, i identity, q GroupQuery, desktop bool) (Row, error) {
	var result Row
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if !i.gallery {
			batch, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_batches WHERE id=?", i.id)
			if e != nil {
				return e
			}
			if batch == nil {
				return failure(404, "crawl_not_found", "爬取批次不存在")
			}
			if !terminal(text(batch["status"])) {
				return failure(409, "crawl_not_finished", "爬取批次结束后才会进入图片审核")
			}
		}
		review, e := getTx(ctx, tx, i)
		if e != nil {
			if err, ok := e.(*Error); !ok || err.Status != 404 || i.gallery {
				return e
			}
			status := "disabled"
			if s.enabled.Load() {
				status = "not_started"
			}
			review = Row{"batch_id": i.id, "status": status}
		}
		page := Page{Items: []Row{}, Limit: q.Limit, Offset: q.Offset}
		if q.All {
			page.Limit = 0
			page.Offset = 0
		}
		state := text(review["status"])
		if i.gallery || state == "ready" || state == "applying" || state == "applied" || state == "apply_failed" {
			page, e = groupsTx(ctx, tx, i, q)
			if e != nil {
				return e
			}
		}
		var snapshots []Snapshot
		if i.gallery {
			row, e := store.QueryRowTx(ctx, tx, "SELECT snapshot_json FROM gallery_reviews WHERE review_id=?", i.id)
			if e != nil {
				return e
			}
			_ = decodeJSON(text(row["snapshot_json"]), &snapshots)
		} else {
			for _, g := range page.Items {
				for _, im := range g["images"].([]Row) {
					im["url"] = "/api/v1/crawls/" + url.PathEscape(i.id) + "/review/images/" + url.PathEscape(text(im["id"]))
				}
			}
		}
		if desktop {
			result, e = projectReview(review, &page, snapshots, i.gallery)
			return e
		}
		review["groups"] = page
		result = review
		return nil
	})
	return result, e
}
func bounded(v any, max int64) int64 {
	n := number(v)
	if n < 0 {
		return 0
	}
	if n > max {
		return max
	}
	return n
}
func projectReview(review Row, page *Page, snapshots []Snapshot, gallery bool) (Row, error) {
	profile := "desktop-review"
	identityKey := "batch_id"
	if gallery {
		profile = "desktop-gallery-review"
		identityKey = "review_id"
	}
	if page == nil {
		profile += "-operation"
	}
	result := Row{"response_profile": profile + "-v1", identityKey: clip(text(review[identityKey]), 128), "status": clip(text(review["status"]), 32), "hasError": text(review["error"]) != ""}
	for _, p := range [][2]string{{"total_image_count", "totalImageCount"}, {"total_group_count", "totalGroupCount"}, {"duplicate_group_count", "duplicateGroupCount"}, {"unreadable_image_count", "unreadableImageCount"}, {"automatic_group_count", "automaticGroupCount"}, {"automatic_rejected_image_count", "automaticRejectedImageCount"}, {"selected_image_count", "selectedImageCount"}, {"decided_group_count", "decidedGroupCount"}, {"kept_image_count", "keptImageCount"}, {"rejected_image_count", "rejectedImageCount"}, {"failed_image_count", "failedImageCount"}} {
		result[p[1]] = bounded(review[p[0]], 1000000000)
	}
	if gallery {
		for _, key := range []string{"version", "directories", "created_at", "updated_at", "filter_config"} {
			result[key] = review[key]
		}
		result["filteredImageCount"] = bounded(review["filtered_image_count"], 1000000000)
	}
	if page == nil {
		return result, nil
	}
	bindings := map[string]Snapshot{}
	for _, v := range snapshots {
		bindings[v.AssetID] = v
	}
	groups := []Row{}
	used := 0
	for _, g := range page.Items {
		images, _ := g["images"].([]Row)
		if len(images) > 1000 {
			return nil, failure(413, "review_group_too_large", "单个审核组超过 1000 张图片上限")
		}
		projected := Row{"id": clip(text(g["id"]), 128), "ordinal": bounded(g["ordinal"], 100000), "kind": clip(text(g["kind"]), 32), "decided": truth(g["decided"])}
		out := []Row{}
		for _, image := range images {
			m, _ := image["metadata"].(map[string]any)
			width, ok := m["w"]
			if !ok {
				width = m["width"]
			}
			height, ok := m["h"]
			if !ok {
				height = m["height"]
			}
			metadata := Row{"w": bounded(width, 1000000), "h": bounded(height, 1000000)}
			classification := text(m["classification"])
			if classification == "rough" || classification == "monochrome" {
				metadata["classification"] = classification
			}
			im := Row{"id": clip(text(image["id"]), 128), "ordinal": bounded(image["ordinal"], 100000), "readable": truth(image["readable"]), "recommended": truth(image["recommended"]), "selected": truth(image["selected"]), "metadata": metadata}
			if gallery {
				if b, ok := bindings[text(image["id"])]; ok {
					im["asset_id"] = b.AssetID
					im["source_id"] = b.SourceID
					im["directory_id"] = b.DirectoryID
					im["relative_path"] = b.RelativePath
					im["source_display_name"] = b.SourceDisplayName
				}
				im["disposition"] = image["disposition"]
				im["hasError"] = text(image["error"]) != ""
				im["url"] = "/api/v1/gallery/reviews/" + url.PathEscape(text(review["review_id"])) + "/images/" + url.PathEscape(text(image["id"]))
			}
			out = append(out, im)
		}
		projected["images"] = out
		size := asciiJSONSize(projected) + 1
		if used+size > 768*1024 {
			if len(groups) == 0 {
				return nil, failure(413, "review_group_response_too_large", "单个审核组超过桌面响应预算")
			}
			break
		}
		used += size
		groups = append(groups, projected)
	}
	result["groups"] = Row{"items": groups, "byte_truncated": len(groups) < len(page.Items), "total": bounded(page.Total, MaxGroups), "limit": bounded(page.Limit, MaxGroups), "offset": bounded(page.Offset, MaxGroups)}
	return result, nil
}
func asciiJSONSize(v any) int {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	n := 0
	for _, r := range strings.TrimSuffix(b.String(), "\n") {
		switch {
		case r < 128:
			n++
		case r <= 0xffff:
			n += 6
		default:
			n += 12
		}
	}
	return n
}
