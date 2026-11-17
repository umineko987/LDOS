package search

import (
	"context"
	"fmt"
	"strings"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
)

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
func profileForAddress(profiles []map[string]any, name string) map[string]any {
	for i := len(profiles) - 1; i >= 0; i-- {
		if valueText(profiles[i]["name"]) == name {
			return profiles[i]
		}
	}
	return nil
}
func (s *Service) enrichProfiles(ctx context.Context, body Request, p plan, sources []map[string]any) ([]map[string]any, []map[string]any, error) {
	related := []map[string]any{}
	enrichment := []map[string]any{}
	bySite := map[string]map[string]any{}
	for _, source := range sources {
		bySite[valueText(source["site"])] = source
		for _, detail := range rows(source["enrichment_errors"]) {
			item := clone(detail)
			item["source"] = source["site"]
			enrichment = append(enrichment, item)
		}
	}
	danbooru := bySite["danbooru"]
	if danbooru != nil {
		all := append(append([]map[string]any{}, rows(danbooru["addresses"])...), rows(danbooru["weak_evidence"])...)
		names := []string{}
		for _, address := range all {
			if address["address_type"] == "artist_tag" {
				names = append(names, valueText(address["tag"]))
			}
		}
		if len(names) > 0 {
			policy, err := s.deps.Policy(ctx, "danbooru")
			var profiles []map[string]any
			var profileErrors []map[string]string
			if err == nil {
				profiles, profileErrors, err = s.deps.Discovery.ArtistProfiles(ctx, names, policy, text(p.options["danbooru"].ProxyMode), body.Limit)
			}
			if err != nil {
				if ctx.Err() != nil {
					return nil, nil, ctx.Err()
				}
				enrichment = append(enrichment, map[string]any{"source": "danbooru", "artist": "*", "message": redaction.Text(err.Error(), 1000)})
			} else {
				for _, detail := range profileErrors {
					item := map[string]any{"source": "danbooru"}
					for key, value := range detail {
						item[key] = value
					}
					enrichment = append(enrichment, item)
				}
			}
			danbooruErrors := []map[string]any{}
			for _, detail := range enrichment {
				if detail["source"] == "danbooru" {
					danbooruErrors = append(danbooruErrors, detail)
				}
			}
			if len(danbooruErrors) > 0 {
				danbooru["status"] = "partial"
				danbooru["enrichment_errors"] = danbooruErrors
			}
			for _, address := range all {
				profile := profileForAddress(profiles, valueText(address["tag"]))
				if profile == nil {
					continue
				}
				identity := map[string]any{}
				for _, key := range []string{"id", "name", "other_names", "group_name", "profile_url"} {
					identity[key] = profile[key]
				}
				address["danbooru_artist"] = identity
				address["related_profiles"] = rows(profile["related_profiles"])
				for _, entry := range rows(profile["related_profiles"]) {
					item := clone(entry)
					item["artist_id"] = profile["id"]
					item["artist_name"] = profile["name"]
					item["origin"] = "danbooru_artist_url"
					related = append(related, item)
					targetSite := valueText(entry["crawl_site"])
					target := bySite[targetSite]
					crawlURL := valueText(entry["crawl_url"])
					if entry["active"] == false || target == nil || crawlURL == "" {
						continue
					}
					canonical, err := discoverydata.CanonicalAddress(targetSite, crawlURL)
					if err != nil {
						return nil, nil, err
					}
					find := func(key string) (map[string]any, int, error) {
						for i, candidate := range rows(target[key]) {
							value, err := discoverydata.CanonicalAddress(targetSite, valueText(candidate["url"]))
							if err != nil {
								return nil, -1, err
							}
							if value == canonical {
								return candidate, i, nil
							}
						}
						return nil, -1, nil
					}
					existing, _, err := find("addresses")
					if err != nil {
						return nil, nil, err
					}
					weak, weakIndex, err := find("weak_evidence")
					if err != nil {
						return nil, nil, err
					}
					if existing != nil {
						origins := stringsOf(existing["origins"])
						if len(origins) == 0 {
							origin := valueText(existing["origin"])
							if origin == "" {
								origin = "site_search"
							}
							origins = []string{origin}
						}
						existing["origins"] = appendUnique(origins, "danbooru_artist_url")
						existing["confidence"] = "verified"
						existing["evidence_reasons"] = appendUnique(stringsOf(existing["evidence_reasons"]), "danbooru_artist_url")
						existing["related_artists"] = appendUnique(stringsOf(existing["related_artists"]), valueText(profile["name"]))
						continue
					}
					if weak != nil {
						values := rows(target["weak_evidence"])
						target["weak_evidence"] = append(values[:weakIndex], values[weakIndex+1:]...)
						origin := valueText(weak["origin"])
						if origin == "" {
							origin = "site_search"
						}
						weak["origin"] = "danbooru_artist_url"
						weak["origins"] = appendUnique([]string{origin}, "danbooru_artist_url")
						weak["confidence"] = "verified"
						weak["evidence_reasons"] = appendUnique(stringsOf(weak["evidence_reasons"]), "danbooru_artist_url")
						weak["related_artists"] = appendUnique(stringsOf(weak["related_artists"]), valueText(profile["name"]))
						target["addresses"] = append(rows(target["addresses"]), weak)
						if target["status"] == "failed" {
							target["status"] = "partial"
						}
						continue
					}
					if len(rows(target["addresses"])) >= body.Limit {
						continue
					}
					target["addresses"] = append(rows(target["addresses"]), map[string]any{"id": fmt.Sprintf("%s:danbooru:%s:%d", targetSite, valueText(profile["id"]), len(rows(target["addresses"]))+1), "source": targetSite, "address_type": "account", "label": profile["name"], "url": canonical, "profile_url": entry["url"], "origin": "danbooru_artist_url", "confidence": "verified", "evidence_reasons": []string{"danbooru_artist_url"}, "related_artists": []string{valueText(profile["name"])}})
					if target["status"] == "failed" {
						target["status"] = "partial"
					}
				}
			}
			for _, source := range sources {
				source["address_count"] = len(rows(source["addresses"]))
				source["weak_evidence_count"] = len(rows(source["weak_evidence"]))
			}
		}
	}
	upstream := []map[string]any{}
	for _, detail := range enrichment {
		if detail["source"] == "danbooru" {
			upstream = append(upstream, detail)
		}
	}
	if danbooru != nil && danbooru["status"] == "failed" {
		message := "Danbooru 搜索失败"
		if detail, ok := danbooru["error"].(map[string]any); ok && valueText(detail["message"]) != "" {
			message = valueText(detail["message"])
		}
		upstream = append(upstream, map[string]any{"source": "danbooru", "stage": "danbooru_search", "message": message})
	}
	if len(upstream) > 0 {
		parts := []string{}
		for _, detail := range upstream[:min(3, len(upstream))] {
			value := valueText(detail["message"])
			if value == "" {
				value = valueText(detail["stage"])
			}
			parts = append(parts, truncate(value, 200))
		}
		for _, site := range []string{"twitter", "pixiv"} {
			target := bySite[site]
			if target == nil || len(rows(target["addresses"])) > 0 {
				continue
			}
			if target["status"] == "succeeded" {
				target["status"] = "partial"
			}
			target["enrichment_errors"] = append(rows(target["enrichment_errors"]), map[string]any{"stage": "danbooru_account_discovery", "message": "Danbooru 画师条目查询失败，本次未完成账号发现（通常重试搜索即可恢复）：" + strings.Join(parts, "; ")})
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	return related, enrichment, nil
}
func truncate(value string, n int) string {
	runes := []rune(value)
	if len(runes) > n {
		return string(runes[:n])
	}
	return value
}
