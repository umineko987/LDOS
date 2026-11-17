package discovery

import (
	"context"
	"net/url"
	"strings"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/scheduler"
)

type Service struct {
	Transport *Transport
	Gallery   *GalleryAdapter
	Danbooru  *DanbooruAdapter
	Exhentai  *ExhentaiAdapter
}

func New(transport *Transport) *Service {
	gallery := &GalleryAdapter{Transport: transport}
	return &Service{Transport: transport, Gallery: gallery, Danbooru: &DanbooruAdapter{Transport: transport, GalleryDiscover: gallery.Discover}, Exhentai: &ExhentaiAdapter{Transport: transport, GalleryDiscover: gallery.Discover}}
}
func (s *Service) Search(ctx context.Context, request Request) (map[string]any, error) {
	spec, err := discoverydata.SearchSite(request.Site)
	if err != nil {
		return nil, err
	}
	request.Site = spec.Site
	switch spec.Site {
	case "danbooru":
		return s.Danbooru.Search(ctx, request)
	case "exhentai":
		return s.Exhentai.Search(ctx, request)
	default:
		request.URL, err = spec.SearchURL(*request.Keyword)
		if err != nil {
			return nil, err
		}
		request.RangeKind = spec.SearchRange
		if spec.Site == "pawchive" {
			limit := request.Limit * 10
			request.RangeLimit = &limit
		}
		return s.Gallery.Discover(ctx, request)
	}
}
func (s *Service) Discover(ctx context.Context, request Request) (map[string]any, error) {
	spec, err := discoverydata.SearchSite(request.Site)
	if err != nil {
		return nil, err
	}
	request.Site = spec.Site
	switch spec.Site {
	case "danbooru":
		return s.Danbooru.Discover(ctx, request)
	case "exhentai":
		return s.Exhentai.Discover(ctx, request)
	case "pawchive":
		if request.RangeKind == "" {
			request.RangeKind = "post"
			parsed, err := url.Parse(request.URL)
			if err != nil {
				return nil, err
			}
			if strings.HasPrefix(parsed.Path, "/artists") {
				request.RangeKind = "child"
			}
		}
		limit := request.Limit
		if request.RangeKind == "child" {
			limit *= 10
		}
		request.RangeLimit = &limit
	}
	return s.Gallery.Discover(ctx, request)
}
func (s *Service) SearchArtists(ctx context.Context, request Request) (map[string]any, error) {
	return s.Danbooru.SearchArtists(ctx, request)
}
func (s *Service) Autocomplete(ctx context.Context, query string, limit int, policy scheduler.Policy, mode string) (map[string]any, error) {
	return s.Danbooru.Autocomplete(ctx, query, limit, policy, mode)
}
func (s *Service) ArtistProfiles(ctx context.Context, names []string, policy scheduler.Policy, mode string, limit int) ([]map[string]any, []map[string]string, error) {
	return s.Danbooru.ArtistProfiles(ctx, names, policy, mode, limit)
}
func (s *Service) EnrichPreviews(ctx context.Context, result map[string]any, policy scheduler.Policy, mode string, timeoutSeconds float64) (map[string]any, error) {
	return s.Exhentai.EnrichPreviews(ctx, result, policy, mode, timeoutSeconds)
}
