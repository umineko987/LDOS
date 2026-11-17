package discoverydata

import (
	"encoding/json"
	"errors"
	"golang.org/x/text/cases"
	"io"
	"ldos/backend/internal/redaction"
	"strings"
	"unicode/utf8"
)

// ParseOutput consumes gallery-dl DataJob messages. A late extractor error is
// soft only when at least one candidate survived the requested limit.
func ParseOutput(site, stdout, sourceURL string, limit int) (candidates, authors []map[string]any, err error) {
	decoder := json.NewDecoder(strings.NewReader(stdout))
	decoder.UseNumber()
	var payload any
	decodeErr := decoder.Decode(&payload)
	if decodeErr == nil {
		var extra any
		decodeErr = decoder.Decode(&extra)
		if decodeErr == io.EOF {
			decodeErr = nil
		} else if decodeErr == nil {
			decodeErr = errors.New("extra JSON value")
		}
	}
	if decodeErr != nil {
		offset := jsonErrorOffset(stdout)
		prefix := stdout[:offset]
		line := strings.Count(prefix, "\n") + 1
		last := strings.LastIndex(prefix, "\n")
		return nil, nil, &Error{Code: "invalid_gallery_output", Message: "gallery-dl 搜索输出不是有效 JSON", Details: object{"line": line, "column": utf8.RuneCountInString(prefix[last+1:]) + 1}}
	}
	messages, ok := payload.([]any)
	if !ok {
		return nil, nil, &Error{Code: "invalid_gallery_output", Message: "gallery-dl 搜索输出结构无效"}
	}
	candidates = []object{}
	authors = []object{}
	byID := map[string]object{}
	authorKeys := map[string]bool{}
	extractorErrors := []string{}
	add := func(candidate object, related []object) {
		if candidate != nil {
			key := str(candidate["id"])
			if byID[key] == nil && len(candidates) < limit {
				byID[key] = candidate
				candidates = append(candidates, candidate)
			}
		}
		for _, a := range related {
			asite := str(first(a["site"], site))
			aid := strings.TrimSpace(stringOr(a["id"]))
			raw := str(first(a["works_url"], a["url"], a["name"], ""))
			key := raw
			if aid != "" {
				key = asite + ":id:" + aid
			} else if strings.Contains(raw, "://") {
				if canonical, e := CanonicalAddress(asite, raw); e == nil {
					key = canonical
				}
			} else {
				key = cases.Fold().String(raw)
			}
			if key != "" && !authorKeys[key] {
				authorKeys[key] = true
				authors = append(authors, a)
			}
		}
	}
	for _, raw := range messages {
		message, ok := raw.([]any)
		if !ok || len(message) == 0 {
			continue
		}
		d := obj(message[len(message)-1])
		if d == nil {
			continue
		}
		// Message codes are JSON numbers, not numeric strings.
		mt, ok := message[0].(json.Number)
		if !ok {
			continue
		}
		code, err := mt.Float64()
		if err != nil {
			continue
		}
		switch {
		case code == -1 && len(message) > 1:
			extractorErrors = append(extractorErrors, str(first(d["message"], d["error"], "extractor error")))
		case code == 2 && len(message) >= 2:
			switch site {
			case "twitter":
				add(twitterCandidate(d))
			case "pixiv":
				add(pixivCandidate(d))
			case "danbooru":
				add(danbooruCandidate(d))
			case "exhentai":
				add(exhentaiCandidate(d, sourceURL))
			case "pawchive":
				add(pawchiveCandidate(d))
			}
		case code == 6 && len(message) >= 3:
			u := str(message[1])
			switch site {
			case "exhentai":
				add(exhentaiQueue(u, d))
			case "danbooru":
				add(danbooruQueue(u, d))
			case "pawchive":
				add(pawchiveQueue(u, d))
			}
		case code == 3 && len(message) >= 3:
			id := d["id"]
			if site == "twitter" {
				id = d["tweet_id"]
			} else if site == "exhentai" {
				id = first(d["gid"], d["gallery_id"])
			}
			candidate := byID[str(id)]
			if candidate == nil {
				continue
			}
			media := stringOr(text(message[1], 8192))
			if site == "danbooru" && media != "" {
				candidate["downloadable"] = true
				candidate["download_unavailable_reason"] = nil
				candidate["download_url"] = candidate["url"]
			}
			if site == "twitter" && media != "" {
				urls := stringsOf(candidate["media_urls"])
				if !contains(urls, media) {
					urls = append(urls, media)
				}
				candidate["media_urls"] = urls
			}
			if site == "pawchive" {
				media = pawchiveThumbnail(media)
			}
			if media != "" && !truth(candidate["thumbnail_url"]) {
				candidate["thumbnail_url"] = media
			}
		}
	}
	if len(extractorErrors) > 0 && len(candidates) == 0 {
		safe := []string{}
		for _, e := range extractorErrors[:min(5, len(extractorErrors))] {
			safe = append(safe, redaction.Text(e, 500))
		}
		return nil, nil, &Error{Code: "extractor_error", Message: redaction.Text(extractorErrors[0], 1000), Details: object{"errors": safe}}
	}
	return candidates, authors, nil
}
