package search

import (
	"context"
	"errors"
	"sync"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

type Engine interface {
	Search(context.Context, discovery.Request) (map[string]any, error)
	SearchArtists(context.Context, discovery.Request) (map[string]any, error)
	Autocomplete(context.Context, string, int, scheduler.Policy, string) (map[string]any, error)
	ArtistProfiles(context.Context, []string, scheduler.Policy, string, int) ([]map[string]any, []map[string]string, error)
	EnrichPreviews(context.Context, map[string]any, scheduler.Policy, string, float64) (map[string]any, error)
}
type Credentials struct{ Reference, CookiesFile, ConfigFile string }
type Dependencies struct {
	Discovery      Engine
	Policy         func(context.Context, string) (scheduler.Policy, error)
	Credentials    func(context.Context, string, SourceOptions) (Credentials, error)
	AuthStatus     func(context.Context, string) (map[string]any, error)
	ValidateStatic func(string) error
	ValidateDirect func(context.Context, string) error
	ValidateArgs   func([]string) ([]string, error)
}
type Service struct {
	deps        Dependencies
	aliasWait   time.Duration
	previewWait time.Duration
}

func New(deps Dependencies) (*Service, error) {
	if deps.Discovery == nil || deps.Policy == nil || deps.Credentials == nil || deps.AuthStatus == nil || deps.ValidateStatic == nil || deps.ValidateDirect == nil || deps.ValidateArgs == nil {
		return nil, errDependencies
	}
	return &Service{deps: deps, aliasWait: 10 * time.Second, previewWait: 5 * time.Second}, nil
}

type plan struct {
	sites             []string
	implicit, artists bool
	options           map[string]SourceOptions
}

func buildPlan(body Request) (plan, error) {
	p := plan{options: map[string]SourceOptions{}}
	seen := map[string]bool{}
	for _, name := range body.Sites {
		spec, err := discoverydata.SearchSite(name)
		if err != nil {
			return p, &Error{Status: 422, Code: "invalid_search", Message: err.Error()}
		}
		if !seen[spec.Site] {
			seen[spec.Site] = true
			p.sites = append(p.sites, spec.Site)
		}
	}
	p.implicit = !seen["danbooru"] && (seen["twitter"] || seen["pixiv"])
	if p.implicit {
		p.sites = append([]string{"danbooru"}, p.sites...)
		seen["danbooru"] = true
	}
	p.artists = seen["danbooru"] || seen["exhentai"] || seen["pawchive"]
	canonical := map[string]SourceOptions{}
	for key, opt := range body.Options {
		spec, err := discoverydata.SearchSite(key)
		if err != nil {
			return p, &Error{Status: 422, Code: "invalid_search", Message: err.Error()}
		}
		if _, ok := canonical[spec.Site]; ok {
			return p, &Error{Status: 422, Code: "invalid_search", Message: "source_options 重复配置来源: " + spec.Site}
		}
		canonical[spec.Site] = opt
	}
	sites := append([]string{}, p.sites...)
	if p.artists && !seen["danbooru"] {
		sites = append(sites, "danbooru")
	}
	for _, site := range sites {
		p.options[site] = canonical[site].override(body.SourceOptions)
	}
	return p, nil
}

type future struct {
	done   chan struct{}
	result map[string]any
	err    error
}

func begin(fn func() (map[string]any, error)) *future {
	f := &future{done: make(chan struct{})}
	go func() { defer close(f.done); f.result, f.err = fn() }()
	return f
}
func (f *future) wait(ctx context.Context, budget time.Duration) (map[string]any, error) {
	// A completed primary result survives an optional lookup using up its budget.
	select {
	case <-f.done:
		return f.result, f.err
	default:
	}
	var timeout <-chan time.Time
	if budget > 0 {
		timer := time.NewTimer(budget)
		defer timer.Stop()
		timeout = timer.C
	}
	select {
	case <-f.done:
		return f.result, f.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timeout:
		return nil, context.DeadlineExceeded
	}
}
func rows(value any) []map[string]any {
	if result, ok := value.([]map[string]any); ok {
		return result
	}
	result := []map[string]any{}
	if list, ok := value.([]any); ok {
		for _, item := range list {
			if row, ok := item.(map[string]any); ok {
				result = append(result, row)
			}
		}
	}
	return result
}
func stringsOf(value any) []string {
	if result, ok := value.([]string); ok {
		return result
	}
	result := []string{}
	if list, ok := value.([]any); ok {
		for _, item := range list {
			result = append(result, valueText(item))
		}
	}
	return result
}
func count(value any) int {
	switch n := value.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}
func clone(row map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range row {
		result[key] = value
	}
	return result
}
func issue(stage string, err error) map[string]any {
	return map[string]any{"stage": stage, "message": redaction.Text(err.Error(), 1000)}
}
func (s *Service) request(ctx context.Context, site, keyword string, limit int, opt SourceOptions) (discovery.Request, error) {
	credentials, err := s.deps.Credentials(ctx, site, opt)
	if err != nil {
		return discovery.Request{}, err
	}
	return discovery.Request{Site: site, Keyword: &keyword, Limit: limit, ProxyMode: text(opt.ProxyMode), CredentialsRef: credentials.Reference, CookiesFile: credentials.CookiesFile, ConfigFile: credentials.ConfigFile, ExtraArgs: append([]string{}, opt.ExtraArgs...), TimeoutSeconds: opt.TimeoutSeconds}, nil
}
func (s *Service) Perform(parent context.Context, body Request) (map[string]any, error) {
	p, err := buildPlan(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var artists *future
	var stopArtists context.CancelFunc
	if p.artists {
		artistCtx, stop := context.WithCancel(ctx)
		stopArtists = stop
		artists = begin(func() (map[string]any, error) {
			req, err := s.request(artistCtx, "danbooru", body.Keyword, body.Limit, p.options["danbooru"])
			if err != nil {
				return nil, err
			}
			req.Policy, err = s.deps.Policy(artistCtx, "danbooru")
			if err != nil {
				return nil, err
			}
			req.ExtraArgs = nil
			return s.deps.Discovery.SearchArtists(artistCtx, req)
		})
		defer func() { stop(); <-artists.done }()
	}
	sources := make([]map[string]any, len(p.sites))
	failures := make([]error, len(p.sites))
	var work sync.WaitGroup
	for order, site := range p.sites {
		work.Add(1)
		go func() {
			defer work.Done()
			source := s.runSource(ctx, order, site, body, p.options[site], artists)
			auth, err := s.deps.AuthStatus(ctx, site)
			if err != nil {
				failures[order] = err
				cancel()
				return
			}
			source["auth"] = auth
			sources[order] = source
		}()
	}
	work.Wait()
	if err := parent.Err(); err != nil {
		return nil, err
	}
	for _, err := range failures {
		if err != nil {
			return nil, err
		}
	}
	if artists != nil {
		stopArtists()
		<-artists.done
	}
	profiles, enrichment, err := s.enrichProfiles(ctx, body, p, sources)
	if err != nil {
		return nil, err
	}
	if p.implicit {
		kept := sources[:0]
		for _, source := range sources {
			if source["site"] != "danbooru" {
				kept = append(kept, source)
			}
		}
		sources = kept
	}
	total, weak := 0, 0
	for i, source := range sources {
		source["order"] = i
		total += count(source["address_count"])
		weak += count(source["weak_evidence_count"])
	}
	return map[string]any{"keyword": body.Keyword, "source_count": len(sources), "address_count": total, "weak_evidence_count": weak, "sources": sources, "related_profiles": profiles, "enrichment_errors": enrichment,
		"selection_contract":  map[string]any{"field": "sources[].addresses[]", "weak_evidence_field": "sources[].weak_evidence[]", "default_visibility": "addresses_only", "execution_order": "source_then_address", "address_execution": "media_parallel"},
		"tag_filter_contract": map[string]any{"source": "exhentai", "facets_field": "sources[].tag_facets[]", "tags_field": "sources[].addresses[].metadata.tags[]", "same_namespace": "or", "across_namespaces": "and", "exclusions": "take_precedence"}}, nil
}
func emptySource(order int, site string) map[string]any {
	return map[string]any{"order": order, "site": site, "status": "succeeded", "search_url": nil, "evidence_count": 0, "preview_count": 0, "preview_missing_count": 0, "address_count": 0, "addresses": []map[string]any{}, "weak_evidence_count": 0, "weak_evidence": []map[string]any{}, "tag_facets": []map[string]any{}, "proxy": nil, "attempts": 0, "error": nil}
}
func (s *Service) runSource(ctx context.Context, order int, site string, body Request, opt SourceOptions, artists *future) map[string]any {
	source := emptySource(order, site)
	if site == "twitter" || site == "pixiv" {
		source["search_strategy"] = "danbooru_artist_urls"
		source["enrichment_errors"] = []map[string]any{}
		return source
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(opt.TimeoutSeconds*float64(time.Second)))
	defer cancel()
	result, enrichment, err := s.executeSource(ctx, site, body, opt, artists)
	if err != nil {
		spec, _ := discoverydata.SearchSite(site)
		source["search_url"], _ = spec.SearchURL(body.Keyword)
		source["status"] = "failed"
		code := "invalid_search_source"
		var d *discovery.Error
		if errors.As(err, &d) {
			code = d.Code
			if details, ok := d.Details.(map[string]any); ok {
				source["proxy"] = details["proxy"]
				source["attempts"] = count(details["attempts"])
			}
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "search_timeout"
			err = errors.New("搜索超时，请检查网络连接或代理设置后重试")
		}
		source["error"] = map[string]any{"code": code, "message": redaction.Text(err.Error(), 1000)}
		return source
	}
	addresses, err := discoverydata.Addresses(site, result, body.Keyword, body.Limit)
	if err != nil {
		source["status"] = "failed"
		source["error"] = map[string]any{"code": "invalid_search_source", "message": redaction.Text(err.Error(), 1000)}
		return source
	}
	strong, weak := []map[string]any{}, []map[string]any{}
	for _, address := range addresses {
		if address["confidence"] == "weak_evidence" {
			weak = append(weak, address)
		} else {
			strong = append(strong, address)
		}
	}
	if len(enrichment) > 0 {
		source["status"] = "partial"
		if len(addresses) == 0 {
			source["error"] = map[string]any{"code": "search_incomplete", "message": "扩展查询未完成，暂未取得候选；请重试或直接使用画师别名搜索"}
		}
	}
	source["enrichment_errors"] = enrichment
	source["addresses"] = strong
	source["weak_evidence"] = weak
	source["address_count"] = len(strong)
	source["weak_evidence_count"] = len(weak)
	source["alias_keywords"] = stringsOf(result["alias_keywords"])
	if site == "exhentai" {
		source["tag_facets"] = discoverydata.ExhentaiTagFacets(addresses)
	}
	for _, key := range []string{"search_url", "proxy"} {
		source[key] = result[key]
	}
	for _, key := range []string{"candidate_count", "preview_count", "preview_missing_count", "attempts"} {
		target := key
		if key == "candidate_count" {
			target = "evidence_count"
		}
		source[target] = count(result[key])
	}
	return source
}
func (s *Service) executeSource(ctx context.Context, site string, body Request, opt SourceOptions, artists *future) (map[string]any, []map[string]any, error) {
	spec, _ := discoverydata.SearchSite(site)
	searchURL, err := spec.SearchURL(body.Keyword)
	if err != nil {
		return nil, nil, err
	}
	policy, err := s.deps.Policy(ctx, site)
	if err != nil {
		return nil, nil, err
	}
	mode := text(opt.ProxyMode)
	if mode == "" {
		mode = policy.ProxyMode
	}
	if err := s.deps.ValidateStatic(searchURL); err != nil {
		return nil, nil, err
	}
	if mode == "direct" {
		if err := s.deps.ValidateDirect(ctx, searchURL); err != nil {
			return nil, nil, err
		}
	}
	req, err := s.request(ctx, site, body.Keyword, body.Limit, opt)
	if err != nil {
		return nil, nil, err
	}
	req.Policy = policy
	if _, err := discoverydata.ValidateArgs(opt.ExtraArgs); err != nil {
		return nil, nil, err
	}
	if _, err := s.deps.ValidateArgs(opt.ExtraArgs); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	primary := begin(func() (map[string]any, error) { return s.deps.Discovery.Search(ctx, req) })
	defer func() { cancel(); <-primary.done }()
	enrichment := []map[string]any{}
	terms := []string{}
	if (site == "exhentai" || site == "pawchive") && artists != nil {
		directory, err := artists.wait(ctx, s.aliasWait)
		if err != nil {
			message := err
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				message = errors.New("画师别名查询超时，已跳过扩展搜索")
			}
			enrichment = append(enrichment, issue("danbooru_alias_lookup", message))
		} else {
			terms = discoverydata.AliasTerms(directory, body.Keyword, 4)
		}
	}
	aliasCtx, stopAliases := context.WithTimeout(ctx, s.aliasWait)
	defer stopAliases()
	aliases := make([]*future, len(terms))
	for i, term := range terms {
		aliasReq := req
		aliasReq.Keyword = &term
		aliases[i] = begin(func() (map[string]any, error) { return s.deps.Discovery.Search(aliasCtx, aliasReq) })
	}
	collected := []discoverydata.AliasResult{}
	for i, alias := range aliases {
		<-alias.done
		if alias.err != nil {
			enrichment = append(enrichment, issue("danbooru_alias_search", errors.New(terms[i]+": "+alias.err.Error())))
		} else {
			collected = append(collected, discoverydata.AliasResult{Term: terms[i], Result: alias.result})
		}
	}
	result, err := primary.wait(ctx, 0)
	if err != nil {
		return nil, nil, err
	}
	if len(terms) > 0 {
		result = discoverydata.MergeAliasResults(body.Keyword, result, collected, body.Limit)
	}
	if site == "exhentai" {
		previewCtx, stopPreview := context.WithTimeout(ctx, s.previewWait)
		enriched, err := s.deps.Discovery.EnrichPreviews(previewCtx, result, policy, text(opt.ProxyMode), opt.TimeoutSeconds)
		stopPreview()
		if err != nil {
			result["preview_count"] = count(result["preview_count"])
			total := count(result["candidate_count"])
			if total == 0 {
				total = len(rows(result["candidates"]))
			}
			result["preview_missing_count"] = max(0, total-count(result["preview_count"]))
			enrichment = append(enrichment, issue("exhentai_gallery_previews", err))
		} else {
			result = enriched
		}
	}
	if site == "danbooru" && artists != nil {
		directory, err := artists.wait(ctx, 0)
		if err != nil {
			enrichment = append(enrichment, issue("danbooru_artist_directory", err))
		} else {
			mergeAuthors(result, directory)
		}
	}
	return result, enrichment, nil
}
func mergeAuthors(result, directory map[string]any) {
	authors := append([]map[string]any{}, rows(result["authors"])...)
	keyOf := func(row map[string]any) string {
		for _, key := range []string{"works_url", "url", "name"} {
			if value := valueText(row[key]); value != "" {
				return value
			}
		}
		return ""
	}
	byKey := map[string]map[string]any{}
	for _, author := range authors {
		byKey[keyOf(author)] = author
	}
	for _, author := range rows(directory["authors"]) {
		key := keyOf(author)
		existing, ok := byKey[key]
		if !ok {
			copy := clone(author)
			authors = append(authors, copy)
			byKey[key] = copy
			continue
		}
		for _, field := range []string{"id", "name", "display_name", "url", "works_url", "other_names", "group_name", "origin"} {
			value := author[field]
			if value != nil && valueText(value) != "" && valueText(value) != "[]" {
				existing[field] = value
			}
		}
	}
	result["authors"] = authors
}
