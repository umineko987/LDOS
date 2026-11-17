package crawls

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"ldos/backend/internal/scheduler"
)

type Unit struct {
	URL       string   `json:"url"`
	Site      string   `json:"site"`
	Kind      string   `json:"kind"`
	SourceID  string   `json:"source_id"`
	ExtraArgs []string `json:"extra_args"`
	SourceKey *string  `json:"source_key"`
	SourceURL *string  `json:"source_url"`
}
type HashedUnit struct {
	Unit   Unit
	Digest string
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var pixivPageRE = regexp.MustCompile(`(?i)^/(?:en/)?artworks/([0-9]+)(?:/|$)`)
var pixivLegacyRE = regexp.MustCompile(`(?i)^/i/([0-9]+)(?:/|$)`)
var pixivMediaRE = regexp.MustCompile(`(?i)^([0-9]+)(?:_|\.|$)`)
var oldPixivHostRE = regexp.MustCompile(`(?i)^(?:i[0-9]+|img[0-9]*)\.pixiv\.net$`)
var twitterStatusRE = regexp.MustCompile(`(?i)/(?:status|statuses)/([0-9]+)(?:/|$)`)
var digitsRE = regexp.MustCompile(`^[0-9]+$`)
var twitterHosts = map[string]bool{"twitter.com": true, "fxtwitter.com": true, "vxtwitter.com": true, "x.com": true, "fixupx.com": true, "fixvx.com": true}

func SourceKeyFromURL(value string) *string {
	value = html.UnescapeString(strings.TrimSpace(value))
	if value == "" {
		return nil
	}
	if strings.HasPrefix(value, "//") {
		value = "https:" + value
	} else if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, e := url.Parse(value)
	if e != nil {
		return nil
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	p := u.EscapedPath()
	if host == "pixiv.net" || strings.HasSuffix(host, ".pixiv.net") {
		for _, re := range []*regexp.Regexp{pixivPageRE, pixivLegacyRE} {
			if m := re.FindStringSubmatch(p); m != nil {
				return ptr("pixiv:" + m[1])
			}
		}
		id := u.Query().Get("illust_id")
		if strings.HasSuffix(strings.ToLower(p), "/member_illust.php") && digitsRE.MatchString(id) {
			return ptr("pixiv:" + id)
		}
	}
	if host == "pximg.net" || strings.HasSuffix(host, ".pximg.net") || strings.HasSuffix(host, ".pixiv.net") {
		media := false
		for _, segment := range strings.Split(p, "/") {
			switch strings.ToLower(segment) {
			case "img-original", "img-master", "img-zip-ugoira":
				media = true
			}
		}
		if media || oldPixivHostRE.MatchString(host) && strings.Contains(strings.ToLower(p), "/img/") {
			if m := pixivMediaRE.FindStringSubmatch(path.Base(p)); m != nil {
				return ptr("pixiv:" + m[1])
			}
		}
	}
	host = strings.TrimPrefix(strings.TrimPrefix(host, "www."), "mobile.")
	if twitterHosts[host] {
		if m := twitterStatusRE.FindStringSubmatch(p); m != nil {
			return ptr("twitter:" + m[1])
		}
	}
	return nil
}
func CandidateSourceKey(site string, id any, target string) *string {
	site = strings.ToLower(strings.TrimSpace(site))
	if site == "x" {
		site = "twitter"
	}
	v := strings.TrimSpace(str(id))
	if (site == "pixiv" || site == "twitter") && digitsRE.MatchString(v) {
		return ptr(site + ":" + v)
	}
	return SourceKeyFromURL(target)
}

func candidateURL(item map[string]any) string {
	for _, key := range []string{"download_url", "works_url", "url"} {
		if v := str(item[key]); v != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
func mediaCount(v any) (int, error) {
	if v == nil || str(v) == "" || str(v) == "0" {
		return 1, nil
	}
	if _, ok := v.(bool); ok {
		return 1, nil
	}
	const maxCount = int(^uint(0) >> 2)
	fromFloat := func(f float64) int {
		if f > float64(maxCount) {
			return maxCount
		}
		if f < 1 {
			return 1
		}
		return int(f)
	}
	if f, ok := v.(float64); ok {
		return fromFloat(f), nil
	}
	n, err := strconv.ParseInt(str(v), 10, 64)
	if err != nil {
		if num, ok := v.(json.Number); ok {
			if f, e := num.Float64(); e == nil {
				return fromFloat(f), nil
			}
		}
		return 0, fmt.Errorf("invalid media_count: %v", v)
	}
	if n > int64(maxCount) {
		return maxCount, nil
	}
	return max(1, int(n)), nil
}

// PlanMedia expands works into media tasks without downloading media. EH indexes
// are fetched natively; gallery-dl remains exclusively an extraction/download worker.
func (s *Service) PlanMedia(ctx context.Context, items []map[string]any, policy scheduler.Policy, mode, cookies string, maxTasks int) ([]Unit, []map[string]any, error) {
	units := []Unit{}
	proxies := []map[string]any{}
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if downloadable, ok := item["downloadable"].(bool); ok && !downloadable {
			continue
		}
		site := strings.ToLower(str(item["site"]))
		target := candidateURL(item)
		if target == "" {
			return nil, nil, &Error{Code: "invalid_crawl_item", Message: "爬取候选缺少 URL"}
		}
		sourceID := str(item["id"])
		if sourceID == "" {
			sourceID = uuid.NewSHA1(uuid.NameSpaceURL, []byte(target)).String()
		}
		kind := str(item["kind"])
		if kind == "" {
			kind = "candidate"
		}
		args := stringsOf(item["extra_args"])
		sourceURL := strings.TrimSpace(str(item["source_url"]))
		if site == "danbooru" && sourceURL == "" {
			if meta, ok := item["metadata"].(map[string]any); ok {
				sourceURL = str(meta["source_url"])
				if sourceURL == "" {
					sourceURL = str(meta["source"])
				}
			}
		}
		sourceURL = strings.TrimSpace(sourceURL)
		var sourceKey *string
		if site == "danbooru" {
			sourceKey = SourceKeyFromURL(sourceURL)
		} else {
			sourceKey = CandidateSourceKey(site, item["id"], target)
			if sourceURL == "" {
				sourceURL = target
			}
		}
		if site == "exhentai" && ehGalleryRE.MatchString(target) {
			remaining := maxTasks - len(units)
			if remaining <= 0 {
				return nil, nil, tooLarge(len(units)+1, maxTasks)
			}
			gallery, proxy, err := s.planEH(ctx, target, policy, mode, cookies, remaining)
			if err != nil {
				return nil, nil, err
			}
			for i := range gallery {
				gallery[i].ExtraArgs = append(gallery[i].ExtraArgs, args...)
			}
			units = append(units, gallery...)
			proxies = append(proxies, proxy)
			continue
		}
		count, err := mediaCount(item["media_count"])
		if err != nil {
			return nil, nil, err
		}
		if count > maxTasks-len(units) {
			return nil, nil, tooLarge(len(units)+count, maxTasks)
		}
		media := []string{}
		if site == "twitter" {
			seen := map[string]bool{}
			for _, v := range stringsOf(item["media_urls"]) {
				v = strings.TrimSpace(v)
				if v != "" && !seen[v] {
					seen[v] = true
					media = append(media, v)
				}
			}
		}
		for index := 1; index <= count; index++ {
			u := Unit{URL: target, Site: site, Kind: kind, SourceID: sourceID, ExtraArgs: append([]string{}, args...), SourceKey: sourceKey, SourceURL: optional(sourceURL)}
			if len(media) >= count {
				u.URL = media[index-1]
				u.Kind = "media"
				u.SourceID = fmt.Sprintf("%s:%d", sourceID, index)
			} else if count > 1 {
				u.Kind = "media"
				u.SourceID = fmt.Sprintf("%s:%d", sourceID, index)
				u.ExtraArgs = append(u.ExtraArgs, "--range", strconv.Itoa(index))
			}
			units = append(units, u)
		}
	}
	return units, proxies, nil
}
func tooLarge(planned, maximum int) error {
	return &Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("规划任务数超过 max_tasks=%d", maximum), Details: map[string]any{"planned": planned, "max_tasks": maximum}}
}

// CandidateDigest is byte-compatible with Python json.dumps(...,
// ensure_ascii=False,separators=(",",":")) followed by SHA-256.
func CandidateDigest(unit Unit) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	args := unit.ExtraArgs
	if args == nil {
		args = []string{}
	}
	_ = e.Encode([]any{unit.Site, unit.URL, args})
	raw := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	var out bytes.Buffer
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if raw[i+1] == '\\' {
				out.Write(raw[i : i+2])
				i++
				continue
			}
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out.WriteRune('\u2028')
				} else {
					out.WriteRune('\u2029')
				}
				i += 5
				continue
			}
		}
		out.WriteByte(raw[i])
	}
	sum := sha256.Sum256(out.Bytes())
	return hex.EncodeToString(sum[:])
}
func Deduplicate(units []Unit) []HashedUnit {
	seen := map[string]bool{}
	out := []HashedUnit{}
	for _, u := range units {
		digest := CandidateDigest(u)
		if !seen[digest] {
			seen[digest] = true
			out = append(out, HashedUnit{u, digest})
		}
	}
	return out
}
