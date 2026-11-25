package discovery

import (
	"context"
	"errors"

	"ldos/backend/internal/discoverydata"
)

const MaxTimelineLimit = 1000

// BrowseTimeline returns a prefix of a Pixiv or X creator feed or keyword search.
func (s *Service) BrowseTimeline(ctx context.Context, request Request) (items []map[string]any, hasMore bool, err error) {
	if request.Limit < 1 || request.Limit > MaxTimelineLimit {
		return nil, false, &Error{Code: "invalid_timeline_limit", Message: "时间线作品数必须在 1 到 1000 之间"}
	}
	if len(request.ExtraArgs) != 0 {
		return nil, false, &Error{Code: "invalid_timeline_args", Message: "时间线浏览不接受自定义 gallery-dl 参数"}
	}
	request.URL, err = discoverydata.CanonicalTimelineAddress(request.Site, request.URL)
	if err != nil {
		return nil, false, err
	}
	limit := request.Limit
	request.timeline = true
	request.Keyword = nil
	request.RangeKind = "post"
	request.RangeLimit = nil
	request.Limit++
	if request.TimeoutSeconds <= 0 {
		request.TimeoutSeconds = 60
	}
	result, err := s.Gallery.Discover(ctx, request)
	if err != nil {
		return nil, false, timelineError(err)
	}
	items = result["candidates"].([]map[string]any)
	if len(items) > limit {
		return items[:limit:limit], true, nil
	}
	return items, false, nil
}

// Report stable diagnostics rather than upstream stderr, which can contain tokens.
func timelineError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var public *Error
	if errors.As(err, &public) {
		switch public.Code {
		case "authentication":
			return &Error{Code: public.Code, Message: "无法访问该站点的时间线，请检查登录凭据或账户权限"}
		case "invalid_gallery_output":
			return &Error{Code: public.Code, Message: "gallery-dl 返回了不完整或无效的时间线数据"}
		case "discovery_configuration":
			return &Error{Code: public.Code, Message: "无法启动 gallery-dl，请检查运行环境和凭据文件"}
		case "task_timeout", "network_timeout":
			return &Error{Code: "discovery_failed", Message: "读取时间线超时，请检查网络或缩小作品数"}
		case "not_found":
			return &Error{Code: "discovery_failed", Message: "找不到该站点的作品来源"}
		}
	}
	return &Error{Code: "discovery_failed", Message: "无法读取完整的时间线，请检查网络、代理和账户权限后重试"}
}
