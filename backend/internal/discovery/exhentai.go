package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

// ExhentaiAdapter delegates gallery enumeration and enriches it with EH gdata.
type ExhentaiAdapter struct {
	Transport       *Transport
	GalleryDiscover func(context.Context, Request) (map[string]any, error)
}

var ehGalleryPath = regexp.MustCompile(`/(?:g|s|mpv)/`)

const ehAPI = "https://api.e-hentai.org/api.php"

func (a *ExhentaiAdapter) Search(ctx context.Context, request Request) (map[string]any, error) {
	spec, err := discoverydata.SearchSite("exhentai")
	if err != nil {
		return nil, err
	}
	keyword := ""
	if request.Keyword != nil {
		keyword = *request.Keyword
	}
	request.URL, err = spec.SearchURL(keyword)
	if err != nil {
		return nil, err
	}
	request.Site, request.RangeKind = spec.Site, spec.SearchRange
	// Search retries belong to the transport so a slow node can be replaced.
	request.Policy.HTTPTimeout = min(request.Policy.HTTPTimeout, 10)
	request.Policy.GalleryRetries = 0
	return a.GalleryDiscover(ctx, request)
}

func (a *ExhentaiAdapter) Discover(ctx context.Context, request Request) (map[string]any, error) {
	request.Site = "exhentai"
	if request.RangeKind == "" {
		if ehGalleryPath.MatchString(request.URL) {
			request.RangeKind, request.Limit = "file", 1
			request.RangeLimit = nil
		} else {
			spec, err := discoverydata.SearchSite("exhentai")
			if err != nil {
				return nil, err
			}
			request.RangeKind = spec.SearchRange
		}
	}
	return a.GalleryDiscover(ctx, request)
}

func ehObjects(value any) []map[string]any {
	if rows, ok := value.([]map[string]any); ok {
		return rows
	}
	rows := []map[string]any{}
	if values, ok := value.([]any); ok {
		for _, value := range values {
			if row, ok := value.(map[string]any); ok {
				rows = append(rows, row)
			}
		}
	}
	return rows
}
func ehTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case int:
		return v != 0
	case float64:
		return v != 0
	case json.Number:
		number, err := v.Float64()
		return err != nil || number != 0
	case []any:
		return len(v) != 0
	case []string:
		return len(v) != 0
	case map[string]any:
		return len(v) != 0
	default:
		return true
	}
}
func ehAuthorKey(author map[string]any) string {
	for _, key := range []string{"works_url", "url", "name"} {
		if ehTruthy(author[key]) {
			return stringValue(author[key])
		}
	}
	return ""
}

type ehStatusError struct{ status int }

func (e *ehStatusError) Error() string {
	return fmt.Sprintf("EH gdata API: %d %s", e.status, http.StatusText(e.status))
}

func ehClassify(err error, attempt Attempt) *Failure {
	message := redaction.Text(err.Error(), 1000, leaseSecrets(attempt.Lease)...)
	code := 1
	decision := scheduler.Classify(&code, message, false, false)
	var status *ehStatusError
	var network net.Error
	transient := errors.As(err, &network) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
	if errors.As(err, &status) {
		transient = status.status == 408 || status.status == 425 || status.status == 429 || status.status >= 500
	}
	return &Failure{Message: message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable || transient || decision.ProxyFault, ProxyFault: attempt.Lease != nil && (decision.ProxyFault || transient)}
}

func (a *ExhentaiAdapter) EnrichPreviews(ctx context.Context, result map[string]any, policy scheduler.Policy, mode string, timeoutSeconds float64) (map[string]any, error) {
	candidates := ehObjects(result["candidates"])
	pairs := []any{}
	seen := map[int]bool{}
	for _, candidate := range candidates {
		gid, valid := integer(candidate["id"])
		metadata, _ := candidate["metadata"].(map[string]any)
		token := []rune(strings.TrimSpace(stringValue(metadata["gallery_token"])))
		if !valid || len(token) == 0 || seen[gid] {
			continue
		}
		pairs = append(pairs, []any{gid, string(token[:min(100, len(token))])})
		seen[gid] = true
	}
	if len(pairs) == 0 {
		result["preview_count"], result["preview_missing_count"] = 0, len(candidates)
		return result, nil
	}
	if mode == "" {
		mode = policy.ProxyMode
	}
	prevalidated := mode == "direct"
	if prevalidated {
		if err := a.Transport.ValidateDirect(ctx, ehAPI); err != nil {
			return nil, err
		}
	}
	timeout := duration(max(1, min(policy.HTTPTimeout, timeoutSeconds)))
	rows := []map[string]any{}
	for offset := 0; offset < len(pairs); offset += 25 {
		batch := pairs[offset:min(offset+25, len(pairs))]
		outcome, err := a.Transport.Execute(ctx, ExecuteOptions{
			URL: ehAPI, Mode: mode, Prefix: "eh-preview", Policy: policy, Secure: true,
			AcquireErrorFatal: true, DirectPrevalidated: prevalidated, NodeTags: policy.NodeTags,
			Classify: ehClassify,
			Operation: func(ctx context.Context, attempt Attempt) (any, error) {
				response, err := a.Transport.HTTPRequest(ctx, http.MethodPost, ehAPI, nil, map[string]any{"method": "gdata", "gidlist": batch, "namespace": 1}, attempt.Endpoint(), timeout)
				if err != nil {
					return nil, err
				}
				if response.StatusCode >= 300 && response.StatusCode < 400 {
					return nil, errors.New("EH gdata API 返回了未接受的重定向")
				}
				if response.StatusCode >= 400 {
					return nil, &ehStatusError{response.StatusCode}
				}
				if response.JSONError != nil {
					return nil, fmt.Errorf("EH gdata API JSON 无效: %v", response.JSONError)
				}
				payload, ok := response.Payload.(map[string]any)
				if !ok {
					return nil, errors.New("EH gdata API 返回结构无效")
				}
				if ehTruthy(payload["error"]) {
					return nil, errors.New(stringValue(payload["error"]))
				}
				switch payload["gmetadata"].(type) {
				case []any, []map[string]any:
				default:
					return nil, errors.New("EH gdata API 缺少 gmetadata")
				}
				return ehObjects(payload["gmetadata"]), nil
			},
		})
		if err != nil {
			var exhausted *Exhausted
			if errors.As(err, &exhausted) {
				return nil, &Error{Code: "exhentai_preview_lookup_failed", Message: exhausted.Failure.Message, Details: map[string]any{"attempts": exhausted.Attempts, "proxy": exhausted.Proxy}}
			}
			return nil, err
		}
		rows = append(rows, outcome.Value.([]map[string]any)...)
	}
	byID := map[string]map[string]any{}
	for _, row := range rows {
		if _, ok := integer(row["gid"]); ok && !ehTruthy(row["error"]) {
			byID[stringValue(row["gid"])] = row
		}
	}
	authors := append([]map[string]any{}, ehObjects(result["authors"])...)
	authorKeys := map[string]bool{}
	for _, author := range authors {
		authorKeys[ehAuthorKey(author)] = true
	}
	enrichedCandidates := make([]map[string]any, 0, len(candidates))
	count := 0
	for _, candidate := range candidates {
		row := byID[stringValue(candidate["id"])]
		if row == nil {
			enrichedCandidates = append(enrichedCandidates, candidate)
			continue
		}
		normalized := make(map[string]any, len(row))
		for key, value := range row {
			normalized[key] = value
		}
		for _, field := range []string{"title", "title_jpn", "uploader"} {
			if value := normalized[field]; value != nil {
				normalized[field] = html.UnescapeString(stringValue(value))
			}
		}
		switch tags := normalized["tags"].(type) {
		case []any:
			values := make([]any, len(tags))
			for i, tag := range tags {
				values[i] = html.UnescapeString(stringValue(tag))
			}
			normalized["tags"] = values
		case []string:
			values := make([]any, len(tags))
			for i, tag := range tags {
				values[i] = html.UnescapeString(tag)
			}
			normalized["tags"] = values
		}
		source := stringValue(candidate["url"])
		if source == "" {
			source = stringValue(result["search_url"])
		}
		enriched, foundAuthors := discoverydata.ExhentaiDirectoryCandidate(normalized, source)
		if enriched == nil {
			enrichedCandidates = append(enrichedCandidates, candidate)
			continue
		}
		metadata, _ := candidate["metadata"].(map[string]any)
		enriched["metadata"].(map[string]any)["gallery_token"] = metadata["gallery_token"]
		if ehTruthy(candidate["matched_keywords"]) {
			enriched["matched_keywords"] = candidate["matched_keywords"]
		}
		enrichedCandidates = append(enrichedCandidates, enriched)
		count++
		for _, author := range foundAuthors {
			key := ehAuthorKey(author)
			if !authorKeys[key] {
				authors = append(authors, author)
				authorKeys[key] = true
			}
		}
	}
	result["candidates"], result["authors"] = enrichedCandidates, authors
	result["candidate_count"], result["author_count"] = len(enrichedCandidates), len(authors)
	result["preview_count"], result["preview_missing_count"] = count, len(enrichedCandidates)-count
	return result, nil
}
