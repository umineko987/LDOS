package danboorucollect

import (
	"context"
	"strings"

	"ldos/backend/internal/discovery"
)

// Revalidate remote selections before any dataset membership or crawl is written.
// Local assets remain reusable even when their remote post is no longer visible.
func (s *Service) recheckPosts(ctx context.Context, posts []discovery.DanbooruPost) error {
	request, err := s.deps.Request(ctx)
	if err != nil {
		return err
	}
	for start := 0; start < len(posts); start += 100 {
		chunk := posts[start:min(start+100, len(posts))]
		ids := make([]string, len(chunk))
		for i, post := range chunk {
			ids[i] = post.ID
		}
		page, err := s.deps.Browse(ctx, request, discovery.DanbooruBrowseOptions{Kind: "search", Query: "id:" + strings.Join(ids, ","), Limit: 100})
		if err != nil {
			return err
		}
		available := make(map[string]discovery.DanbooruPost, len(page.Items))
		for _, post := range page.Items {
			available[post.ID] = post
		}
		for i, post := range chunk {
			fresh, ok := available[post.ID]
			if !ok || !fresh.Downloadable || !safeFileExt(fresh.FileExt) {
				return problem(422, "danbooru_post_unavailable", "选中图片已不可访问或下载，请重新加载候选")
			}
			chunk[i] = fresh
		}
	}
	return nil
}
