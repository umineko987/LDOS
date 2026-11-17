// Package downloads owns persisted model download settings and per-download resolution.
package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	SettingsFilename = "download-settings.json"
	TokenFilename    = "hf-token"
	MaxHFTokenLength = 8192
)

// Error contains only a fixed, public message; submitted secrets are never included.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

var ErrProxyUnavailable = errors.New("代理池不可用或当前没有可租用的节点")

// OptionalString distinguishes an omitted field from an explicit null.
// Null clears mirror/proxy values, but leaves token and proxy mode unchanged.
type OptionalString struct {
	Set   bool
	Value *string
}

func String(value string) OptionalString { return OptionalString{Set: true, Value: &value} }
func Null() OptionalString               { return OptionalString{Set: true} }

type Update struct {
	HFMirror     OptionalString
	ProxyMode    OptionalString
	CustomProxy  OptionalString
	HFToken      OptionalString
	ClearHFToken bool
}

type View struct {
	HFMirror                  *string `json:"hf_mirror"`
	ProxyMode                 string  `json:"proxy_mode"`
	CustomProxy               *string `json:"custom_proxy"`
	CustomProxyHasCredentials bool    `json:"custom_proxy_has_credentials"`
	TokenSet                  bool    `json:"token_set"`
}

type settings struct {
	HFMirror    *string `json:"hf_mirror"`
	ProxyMode   string  `json:"proxy_mode"`
	CustomProxy *string `json:"custom_proxy"`
}

// Pool leases an endpoint until Release. An empty endpoint means no node is available.
// Implementations must support concurrent callers. Release must also accept an owner
// whose Acquire returned an empty endpoint, to clean up an unusable lease.
type Pool interface {
	Acquire(ctx context.Context, owner string) (endpoint string, err error)
	Release(ctx context.Context, owner string, proxyFault bool, reason string) error
}

type Store struct {
	mu         sync.Mutex
	runtimeDir string
	pool       Pool
}

func New(runtimeDir string) *Store { return NewWithPool(runtimeDir, nil) }
func NewWithPool(runtimeDir string, pool Pool) *Store {
	return &Store{runtimeDir: runtimeDir, pool: pool}
}

func (s *Store) loadLocked() (settings, error) {
	current := settings{ProxyMode: "none"}
	data, err := readPrivate(s.runtimeDir, SettingsFilename)
	if err != nil {
		if errors.Is(err, errUnsafePath) {
			return current, err
		}
		return current, nil // Missing/unreadable/corrupt settings use defaults.
	}
	var raw map[string]json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &raw) != nil {
		return current, nil
	}
	var value string
	if json.Unmarshal(raw["hf_mirror"], &value) == nil {
		current.HFMirror, _ = normalizeMirror(&value)
	}
	value = ""
	if json.Unmarshal(raw["custom_proxy"], &value) == nil {
		current.CustomProxy, _ = normalizeProxy(&value)
	}
	value = ""
	if json.Unmarshal(raw["proxy_mode"], &value) == nil && validMode(value) {
		current.ProxyMode = value
	}
	if current.ProxyMode == "custom" && current.CustomProxy == nil {
		current.ProxyMode = "none"
	}
	return current, nil
}

func (s *Store) tokenLocked() (*string, error) {
	data, err := readPrivate(s.runtimeDir, TokenFilename)
	if err != nil {
		if errors.Is(err, errUnsafePath) {
			return nil, err
		}
		return nil, nil
	}
	if !utf8.Valid(data) {
		return nil, nil
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return nil, nil
	}
	return &value, nil
}

// Token is for executor stdin only. Never include it in logs, HTTP replies or environment variables.
func (s *Store) Token() (*string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokenLocked()
}

func (s *Store) View() (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadLocked()
	if err != nil {
		return View{}, err
	}
	token, err := s.tokenLocked()
	if err != nil {
		return View{}, err
	}
	return makeView(current, token), nil
}

func makeView(current settings, token *string) View {
	view := View{HFMirror: current.HFMirror, ProxyMode: current.ProxyMode, CustomProxy: current.CustomProxy, TokenSet: token != nil}
	if current.CustomProxy != nil {
		parsed, _ := url.Parse(*current.CustomProxy) // Stored settings have already been normalized.
		if parsed.User != nil {
			view.CustomProxyHasCredentials = true
			masked := parsed.Scheme + "://***:***@" + parsed.Host
			view.CustomProxy = &masked
		}
	}
	return view
}

func (s *Store) Update(change Update) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadLocked()
	if err != nil {
		return View{}, err
	}
	if change.HFMirror.Set {
		current.HFMirror, err = normalizeMirror(change.HFMirror.Value)
		if err != nil {
			return View{}, err
		}
	}
	if change.CustomProxy.Set {
		current.CustomProxy, err = normalizeProxy(change.CustomProxy.Value)
		if err != nil {
			return View{}, err
		}
	}
	if change.ProxyMode.Set && change.ProxyMode.Value != nil {
		if !validMode(*change.ProxyMode.Value) {
			return View{}, &Error{"invalid_download_proxy_mode", "下载代理模式无效"}
		}
		current.ProxyMode = *change.ProxyMode.Value
	}
	if current.ProxyMode == "custom" && current.CustomProxy == nil {
		return View{}, &Error{"invalid_download_proxy", "自定义下载代理需要填写带端口的 HTTP(S) 地址"}
	}
	if change.ClearHFToken && change.HFToken.Set && change.HFToken.Value != nil {
		return View{}, &Error{"invalid_hf_token", "不能同时保存和清除 HF token"}
	}
	var newToken *string
	if change.HFToken.Set && change.HFToken.Value != nil {
		value := strings.TrimSpace(*change.HFToken.Value)
		if value == "" {
			return View{}, &Error{"invalid_hf_token", "HF token 不能为空"}
		}
		if utf8.RuneCountInString(value) > MaxHFTokenLength || hasControl(value) {
			return View{}, &Error{"invalid_hf_token", "HF token 格式无效"}
		}
		newToken = &value
	}
	// Validate everything before creating directories or touching either file.
	token, err := s.tokenLocked()
	if err != nil {
		return View{}, err
	}
	dir, err := openPrivateDirectory(s.runtimeDir, true)
	if err != nil {
		return View{}, err
	}
	defer dir.Close()
	for _, name := range []string{SettingsFilename, TokenFilename} {
		if err := checkPrivateFile(dir, name); err != nil {
			return View{}, err
		}
	}
	payload, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return View{}, err
	}
	if err := writePrivate(dir, SettingsFilename, append(payload, '\n')); err != nil {
		return View{}, err
	}
	if change.ClearHFToken {
		if err := removePrivate(dir, TokenFilename); err != nil {
			return View{}, err
		}
		token = nil
	} else if newToken != nil {
		if err := writePrivate(dir, TokenFilename, []byte(*newToken+"\n")); err != nil {
			return View{}, err
		}
		token = newToken
	}
	return makeView(current, token), nil
}

func validMode(mode string) bool { return mode == "none" || mode == "pool" || mode == "custom" }
func hasControl(value string) bool {
	for _, r := range value {
		if r <= 32 || r == 127 {
			return true
		}
	}
	return false
}

func normalizeMirror(value *string) (*string, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	candidate := strings.TrimRight(strings.TrimSpace(*value), "/")
	parsed, err := url.Parse(candidate)
	if err != nil || !validHTTPURL(parsed) || utf8.RuneCountInString(candidate) > 300 || hasControl(candidate) || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, &Error{"invalid_hf_mirror", "镜像地址必须是 HTTP(S) URL，不能包含凭据、查询参数或片段"}
	}
	return &candidate, nil
}

func normalizeProxy(value *string) (*string, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	candidate := strings.TrimSpace(*value)
	parsed, err := url.Parse(candidate)
	if err != nil || !validHTTPURL(parsed) || utf8.RuneCountInString(candidate) > 300 || hasControl(candidate) || parsed.Port() == "" || (parsed.EscapedPath() != "" && parsed.EscapedPath() != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, &Error{"invalid_download_proxy", "代理地址需为带端口的 HTTP 或 HTTPS 地址"}
	}
	// Keep the original authority (including escaped credentials) like urlunsplit.
	authority := strings.SplitN(candidate, "://", 2)[1]
	authority = strings.FieldsFunc(authority, func(r rune) bool { return r == '/' || r == '?' || r == '#' })[0]
	normalized := strings.ToLower(parsed.Scheme) + "://" + authority
	return &normalized, nil
}

func validHTTPURL(parsed *url.URL) bool {
	if parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	if strings.HasPrefix(parsed.Host, "[") {
		address, err := netip.ParseAddr(parsed.Hostname())
		if err != nil || !address.Is6() {
			return false
		}
	} else if strings.Contains(parsed.Hostname(), ":") {
		return false
	}
	if port := parsed.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 0 || value > 65535 {
			return false
		}
	}
	return true
}

// Overrides uses explicit null to disable a stored value for one download.
type Overrides struct {
	Token    OptionalString
	HFMirror OptionalString
	Proxy    OptionalString
}

type Environment struct {
	HFEndpoint  *string `json:"hf_endpoint"`
	Proxy       *string `json:"-"`
	Token       *string `json:"-"`
	ProxySource string  `json:"proxy_source"`
	LeaseOwner  *string `json:"-"`
}

// Formatting an environment must never disclose credentials or the HF token.
func (e Environment) String() string {
	return fmt.Sprintf("DownloadEnvironment{proxy_source:%s}", e.ProxySource)
}
func (e Environment) GoString() string { return e.String() }

// ProxySettings reports the shared proxy selection without reading HF secrets or leasing a node.
func (s *Store) ProxySettings() (Environment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadLocked()
	if err != nil {
		return Environment{}, err
	}
	env := Environment{ProxySource: current.ProxyMode}
	if current.ProxyMode == "custom" {
		env.Proxy = current.CustomProxy
	}
	return env, nil
}
func (s *Store) Resolve(ctx context.Context, owner string, overrides Overrides) (Environment, error) {
	s.mu.Lock()
	current, err := s.loadLocked()
	var token *string
	if err == nil && !overrides.Token.Set {
		token, err = s.tokenLocked()
	}
	s.mu.Unlock()
	if err != nil {
		return Environment{}, err
	}
	env := Environment{HFEndpoint: current.HFMirror, Token: token, ProxySource: "none"}
	if overrides.HFMirror.Set {
		env.HFEndpoint = overrides.HFMirror.Value
	}
	if overrides.Token.Set {
		env.Token = overrides.Token.Value
	}
	if overrides.Proxy.Set {
		env.Proxy = overrides.Proxy.Value
		if env.Proxy != nil && *env.Proxy != "" {
			env.ProxySource = "custom"
		}
	} else if current.ProxyMode == "custom" {
		env.Proxy, env.ProxySource = current.CustomProxy, "custom"
	} else if current.ProxyMode == "pool" {
		if s.pool == nil {
			return Environment{}, ErrProxyUnavailable
		}
		endpoint, err := s.pool.Acquire(ctx, owner)
		if err != nil {
			return Environment{}, ErrProxyUnavailable
		}
		if endpoint == "" {
			_ = s.pool.Release(context.WithoutCancel(ctx), owner, false, "model_download_finished")
			return Environment{}, ErrProxyUnavailable
		}
		env.Proxy, env.ProxySource, env.LeaseOwner = &endpoint, "pool", &owner
	}
	return env, nil
}

func (s *Store) Release(ctx context.Context, environment Environment) error {
	if environment.LeaseOwner == nil {
		return nil
	}
	if s.pool == nil {
		return ErrProxyUnavailable
	}
	if err := s.pool.Release(context.WithoutCancel(ctx), *environment.LeaseOwner, false, "model_download_finished"); err != nil {
		return ErrProxyUnavailable
	}
	return nil
}
