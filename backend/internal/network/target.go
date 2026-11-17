// Package network implements target admission and proxy-scoped encrypted DNS.
package network

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

type Target struct {
	Scheme, Hostname string
	Port             int
	LiteralIP        netip.Addr
}
type LookupIP func(context.Context, string) ([]string, error)

var hostLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var idnaProfile = idna.New(idna.MapForLookup(), idna.Transitional(true), idna.StrictDomainName(false), idna.VerifyDNSLength(false))

func normalizedHost(value string) (string, error) {
	host := strings.TrimRight(strings.TrimSpace(value), ".")
	if host == "" {
		return "", errors.New("目标 URL 缺少主机名")
	}
	if strings.Contains(host, "%") {
		return "", errors.New("目标 URL 不允许带 IPv6 zone identifier")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return renderIP(ip), nil
	}
	host, err := idnaProfile.ToASCII(host)
	if err != nil {
		return "", errors.New("目标 URL 主机名格式无效")
	}
	host = strings.ToLower(host)
	if len(host) > 253 {
		return "", errors.New("目标 URL 主机名过长")
	}
	for _, label := range strings.Split(host, ".") {
		if !hostLabel.MatchString(label) {
			return "", errors.New("目标 URL 主机名格式无效")
		}
	}
	return host, nil
}
func localHost(host string) bool {
	return host == "localhost" || host == "localhost.localdomain" || strings.HasSuffix(host, ".local")
}
func safeURL(value string, limit int) (*url.URL, error) {
	text := strings.TrimSpace(value)
	if text == "" || utf8.RuneCountInString(text) > limit {
		return nil, errors.New("目标 URL 为空或过长")
	}
	for _, r := range text {
		if r <= 32 || r == 127 {
			return nil, errors.New("目标 URL 包含空白或控制字符")
		}
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return nil, errors.New("目标 URL 无法解析")
	}
	return parsed, nil
}
func ValidateSyntax(value string, allowPrivate bool) (Target, error) {
	var target Target
	parsed, err := safeURL(value, 8192)
	if err != nil {
		return target, err
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return target, errors.New("目标 URL 仅支持 http 或 https")
	}
	if parsed.User != nil {
		return target, errors.New("目标 URL 不允许包含凭据")
	}
	host, err := normalizedHost(parsed.Hostname())
	if err != nil {
		return target, err
	}
	if localHost(host) && !allowPrivate {
		return target, errors.New("目标 URL 指向本机或私有网络")
	}
	port := 80
	if scheme == "https" {
		port = 443
	}
	if parsed.Port() != "" {
		port, err = strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return target, errors.New("目标 URL 端口超出范围")
		}
	}
	ip, _ := netip.ParseAddr(host)
	if ip.IsValid() && !allowPrivate && !IsPublic(ip) {
		return target, errors.New("目标 URL 解析到非公网地址，已拒绝")
	}
	return Target{Scheme: scheme, Hostname: host, Port: port, LiteralIP: ip}, nil
}
func ValidateAddresses(addresses []string, allowPrivate, strict bool) ([]string, error) {
	result := []string{}
	seen := map[string]bool{}
	hasGlobal := false
	for _, raw := range addresses {
		value := strings.TrimSpace(strings.SplitN(raw, "%", 2)[0])
		ip, err := netip.ParseAddr(value)
		if err != nil {
			if strict {
				return nil, errors.New("目标主机解析出无法识别的地址")
			}
			continue
		}
		public := IsPublic(ip)
		if !allowPrivate && strict && !public {
			return nil, errors.New("目标 URL 解析到非公网地址，已拒绝")
		}
		hasGlobal = hasGlobal || public
		rendered := renderIP(ip)
		if !seen[rendered] {
			seen[rendered] = true
			result = append(result, rendered)
		}
	}
	if allowPrivate || strict {
		if len(result) == 0 {
			return nil, errors.New("目标主机 DNS 未返回任何地址")
		}
	} else if !hasGlobal {
		return nil, errors.New("目标 URL 指向本机或私有网络")
	}
	return result, nil
}
func ValidateDirect(ctx context.Context, value string, allowPrivate, strict bool, lookup LookupIP) ([]string, error) {
	target, err := ValidateSyntax(value, allowPrivate)
	if err != nil {
		return nil, err
	}
	if target.LiteralIP.IsValid() {
		return ValidateAddresses([]string{renderIP(target.LiteralIP)}, allowPrivate, strict)
	}
	if lookup == nil {
		lookup = net.DefaultResolver.LookupHost
	}
	addresses, err := lookup(ctx, target.Hostname)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("目标主机 DNS 解析失败")
	}
	return ValidateAddresses(addresses, allowPrivate, strict)
}
func NormalizeDoHEndpoint(value string) (string, error) {
	parsed, err := safeURL(value, 2048)
	if err != nil {
		return "", err
	}
	if strings.ToLower(parsed.Scheme) != "https" {
		return "", errors.New("encrypted_dns.endpoint 必须使用 HTTPS")
	}
	if parsed.User != nil {
		return "", errors.New("encrypted_dns.endpoint 不允许包含凭据")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("encrypted_dns.endpoint 不允许包含 query 或 fragment")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		return "", errors.New("encrypted_dns.endpoint 必须包含 DoH 路径")
	}
	target, err := ValidateSyntax(value, false)
	if err != nil {
		return "", fmt.Errorf("encrypted_dns.endpoint 无效: %w", err)
	}
	host := target.Hostname
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if parsed.Port() != "" {
		host = net.JoinHostPort(target.Hostname, strconv.Itoa(target.Port))
	}
	return "https://" + host + parsed.EscapedPath(), nil
}
func renderIP(ip netip.Addr) string {
	if ip.Is4In6() {
		data := ip.As16()
		return fmt.Sprintf("::ffff:%x:%x", uint16(data[12])<<8|uint16(data[13]), uint16(data[14])<<8|uint16(data[15]))
	}
	return ip.String()
}

// Preserve the Python 3.14 ipaddress classifications, including mapped IPv4
// and global special-use exceptions. Teredo is explicitly excluded.
var nonGlobal = prefixes("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "::1/128", "::/128", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "fc00::/7", "fe80::/10")
var globalExceptions = prefixes("192.0.0.9/32", "192.0.0.10/32", "2001:1::1/128", "2001:1::2/128", "2001:3::/32", "2001:4:112::/48", "2001:20::/28", "2001:30::/28")

func prefixes(values ...string) []netip.Prefix {
	result := make([]netip.Prefix, len(values))
	for i, value := range values {
		result[i] = netip.MustParsePrefix(value)
	}
	return result
}
func IsPublic(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, prefix := range globalExceptions {
		if prefix.Contains(ip) {
			return true
		}
	}
	for _, prefix := range nonGlobal {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}
