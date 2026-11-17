package network

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"ldos/backend/internal/proxytransport"
)

const DefaultDoHEndpoint = "https://cloudflare-dns.com/dns-query"

type Error struct {
	Code, Message         string
	Retryable, ProxyFault bool
}

func (e *Error) Error() string { return e.Message }
func protocolError(message string) *Error {
	return &Error{"encrypted_dns_protocol", message, true, true}
}

type DNSSettings struct {
	Enabled          bool
	Endpoint         string
	Timeout          time.Duration
	MaxResponseBytes int64
}

func DefaultDNSSettings() DNSSettings {
	return DNSSettings{Enabled: true, Endpoint: DefaultDoHEndpoint, Timeout: 8 * time.Second, MaxResponseBytes: 64 * 1024}
}

type Resolver struct {
	settings  DNSSettings
	newClient func(context.Context, string, time.Duration) (*http.Client, func(), error)
}

func NewResolver(settings DNSSettings) (*Resolver, error) {
	endpoint, err := NormalizeDoHEndpoint(settings.Endpoint)
	if err != nil {
		return nil, err
	}
	settings.Endpoint = endpoint
	if settings.Timeout <= 0 || settings.MaxResponseBytes < 1 {
		return nil, errors.New("加密 DNS 超时和响应上限必须大于零")
	}
	return &Resolver{settings: settings, newClient: proxytransport.NewHTTPClient}, nil
}
func (r *Resolver) Resolve(ctx context.Context, hostname, proxyURL string) ([]string, error) {
	if !r.settings.Enabled {
		return nil, &Error{"encrypted_dns_unavailable", "代理模式需要启用加密 DNS，已拒绝回退本机明文 DNS", false, false}
	}
	host, err := normalizedHost(hostname)
	if err != nil {
		return nil, &Error{"invalid_network_target", "加密 DNS 目标主机名无效", false, false}
	}
	if strings.TrimSpace(proxyURL) == "" {
		return nil, missingProxy()
	}
	client, closeClient, err := r.newClient(ctx, proxyURL, r.settings.Timeout)
	if err != nil {
		return nil, requestError(ctx, err)
	}
	defer closeClient()
	result := []string{}
	for _, query := range []struct {
		name string
		kind int
	}{{"A", 1}, {"AAAA", 28}} {
		target := r.settings.Endpoint + "?" + url.Values{"name": []string{host}, "type": []string{query.name}}.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, requestError(ctx, err)
		}
		request.Header.Set("Accept", "application/dns-json")
		response, err := client.Do(request)
		if err != nil {
			return nil, requestError(ctx, err)
		}
		body, readErr := readDNSBody(response, r.settings.MaxResponseBytes)
		response.Body.Close()
		if readErr != nil {
			var controlled *Error
			if errors.As(readErr, &controlled) {
				return nil, readErr
			}
			return nil, requestError(ctx, readErr)
		}
		addresses, err := parsePayload(body, query.kind, host)
		if err != nil {
			return nil, err
		}
		result = append(result, addresses...)
	}
	if len(result) == 0 {
		return nil, &Error{"encrypted_dns_no_answer", "加密 DNS 的 A/AAAA 查询均未返回地址", false, false}
	}
	return result, nil
}
func missingProxy() *Error {
	return &Error{"proxy_dns_failed", "代理模式缺少可用租约，已拒绝回退本机明文 DNS", false, false}
}
func requestError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	message := "代理节点的加密 DNS 连接失败"
	var timeout net.Error
	var tlsError *tls.CertificateVerificationError
	if errors.As(err, &tlsError) {
		message = "代理节点的加密 DNS TLS 连接失败"
	} else if errors.As(err, &timeout) && timeout.Timeout() {
		message = "代理节点的加密 DNS 请求超时"
	}
	return &Error{"encrypted_dns_unavailable", message, true, true}
}
func readDNSBody(response *http.Response, limit int64) ([]byte, error) {
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, &Error{"encrypted_dns_redirect", "加密 DNS 返回了未接受的重定向", true, true}
	}
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return nil, &Error{"encrypted_dns_http_error", "加密 DNS 服务返回了 HTTP 错误", true, true}
	}
	tooLarge := func() error {
		return &Error{"encrypted_dns_response_too_large", "加密 DNS 响应超过安全上限", true, true}
	}
	if value := response.Header.Get("Content-Length"); value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return nil, protocolError("加密 DNS 返回了无效 Content-Length")
		}
		if n < 0 || n > limit {
			return nil, tooLarge()
		}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, tooLarge()
	}
	return body, nil
}
func parsePayload(body []byte, queryType int, hostname string) ([]string, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if !utf8.Valid(body) || decoder.Decode(&payload) != nil {
		return nil, protocolError("加密 DNS 返回了无效 JSON")
	}
	if payload == nil {
		return nil, protocolError("加密 DNS 返回结构无效")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, protocolError("加密 DNS 返回了无效 JSON")
	}
	status, ok := payload["Status"].(json.Number)
	if !ok || strings.ContainsAny(string(status), ".eE") {
		return nil, protocolError("加密 DNS 缺少有效状态码")
	}
	if status == "3" {
		return nil, &Error{"encrypted_dns_nxdomain", "加密 DNS 明确返回目标域名不存在", false, false}
	}
	if status != "0" && status != "-0" {
		return nil, &Error{"encrypted_dns_status_error", "加密 DNS 返回了域名状态错误", true, true}
	}
	if payload["TC"] == true {
		return nil, protocolError("加密 DNS 返回了截断响应")
	}
	matches := false
	if questions, ok := payload["Question"].([]any); ok {
		for _, raw := range questions {
			question, ok := raw.(map[string]any)
			if !ok || !recordType(question["type"], queryType) {
				continue
			}
			name, _ := question["name"].(string)
			normalized, err := normalizedHost(name)
			if err == nil && normalized == hostname {
				matches = true
				break
			}
		}
	}
	if !matches {
		return nil, protocolError("加密 DNS 问题结构无效")
	}
	answers := []any{}
	if raw := payload["Answer"]; raw != nil {
		var ok bool
		answers, ok = raw.([]any)
		if !ok {
			return nil, protocolError("加密 DNS 应答结构无效")
		}
	}
	cnames := map[string]string{}
	addresses := []struct {
		owner string
		data  any
	}{}
	for _, raw := range answers {
		answer, ok := raw.(map[string]any)
		if !ok {
			return nil, protocolError("加密 DNS 应答记录无效")
		}
		cname := recordType(answer["type"], 5)
		if !cname && !recordType(answer["type"], queryType) {
			continue
		}
		owner, err := recordName(answer["name"])
		if err != nil {
			return nil, protocolError("加密 DNS 记录名称无效")
		}
		if cname {
			target, err := recordName(answer["data"])
			if err != nil {
				return nil, protocolError("加密 DNS CNAME 记录无效")
			}
			if previous, exists := cnames[owner]; exists && previous != target {
				return nil, protocolError("加密 DNS CNAME 链存在冲突")
			}
			cnames[owner] = target
		} else {
			addresses = append(addresses, struct {
				owner string
				data  any
			}{owner, answer["data"]})
		}
	}
	final := hostname
	seen := map[string]bool{hostname: true}
	for hop := 0; hop < 16; hop++ {
		next, exists := cnames[final]
		if !exists {
			break
		}
		if seen[next] {
			return nil, protocolError("加密 DNS CNAME 链存在环")
		}
		seen[next] = true
		final = next
		if hop == 15 {
			if _, exists := cnames[final]; exists {
				return nil, protocolError("加密 DNS CNAME 链超过安全跳数")
			}
		}
	}
	result := []string{}
	for _, record := range addresses {
		if record.owner != final {
			continue
		}
		text, ok := record.data.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, protocolError("加密 DNS 地址记录无效")
		}
		address, err := netip.ParseAddr(strings.TrimSpace(text))
		if err != nil {
			return nil, protocolError("加密 DNS 地址记录无效")
		}
		if (queryType == 1 && !address.Is4()) || (queryType == 28 && !address.Is6()) {
			return nil, protocolError("加密 DNS 地址记录类型不匹配")
		}
		result = append(result, renderIP(address))
	}
	return result, nil
}
func recordType(value any, want int) bool {
	if n, ok := value.(json.Number); ok {
		number, err := n.Float64()
		return err == nil && number == float64(want)
	}
	return value == true && want == 1
}
func recordName(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", errors.New("invalid DNS name")
	}
	host, err := normalizedHost(text)
	if err != nil {
		return "", err
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return "", errors.New("literal DNS name")
	}
	return host, nil
}
