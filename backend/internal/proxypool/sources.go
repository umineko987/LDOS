package proxypool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/encoding/htmlindex"
	"ldos/backend/internal/proxyparse"
	"ldos/backend/internal/proxysources"
)

const maxSubscriptionBytes = 8 * 1024 * 1024

func fetchOne(ctx context.Context, raw string, timeout time.Duration) ([]proxyparse.Node, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
			return errors.New("invalid redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, errors.New("invalid subscription URL")
	}
	req.Header.Set("User-Agent", "gallery-dl-backend/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxSubscriptionBytes {
		return nil, errors.New("response exceeds 8 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBytes+1))
	if err != nil {
		return nil, errors.New("response read failed")
	}
	if len(data) > maxSubscriptionBytes {
		return nil, errors.New("response exceeds 8 MiB")
	}
	_, params, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if charset := params["charset"]; charset != "" {
		encoding, err := htmlindex.Get(charset)
		if err != nil {
			return nil, errors.New("unsupported charset")
		}
		data, err = encoding.NewDecoder().Bytes(data)
		if err != nil {
			return nil, errors.New("response decode failed")
		}
	}
	text := strings.TrimPrefix(strings.ToValidUTF8(string(data), "\uFFFD"), "\uFEFF")
	return proxyparse.ParseSubscription(text), nil
}
func loadSources(ctx context.Context, snapshot proxysources.Snapshot, timeout time.Duration) ([]proxyparse.Node, []string, error) {
	type fetched struct {
		nodes   []proxyparse.Node
		warning string
	}
	urls := []string{}
	seen := map[string]bool{}
	for _, raw := range snapshot.SubscriptionURLs {
		raw = strings.TrimSpace(raw)
		if raw != "" && !seen[raw] {
			urls = append(urls, raw)
			seen[raw] = true
		}
	}
	for _, raw := range urls {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, nil, errors.New("订阅地址必须使用 http:// 或 https://")
		}
	}
	results := make([]fetched, len(urls))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range min(8, len(urls)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				nodes, err := fetchOne(ctx, urls[i], timeout)
				if err != nil {
					u, _ := url.Parse(urls[i])
					results[i].warning = "订阅拉取失败: " + u.Scheme + "://" + u.Hostname() + " -> " + err.Error()
				} else {
					results[i].nodes = nodes
				}
			}
		}()
	}
	for i := range urls {
		select {
		case jobs <- i:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return nil, nil, ctx.Err()
		}
	}
	close(jobs)
	workers.Wait()
	nodes := []proxyparse.Node{}
	warnings := []string{}
	for _, result := range results {
		nodes = append(nodes, result.nodes...)
		if result.warning != "" {
			warnings = append(warnings, result.warning)
		}
	}
	if len(urls) > 0 && len(warnings) == len(urls) {
		if snapshot.NodeFile == "" && len(snapshot.InlineNodes) == 0 {
			return nil, nil, errors.New("全部订阅地址拉取失败")
		}
		warnings = []string{"全部订阅地址拉取失败"}
	}
	if snapshot.NodeFile != "" {
		text, err := proxysources.ReadNodeFile(snapshot.NodeFile, nil)
		if err != nil {
			return nil, nil, errors.New("节点文件不可用或未通过安全校验")
		}
		nodes = append(nodes, proxyparse.ParseSubscription(text)...)
	}
	nodes = append(nodes, proxyparse.ParseSubscription(strings.Join(snapshot.InlineNodes, "\n"))...)
	return nodes, warnings, ctx.Err()
}
