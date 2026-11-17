package discoverydata

import (
	"sort"
	"strings"
	"unicode/utf8"
)

type namespace struct {
	name, label string
	aliases     []string
}

var namespaces = []namespace{
	{"artist", "艺术家 / 作者", []string{"a"}}, {"character", "角色", []string{"c", "char"}}, {"cosplayer", "角色扮演者", []string{"cos"}},
	{"female", "女性", []string{"f"}}, {"group", "社团 / 团体", []string{"g", "circle"}}, {"language", "语言", []string{"l", "lang"}},
	{"location", "地点", []string{"loc"}}, {"male", "男性", []string{"m"}}, {"mixed", "混合", []string{"x"}},
	{"other", "其他", []string{"o"}}, {"parody", "原作 / 系列", []string{"p", "series"}}, {"reclass", "重分类", []string{"r"}}, {"temp", "临时标签", []string{}},
}

func ExhentaiTagFacets(addresses []map[string]any) []map[string]any {
	counts := map[string]map[string]object{}
	galleries := map[string]map[int]bool{}
	order := []string{}
	labels := map[string]string{}
	index := map[string]string{}
	for _, n := range namespaces {
		order = append(order, n.name)
		labels[n.name] = n.label
		index[n.name] = n.name
		for _, a := range n.aliases {
			index[a] = n.name
		}
	}
	for i, a := range addresses {
		tags := obj(a["metadata"])["tags"]
		values := sequence(tags)
		if s, ok := tags.(string); ok {
			values = []any{s}
		}
		seen := map[string]bool{}
		for _, raw := range values {
			t := text(raw, 300)
			if t == nil {
				continue
			}
			s := str(t)
			ns, value := "temp", s
			if prefix, rest, ok := strings.Cut(s, ":"); ok {
				ns = index[lower(strings.TrimSpace(prefix))]
				if ns == "" {
					ns = "unknown"
				}
				value = strings.TrimSpace(rest)
			}
			if value == "" {
				continue
			}
			key := ns + ":" + lower(value)
			if seen[key] {
				continue
			}
			seen[key] = true
			if counts[ns] == nil {
				counts[ns] = map[string]object{}
				galleries[ns] = map[int]bool{}
				if !contains(order, ns) {
					order = append(order, ns)
				}
			}
			item := counts[ns][key]
			if item == nil {
				item = object{"tag": ns + ":" + value, "value": value, "count": 0}
				counts[ns][key] = item
			}
			item["count"] = intValue(item["count"]) + 1
			galleries[ns][i] = true
		}
	}
	result := []object{}
	for _, ns := range order {
		if len(counts[ns]) == 0 {
			continue
		}
		tags := []object{}
		for _, v := range counts[ns] {
			tags = append(tags, v)
		}
		sort.Slice(tags, func(i, j int) bool {
			ci, cj := intValue(tags[i]["count"]), intValue(tags[j]["count"])
			if ci != cj {
				return ci > cj
			}
			return lower(str(tags[i]["value"])) < lower(str(tags[j]["value"]))
		})
		result = append(result, object{"namespace": ns, "label": first(labels[ns], "未识别命名空间"), "tag_count": len(tags), "gallery_count": len(galleries[ns]), "tags": tags})
	}
	return result
}

// AliasTerms expands exact directory identities only. Non-ASCII aliases get
// priority because gallery and creator titles commonly use those variants.
func AliasTerms(artistResult map[string]any, keyword string, cap int) []string {
	key := identity(keyword)
	terms := []string{}
	if key == "" || artistResult == nil {
		return terms
	}
	seen := map[string]bool{key: true}
	for _, a := range objects(artistResult["authors"]) {
		name := strings.TrimSpace(stringOr(a["name"]))
		others := []string{}
		matches := key == identity(name) || key == identity(a["group_name"])
		for _, v := range stringsOf(a["other_names"]) {
			s := strings.TrimSpace(v)
			if s != "" {
				others = append(others, s)
			}
			if key == identity(s) {
				matches = true
			}
		}
		if !matches {
			continue
		}
		display := strings.TrimSpace(stringOr(a["display_name"]))
		if display == "" {
			display = strings.ReplaceAll(name, "_", " ")
		}
		for _, term := range append([]string{display}, others...) {
			k := identity(term)
			if utf8.RuneCountInString(term) < 2 || k == "" || seen[k] {
				continue
			}
			seen[k] = true
			terms = append(terms, term)
		}
	}
	ascii := func(s string) bool {
		for _, r := range s {
			if r > 127 {
				return false
			}
		}
		return true
	}
	sort.SliceStable(terms, func(i, j int) bool { return !ascii(terms[i]) && ascii(terms[j]) })
	return terms[:min(len(terms), max(0, cap))]
}

type AliasResult struct {
	Term   string
	Result map[string]any
}

func MergeAliasResults(keyword string, primary map[string]any, aliases []AliasResult, limit int) map[string]any {
	merged := clone(primary)
	candidates, authors := []object{}, []object{}
	byKey := map[string]object{}
	authorKeys := map[string]bool{}
	fold := func(term string, result object) {
		for _, item := range objects(result["candidates"]) {
			key := str(first(item["id"], item["download_url"], item["url"], ""))
			if key == "" {
				continue
			}
			existing := byKey[key]
			if existing == nil {
				copy := clone(item)
				copy["matched_keywords"] = []string{term}
				byKey[key] = copy
				candidates = append(candidates, copy)
			} else {
				matched := stringsOf(existing["matched_keywords"])
				if !contains(matched, term) {
					existing["matched_keywords"] = append(matched, term)
				}
			}
		}
		for _, a := range objects(result["authors"]) {
			key := str(first(a["works_url"], a["url"], a["name"], ""))
			if key != "" && !authorKeys[key] {
				authorKeys[key] = true
				authors = append(authors, a)
			}
		}
	}
	fold(keyword, primary)
	attempts := intValue(primary["attempts"])
	terms := []string{}
	for _, a := range aliases {
		fold(a.Term, a.Result)
		attempts += intValue(a.Result["attempts"])
		terms = append(terms, a.Term)
	}
	candidates = candidates[:min(len(candidates), max(0, limit))]
	merged["candidates"] = candidates
	merged["candidate_count"] = len(candidates)
	merged["authors"] = authors
	merged["author_count"] = len(authors)
	merged["attempts"] = attempts
	merged["alias_keywords"] = terms
	return merged
}
