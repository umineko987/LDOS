// Package tasks implements native task creation and mutation contracts.
package tasks

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/scheduler"
)

type Repository interface {
	GetTaskByIdempotency(context.Context, string) (map[string]any, error)
	CreateTask(context.Context, map[string]any, string) (map[string]any, bool, error)
	GetSitePolicy(context.Context, string) (map[string]any, error)
}
type Control interface {
	Notify()
	Cancel(context.Context, string) (map[string]any, error)
	Retry(context.Context, string, int) (map[string]any, error)
	Summary() map[string]any
}

type SiteInfo struct {
	Site        string `json:"site"`
	Subcategory string `json:"subcategory"`
	Extractor   string `json:"extractor"`
	Supported   bool   `json:"supported"`
	Host        string `json:"host"`
}
type Credentials struct{ Reference, CookiesFile, ConfigFile string }
type Dependencies struct {
	Resolve      func(context.Context, string) (SiteInfo, error)
	Credentials  func(context.Context, string) (Credentials, error)
	ValidateArgs func([]string) ([]string, error)
	LookupIP     LookupIP
	// ValidateTarget replaces local DNS validation for callers that already own
	// the execution network policy, such as ordered crawl preparation.
	ValidateTarget func(context.Context, string) error
	Control        Control
}
type Config struct {
	RuntimeDir, ProjectDir, OutputRoot                         string
	AllowedOutputRoots, AllowedCookieRoots, AllowedConfigRoots []string
	AllowPrivateTargets, StrictTargetDNS                       bool
	DefaultPolicy                                              map[string]any
}

type Create struct {
	URL            string               `json:"url"`
	Site           *string              `json:"site"`
	OutputDir      *string              `json:"output_dir"`
	ProxyMode      *string              `json:"proxy_mode"`
	MaxAttempts    *int                 `json:"max_attempts"`
	Priority       int                  `json:"priority"`
	CredentialsRef *string              `json:"credentials_ref"`
	CookiesFile    *string              `json:"cookies_file"`
	ConfigFile     *string              `json:"config_file"`
	EHDownload     *scheduler.EHOptions `json:"eh_download"`
	ExtraArgs      []string             `json:"extra_args"`
}

type Error struct {
	Status        int
	Code, Message string
}

func (e *Error) Error() string     { return e.Message }
func invalid(message string) error { return &Error{422, "invalid_task", message} }

type Service struct {
	db     Repository
	deps   Dependencies
	config Config
}

func New(db Repository, deps Dependencies, config Config) (*Service, error) {
	if db == nil || deps.Control == nil || deps.Resolve == nil || deps.Credentials == nil || deps.ValidateArgs == nil {
		return nil, errors.New("task service requires resolver, credentials, scheduler and argument validation")
	}
	if config.RuntimeDir == "" || config.ProjectDir == "" || config.OutputRoot == "" || len(config.AllowedOutputRoots) == 0 {
		return nil, errors.New("task path configuration is incomplete")
	}
	return &Service{db: db, deps: deps, config: config}, nil
}

var sitePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
var credentialPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var aliases = map[string]string{"x": "twitter", "twitter": "twitter", "pixiv": "pixiv", "danbooru": "danbooru", "exhentai": "exhentai", "eh": "exhentai", "e-hentai": "exhentai", "e_hentai": "exhentai", "pawchive": "pawchive"}

func canonicalSite(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if canonical, ok := aliases[value]; ok {
		return canonical
	}
	return value
}
func text(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func optional(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (r *Create) validate() error {
	length := utf8.RuneCountInString(r.URL)
	if length < 4 || length > 8192 {
		return invalid("url 长度无效")
	}
	r.URL = strings.TrimSpace(r.URL)
	if !urlPattern.MatchString(r.URL) {
		return invalid("url 必须是 HTTP(S) 图站地址或 gallery-dl 提取器前缀地址")
	}
	if r.Site != nil {
		site := strings.ToLower(strings.TrimSpace(*r.Site))
		if !sitePattern.MatchString(site) {
			return invalid("site 格式无效")
		}
		r.Site = &site
	}
	for _, value := range []*string{r.OutputDir, r.CookiesFile, r.ConfigFile} {
		if value != nil && (utf8.RuneCountInString(*value) > 2048 || strings.ContainsRune(*value, 0)) {
			return invalid("文件路径格式无效")
		}
	}
	if r.ProxyMode != nil && *r.ProxyMode != "direct" && *r.ProxyMode != "prefer" && *r.ProxyMode != "required" {
		return invalid("proxy_mode 无效")
	}
	if r.MaxAttempts != nil && (*r.MaxAttempts < 1 || *r.MaxAttempts > 20) {
		return invalid("max_attempts 超出范围")
	}
	if r.Priority < -1000 || r.Priority > 1000 {
		return invalid("priority 超出范围")
	}
	if r.CredentialsRef != nil {
		if utf8.RuneCountInString(*r.CredentialsRef) > 128 {
			return invalid("credentials_ref 格式无效")
		}
		value := strings.TrimSpace(*r.CredentialsRef)
		if value != "" && !credentialPattern.MatchString(value) {
			return invalid("credentials_ref 格式无效")
		}
		r.CredentialsRef = &value
	}
	if len(r.ExtraArgs) > 128 {
		return invalid("extra_args 超出上限")
	}
	if r.ExtraArgs == nil {
		r.ExtraArgs = []string{}
	}
	if r.EHDownload != nil {
		if r.EHDownload.ImageMode != "original" && r.EHDownload.ImageMode != "resample" {
			return invalid("eh_download.image_mode 无效")
		}
		if r.EHDownload.GPPolicy != "stop" && r.EHDownload.GPPolicy != "resized" {
			return invalid("eh_download.gp_policy 无效")
		}
	}
	return nil
}

func (s *Service) Enqueue(ctx context.Context, body Create, idempotencyKey *string) (map[string]any, bool, error) {
	if err := body.validate(); err != nil {
		return nil, false, err
	}
	key := ""
	if idempotencyKey != nil {
		if utf8.RuneCountInString(*idempotencyKey) > 200 {
			return nil, false, &Error{422, "invalid_idempotency_key", "Idempotency-Key 过长"}
		}
		key = strings.TrimSpace(*idempotencyKey)
		if key == "" {
			return nil, false, &Error{422, "invalid_idempotency_key", "Idempotency-Key 为空"}
		}
		existing, err := s.db.GetTaskByIdempotency(ctx, key)
		if err != nil || existing != nil {
			return existing, false, err
		}
	}
	if err := s.validateTarget(ctx, body.URL); err != nil {
		return nil, false, invalid(err.Error())
	}
	info, err := s.deps.Resolve(ctx, body.URL)
	if err != nil {
		return nil, false, err
	}
	site := info.Site
	if body.Site != nil {
		site = canonicalSite(*body.Site)
		if info.Supported {
			explicit, known := aliases[site]
			resolved, resolvedKnown := aliases[info.Site]
			if known && resolvedKnown && explicit != resolved {
				return nil, false, invalid("site 与 URL 提取器站点不一致")
			}
		}
	}
	raw := s.config.DefaultPolicy
	stored, err := s.db.GetSitePolicy(ctx, site)
	if err != nil {
		return nil, false, err
	}
	if stored != nil {
		var ok bool
		raw, ok = stored["policy"].(map[string]any)
		if !ok {
			return nil, false, errors.New("stored site policy is invalid")
		}
	}
	// New tasks get fixed runtime settings plus only the four editable fields.
	projected := map[string]any{}
	for _, field := range []string{"max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"} {
		if value, ok := raw[field]; ok {
			projected[field] = value
		}
	}
	p, err := scheduler.ParsePolicy(projected)
	if err != nil {
		return nil, false, invalid("站点策略无效")
	}
	if body.EHDownload != nil {
		if site != "exhentai" {
			return nil, false, invalid("eh_download 仅适用于 EH/EHX 任务")
		}
		p.EHDownload = body.EHDownload
	}
	managed, err := s.deps.Credentials(ctx, site)
	if err != nil {
		return nil, false, err
	}
	reference, cookies, configuration := text(body.CredentialsRef), text(body.CookiesFile), text(body.ConfigFile)
	if reference == "" {
		reference = managed.Reference
	}
	if cookies == "" {
		cookies = managed.CookiesFile
	}
	if configuration == "" {
		configuration = managed.ConfigFile
	}
	cookies, err = allowedFile(cookies, s.config.ProjectDir, s.config.AllowedCookieRoots, "cookies_file")
	if err != nil {
		return nil, false, invalid(err.Error())
	}
	configuration, err = allowedFile(configuration, s.config.ProjectDir, s.config.AllowedConfigRoots, "config_file")
	if err != nil {
		return nil, false, invalid(err.Error())
	}
	if _, err = s.deps.ValidateArgs(append(append([]string{}, p.ExtraArgs...), body.ExtraArgs...)); err != nil {
		return nil, false, invalid(err.Error())
	}
	id := newID()
	output, err := s.config.outputDir(text(body.OutputDir), id)
	if err != nil {
		return nil, false, invalid(err.Error())
	}
	proxyMode := p.ProxyMode
	if body.ProxyMode != nil {
		proxyMode = *body.ProxyMode
	}
	attempts := p.RetryLimit + 1
	if body.MaxAttempts != nil {
		attempts = *body.MaxAttempts
	}
	data, err := json.Marshal(p)
	if err != nil {
		return nil, false, err
	}
	var snapshot map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err = decoder.Decode(&snapshot); err != nil {
		return nil, false, err
	}
	delete(snapshot, "allowed_proxy_ids")
	row := map[string]any{"id": id, "url": body.URL, "site": site, "subcategory": info.Subcategory, "extractor": info.Extractor, "priority": body.Priority, "output_dir": output, "proxy_mode": proxyMode, "max_attempts": attempts, "cookies_file": optional(cookies), "config_file": optional(configuration), "credentials_ref": optional(reference), "extra_args": body.ExtraArgs, "policy": snapshot}
	task, created, err := s.db.CreateTask(ctx, row, key)
	if err == nil {
		s.deps.Control.Notify()
	}
	return task, created, err
}

func (s *Service) Cancel(ctx context.Context, id string) (map[string]any, error) {
	return s.deps.Control.Cancel(ctx, id)
}

func (s *Service) Retry(ctx context.Context, id string, attempts int) (map[string]any, error) {
	if attempts < 1 || attempts > 20 {
		return nil, &Error{422, "validation_error", "additional_attempts 必须介于 1 和 20"}
	}
	return s.deps.Control.Retry(ctx, id, attempts)
}

func newID() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}
