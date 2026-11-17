package discoverydata

import (
	"github.com/google/uuid"
	"net/url"
	"strings"
)

// Addresses projects extraction evidence into selectable accounts, tags and
// galleries. A work hit alone never verifies an account's identity.
func Addresses(site string, result map[string]any, keyword string, limit int) ([]map[string]any, error) {
	spec, err := SearchSite(site)
	if err != nil {
		return nil, err
	}
	site = spec.Site
	addresses := []object{}
	seen := map[string]bool{}
	add := func(item object) error {
		raw := strings.TrimSpace(stringOr(item["url"]))
		if raw == "" {
			return nil
		}
		u, e := CanonicalAddress(site, raw)
		if e != nil {
			return e
		}
		if u != "" && !seen[u] && len(addresses) < limit {
			item["url"] = u
			item["source"] = site
			if _, ok := item["origin"]; !ok {
				item["origin"] = "site_search"
			}
			addresses = append(addresses, item)
			seen[u] = true
		}
		return nil
	}
	candidates, authors := objects(result["candidates"]), objects(result["authors"])
	key := identity(keyword)
	if site == "twitter" || site == "pixiv" {
		for _, a := range authors {
			u := strings.TrimSpace(str(first(a["works_url"], a["url"], "")))
			if u == "" {
				continue
			}
			aid := strings.TrimSpace(stringOr(a["id"]))
			name := tagKey(first(a["name"], ""))
			addressID := aid
			if addressID == "" {
				canonical, e := CanonicalAddress(site, u)
				if e != nil {
					return nil, e
				}
				addressID = strings.ReplaceAll(uuid.NewSHA1(uuid.NameSpaceURL, []byte(canonical)).String(), "-", "")
			}
			samples := []object{}
			for _, c := range candidates {
				ca := obj(c["author"])
				cid := strings.TrimSpace(stringOr(ca["id"]))
				cn := tagKey(first(ca["name"], ""))
				if aid != "" && cid != "" && aid == cid || name != "" && cn != "" && name == cn {
					samples = append(samples, c)
				}
			}
			exact := key != "" && (key == identity(a["name"]) || key == identity(a["display_name"]))
			verified := exact && len(samples) > 0
			reasons := []string{}
			if len(samples) > 0 {
				reasons = append(reasons, "site_search_work_evidence")
			}
			if exact {
				reasons = append(reasons, "account_name_exact_match")
			}
			confidence := "verified"
			if !verified {
				confidence = "weak_evidence"
				reasons = append(reasons, "account_identity_unverified")
			}
			thumbs := []any{}
			for _, c := range samples {
				if truth(c["thumbnail_url"]) {
					thumbs = append(thumbs, c["thumbnail_url"])
					if len(thumbs) == 5 {
						break
					}
				}
			}
			if e := add(object{"id": site + ":account:" + addressID, "address_type": "account", "label": first(a["display_name"], a["name"], addressID), "url": u, "profile_url": a["url"], "matched_items": len(samples), "confidence": confidence, "evidence_reasons": reasons, "sample_thumbnails": thumbs}); e != nil {
				return nil, e
			}
		}
		return addresses, nil
	}
	aliases := map[string]bool{}
	for _, a := range stringsOf(result["alias_keywords"]) {
		if k := identity(a); k != "" {
			aliases[k] = true
		}
	}
	if site == "pawchive" {
		for _, c := range candidates {
			if c["kind"] != "account" {
				continue
			}
			metadata := obj(c["metadata"])
			if metadata == nil {
				metadata = object{}
			}
			name := strings.TrimSpace(stringOr(c["title"]))
			nk := identity(name)
			exact := key != "" && nk == key
			aliasExact := !exact && nk != "" && aliases[nk]
			confidence, reason := "site_search", "keyword_creator_search"
			if exact {
				confidence, reason = "verified", "account_name_exact_match"
			} else if aliasExact {
				confidence, reason = "verified", "danbooru_alias_name_match"
			}
			entry := object{"id": "pawchive:account:" + str(c["id"]), "address_type": "account", "label": first(name, str(c["id"])), "url": str(first(c["download_url"], c["url"])), "profile_url": c["url"], "thumbnail_url": c["thumbnail_url"], "media_count": c["media_count"], "metadata": metadata, "confidence": confidence, "evidence_reasons": []string{reason}}
			if terms := stringsOf(c["matched_keywords"]); len(terms) > 0 {
				entry["matched_keywords"] = terms
			}
			if e := add(entry); e != nil {
				return nil, e
			}
		}
		return addresses, nil
	}
	if site == "danbooru" {
		return danbooruAddresses(candidates, authors, key, limit), nil
	}
	for _, c := range candidates {
		u := strings.TrimSpace(str(first(c["download_url"], c["url"], "")))
		if u == "" {
			continue
		}
		terms := stringsOf(c["matched_keywords"])
		matched := map[string]bool{}
		for _, term := range terms {
			matched[identity(term)] = true
		}
		reasons := []string{}
		if len(terms) == 0 || key != "" && matched[key] {
			reasons = append(reasons, "keyword_gallery_search")
		}
		for k := range aliases {
			if matched[k] {
				reasons = append(reasons, "danbooru_alias_search")
				break
			}
		}
		if len(reasons) == 0 {
			reasons = append(reasons, "keyword_gallery_search")
		}
		entry := object{"id": "exhentai:gallery:" + str(first(c["id"], u)), "address_type": "gallery", "label": first(c["title"], "Gallery "+str(c["id"])), "url": u, "thumbnail_url": c["thumbnail_url"], "media_count": c["media_count"], "metadata": first(c["metadata"], object{}), "confidence": "site_search", "evidence_reasons": reasons}
		if len(terms) > 0 {
			entry["matched_keywords"] = terms
		}
		if e := add(entry); e != nil {
			return nil, e
		}
	}
	return addresses, nil
}

func danbooruAddresses(candidates, authors []object, key string, limit int) []object {
	artistCounts, characterCounts := map[string]int{}, map[string]int{}
	artistNames, characterNames := map[string]string{}, map[string]string{}
	authorByKey := map[string]object{}
	directory := []object{}
	for _, c := range candidates {
		m := obj(c["metadata"])
		for _, artist := range stringsOf(m["artists"]) {
			name := strings.TrimSpace(artist)
			k := identity(name)
			if k != "" {
				if _, ok := artistNames[k]; !ok {
					artistNames[k] = name
				}
				artistCounts[k]++
			}
		}
		for _, character := range stringsOf(m["characters"]) {
			name := strings.TrimSpace(character)
			k := identity(name)
			if k != "" && k == key {
				if _, ok := characterNames[k]; !ok {
					characterNames[k] = name
				}
				characterCounts[k]++
			}
		}
	}
	for _, a := range authors {
		k := identity(strings.TrimSpace(stringOr(a["name"])))
		if k == "" {
			continue
		}
		if authorByKey[k] == nil {
			authorByKey[k] = a
		}
		if a["origin"] == "danbooru_artist_directory" {
			directory = append(directory, a)
		}
	}
	primary, alias := []object{}, []object{}
	for _, a := range directory {
		if key != "" && identity(a["name"]) == key {
			primary = append(primary, a)
		}
		if key != "" {
			for _, v := range stringsOf(a["other_names"]) {
				if identity(v) == key {
					alias = append(alias, a)
					break
				}
			}
		}
	}
	selected := primary
	reason, confidence := "danbooru_artist_directory_match", "verified"
	if len(primary) == 0 {
		selected = alias
		reason, confidence = "danbooru_artist_directory_alias_match", "weak_evidence"
	}
	type entry struct {
		name               string
		author             object
		reason, confidence string
	}
	ordered := []entry{}
	emitted := map[string]bool{}
	for _, a := range selected {
		name := strings.TrimSpace(stringOr(a["name"]))
		k := identity(name)
		if k == "" || emitted[k] {
			continue
		}
		emitted[k] = true
		ordered = append(ordered, entry{name, a, reason, confidence})
	}
	if name, ok := artistNames[key]; ok && !emitted[key] {
		a := authorByKey[key]
		if a == nil {
			a = object{"name": name}
		}
		ordered = append(ordered, entry{name, a, "artist_tag_exact_match", "verified"})
	}
	// The legacy contract limits artist rows before appending an exact character
	// row, so a character may occupy one extra slot beyond the artist limit.
	n := limit
	if n < 0 {
		n = max(0, len(ordered)+n)
	}
	n = min(n, len(ordered))
	addresses := []object{}
	seen := map[string]bool{}
	for _, e := range ordered[:n] {
		u := "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(e.name)
		if seen[u] {
			continue
		}
		addresses = append(addresses, object{"id": "danbooru:artist_tag:" + e.name, "source": "danbooru", "origin": first(e.author["origin"], "site_search"), "address_type": "artist_tag", "label": strings.ReplaceAll(e.name, "_", " "), "url": u, "profile_url": e.author["url"], "matched_items": max(1, artistCounts[identity(e.name)]), "tag": e.name, "confidence": e.confidence, "evidence_reasons": []string{e.reason}, "related_profiles": []any{}})
		seen[u] = true
	}
	if name, ok := characterNames[key]; ok {
		u := "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(name)
		if !seen[u] {
			addresses = append(addresses, object{"id": "danbooru:character_tag:" + name, "source": "danbooru", "origin": "site_search", "address_type": "character_tag", "label": strings.ReplaceAll(name, "_", " "), "url": u, "profile_url": nil, "matched_items": characterCounts[key], "tag": name, "confidence": "verified", "evidence_reasons": []string{"character_tag_exact_match"}, "related_profiles": []any{}})
		}
	}
	return addresses
}
