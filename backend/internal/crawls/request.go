package crawls

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

type Options struct {
	ProxyMode          *string  `json:"proxy_mode"`
	MaxAttempts        *int     `json:"max_attempts"`
	Priority           *int     `json:"priority"`
	CredentialsRef     *string  `json:"credentials_ref"`
	CookiesFile        *string  `json:"cookies_file"`
	ConfigFile         *string  `json:"config_file"`
	ExtraArgs          []string `json:"extra_args"`
	DiscoveryExtraArgs []string `json:"discovery_extra_args"`
	TimeoutSeconds     *float64 `json:"timeout_seconds"`
}
type Address struct {
	URL         string   `json:"url"`
	ID          *string  `json:"id"`
	Label       *string  `json:"label"`
	AddressType *string  `json:"address_type"`
	ExtraArgs   []string `json:"extra_args"`
}
type Source struct {
	Options
	Site       string               `json:"site"`
	Addresses  []Address            `json:"addresses"`
	EHDownload *scheduler.EHOptions `json:"eh_download"`
	// Explicit records source fields supplied as null. Non-nil pointer fields
	// always override the batch; HTTP decoding fills this map automatically.
	Explicit map[string]bool `json:"-"`
}
type Request struct {
	Options
	Sources     []Source `json:"sources"`
	Concurrency int      `json:"concurrency"`
	MaxTasks    int      `json:"max_tasks"`
	OutputDir   *string  `json:"output_dir"`
}

func (s *Source) UnmarshalJSON(data []byte) error {
	type plain Source
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return fmt.Errorf("来源必须是对象")
	}
	if err := nonnull(raw, "site", "addresses", "priority", "extra_args", "discovery_extra_args", "timeout_seconds"); err != nil {
		return err
	}
	v := plain{}
	if eh, ok := raw["eh_download"]; ok && string(eh) != "null" {
		v.EHDownload = &scheduler.EHOptions{ImageMode: "original", GPPolicy: "stop"}
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*s = Source(v)
	s.Explicit = map[string]bool{}
	for key := range raw {
		s.Explicit[key] = true
	}
	return nil
}
func (a *Address) UnmarshalJSON(data []byte) error {
	type plain Address
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return fmt.Errorf("地址必须是对象")
	}
	if err := nonnull(raw, "url", "extra_args"); err != nil {
		return err
	}
	return json.Unmarshal(data, (*plain)(a))
}
func nonnull(raw map[string]json.RawMessage, fields ...string) error {
	for _, key := range fields {
		if v, ok := raw[key]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return fmt.Errorf("%s 不能为 null", key)
		}
	}
	return nil
}
func DecodeRequest(data []byte) (Request, error) {
	body := Request{Concurrency: 20, MaxTasks: 10000}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return body, &Error{Status: 422, Code: "validation_error", Message: "请求必须是 JSON 对象"}
	}
	if err := nonnull(raw, "sources", "concurrency", "max_tasks", "priority", "extra_args", "discovery_extra_args", "timeout_seconds"); err != nil {
		return body, &Error{Status: 422, Code: "validation_error", Message: err.Error()}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&body); err != nil {
		return body, &Error{Status: 422, Code: "validation_error", Message: err.Error()}
	}
	if d.Decode(new(any)) != io.EOF {
		return body, invalid("请求包含多余 JSON")
	}
	if err := body.validate(); err != nil {
		return body, err
	}
	return body, nil
}

var siteRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
var credentialRE = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var taskURLRE = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9+.-]*:)*https?://`)

func bounded(p *string, n int) bool { return p == nil || utf8.RuneCountInString(*p) <= n }
func (o *Options) validate() error {
	if o.ProxyMode != nil && *o.ProxyMode != "direct" && *o.ProxyMode != "prefer" && *o.ProxyMode != "required" {
		return invalid("proxy_mode 无效")
	}
	if o.MaxAttempts != nil && (*o.MaxAttempts < 1 || *o.MaxAttempts > 20) {
		return invalid("max_attempts 超出范围")
	}
	if o.Priority != nil && (*o.Priority < -1000 || *o.Priority > 1000) {
		return invalid("priority 超出范围")
	}
	if o.TimeoutSeconds != nil && (*o.TimeoutSeconds < 5 || *o.TimeoutSeconds > 3600) {
		return invalid("timeout_seconds 超出范围")
	}
	if len(o.ExtraArgs) > 128 || len(o.DiscoveryExtraArgs) > 128 {
		return invalid("参数数量超出上限")
	}
	if !bounded(o.CredentialsRef, 128) || !bounded(o.CookiesFile, 2048) || !bounded(o.ConfigFile, 2048) {
		return invalid("凭据路径或引用过长")
	}
	if o.CredentialsRef != nil {
		v := strings.TrimSpace(*o.CredentialsRef)
		if v != "" && !credentialRE.MatchString(v) {
			return invalid("credentials_ref 格式无效")
		}
		o.CredentialsRef = &v
	}
	return nil
}
func (r *Request) validate() error {
	if len(r.Sources) < 1 || len(r.Sources) > 20 {
		return invalid("sources 数量必须介于 1 和 20")
	}
	if r.Concurrency < 1 || r.Concurrency > 128 || r.MaxTasks < 1 || r.MaxTasks > 100000 {
		return invalid("concurrency 或 max_tasks 超出范围")
	}
	if !bounded(r.OutputDir, 2048) {
		return invalid("output_dir 过长")
	}
	if err := r.Options.validate(); err != nil {
		return err
	}
	seen := map[string]bool{}
	for i := range r.Sources {
		source := &r.Sources[i]
		source.Site = strings.ToLower(strings.TrimSpace(source.Site))
		if !siteRE.MatchString(source.Site) {
			return invalid("site 格式无效")
		}
		if seen[source.Site] {
			return invalid("sources 中同一来源只保留一个分组")
		}
		seen[source.Site] = true
		if len(source.Addresses) < 1 || len(source.Addresses) > 500 {
			return invalid("addresses 数量必须介于 1 和 500")
		}
		if err := source.Options.validate(); err != nil {
			return err
		}
		if source.EHDownload != nil {
			eh := source.EHDownload
			if eh.ImageMode != "original" && eh.ImageMode != "resample" || eh.GPPolicy != "stop" && eh.GPPolicy != "resized" {
				return invalid("eh_download 无效")
			}
		}
		for j := range source.Addresses {
			a := &source.Addresses[j]
			n := utf8.RuneCountInString(a.URL)
			a.URL = strings.TrimSpace(a.URL)
			if n < 4 || n > 8192 || !taskURLRE.MatchString(a.URL) {
				return invalid("url 必须是 HTTP(S) 图站地址或 gallery-dl 提取器前缀地址")
			}
			if !bounded(a.ID, 500) || !bounded(a.Label, 500) || !bounded(a.AddressType, 100) || len(a.ExtraArgs) > 128 {
				return invalid("地址字段超出上限")
			}
		}
	}
	return nil
}
func override[T any](source, base *T, explicit bool) *T {
	if source != nil || explicit {
		return source
	}
	return base
}
func (s Source) effective(base Options) Options {
	return Options{ProxyMode: override(s.ProxyMode, base.ProxyMode, s.Explicit["proxy_mode"]), MaxAttempts: override(s.MaxAttempts, base.MaxAttempts, s.Explicit["max_attempts"]), Priority: override(s.Priority, base.Priority, s.Explicit["priority"]), CredentialsRef: override(s.CredentialsRef, base.CredentialsRef, s.Explicit["credentials_ref"]), CookiesFile: override(s.CookiesFile, base.CookiesFile, s.Explicit["cookies_file"]), ConfigFile: override(s.ConfigFile, base.ConfigFile, s.Explicit["config_file"]), TimeoutSeconds: override(s.TimeoutSeconds, base.TimeoutSeconds, s.Explicit["timeout_seconds"]), ExtraArgs: append(append([]string{}, base.ExtraArgs...), s.ExtraArgs...), DiscoveryExtraArgs: append(append([]string{}, base.DiscoveryExtraArgs...), s.DiscoveryExtraArgs...)}
}
func keyValue(key *string) (string, error) {
	if key == nil {
		return "", nil
	}
	if utf8.RuneCountInString(*key) > 200 {
		return "", &Error{Status: 422, Code: "invalid_idempotency_key", Message: "Idempotency-Key 过长"}
	}
	v := strings.TrimSpace(*key)
	if v == "" {
		return "", &Error{Status: 422, Code: "invalid_idempotency_key", Message: "Idempotency-Key 为空"}
	}
	return v, nil
}
func hasRange(args []string) bool {
	for _, arg := range args {
		for _, name := range []string{"--range", "--post-range", "--child-range"} {
			if arg == name || strings.HasPrefix(arg, name+"=") {
				return true
			}
		}
	}
	return false
}
func (s *Service) validateArgs(args, discover []string) error {
	if _, err := s.deps.ValidateArgs(args); err != nil {
		return invalid(err.Error())
	}
	if hasRange(args) {
		return invalid("图片范围参数由单地址并发规划器管理")
	}
	if _, err := discoverydata.ValidateArgs(discover); err != nil {
		return invalid(err.Error())
	}
	return nil
}
func (s *Service) credentials(ctx context.Context, site string, opt Options) (Credentials, error) {
	c, err := s.deps.Credentials(ctx, site, CredentialsRequest{opt.CredentialsRef, opt.CookiesFile, opt.ConfigFile})
	if err != nil {
		return c, err
	}
	c.CookiesFile, err = tasks.ResolveCredentialFile(c.CookiesFile, s.deps.Settings.ProjectDir, s.deps.Settings.AllowedCookieRoots, "cookies_file")
	if err != nil {
		return c, invalid(err.Error())
	}
	c.ConfigFile, err = tasks.ResolveCredentialFile(c.ConfigFile, s.deps.Settings.ProjectDir, s.deps.Settings.AllowedConfigRoots, "config_file")
	if err != nil {
		return c, invalid(err.Error())
	}
	return c, nil
}

// Create persists a batch and its ordered source/address cursor. The boolean is
// false on idempotency replay. Work begins only after Start (or RunOnce).
func (s *Service) Create(ctx context.Context, body Request, idempotencyKey *string) (map[string]any, bool, error) {
	if err := body.validate(); err != nil {
		return nil, false, err
	}
	key, err := keyValue(idempotencyKey)
	if err != nil {
		return nil, false, err
	}
	if key != "" {
		row, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM crawl_batches WHERE idempotency_key=?", key)
		if e != nil {
			return nil, false, e
		}
		if row != nil {
			batch, e := s.Get(ctx, str(row["id"]))
			return batch, false, e
		}
	}
	if err := s.validateArgs(body.ExtraArgs, body.DiscoveryExtraArgs); err != nil {
		return nil, false, err
	}
	seen := map[string]bool{}
	for i := range body.Sources {
		spec, e := discoverydata.SearchSite(body.Sources[i].Site)
		if e != nil {
			return nil, false, invalid(e.Error())
		}
		if seen[spec.Site] {
			return nil, false, invalid("sources 重复配置来源: " + spec.Site)
		}
		seen[spec.Site] = true
		body.Sources[i].Site = spec.Site
	}
	id := uuid.New()
	output, err := s.outputDir(text(body.OutputDir), "batch-"+id.String())
	if err != nil {
		return nil, false, invalid(err.Error())
	}
	addresses := []map[string]any{}
	for sourceOrder, source := range body.Sources {
		policy, e := s.deps.PolicyFor(ctx, source.Site)
		if e != nil {
			return nil, false, e
		}
		if source.EHDownload != nil && source.Site != "exhentai" {
			return nil, false, invalid("eh_download 仅适用于 EH/EHX 来源")
		}
		download := map[string]any{}
		if source.EHDownload != nil {
			download["eh"] = source.EHDownload
		}
		opt := source.effective(body.Options)
		if err := s.validateArgs(opt.ExtraArgs, opt.DiscoveryExtraArgs); err != nil {
			return nil, false, err
		}
		creds, e := s.credentials(ctx, source.Site, opt)
		if e != nil {
			return nil, false, e
		}
		mode := text(opt.ProxyMode)
		if mode == "" {
			mode = policy.ProxyMode
		}
		attempts := policy.RetryLimit + 1
		if opt.MaxAttempts != nil {
			attempts = *opt.MaxAttempts
		}
		priority := 0
		if opt.Priority != nil {
			priority = *opt.Priority
		}
		timeout := 180.0
		if opt.TimeoutSeconds != nil {
			timeout = *opt.TimeoutSeconds
		}
		for addressOrder, a := range source.Addresses {
			target, e := discoverydata.CanonicalAddress(source.Site, a.URL)
			if e != nil {
				return nil, false, invalid(e.Error())
			}
			if err := s.deps.ValidateTarget(ctx, target, mode, policy); err != nil {
				return nil, false, invalid(err.Error())
			}
			if source.Site == "exhentai" && !ehGalleryRE.MatchString(target) {
				return nil, false, invalid("EH 来源地址必须是具体画廊 /g/GID/TOKEN/")
			}
			args := append(append([]string{}, opt.ExtraArgs...), a.ExtraArgs...)
			if err := s.validateArgs(args, nil); err != nil {
				return nil, false, err
			}
			addressID := uuid.NewSHA1(id, []byte(fmt.Sprintf("%d:%d:%s", sourceOrder, addressOrder, target))).String()
			addresses = append(addresses, map[string]any{"id": addressID, "site": source.Site, "source_order": sourceOrder, "address_order": addressOrder, "url": target, "label": text(a.Label), "address_type": text(a.AddressType), "proxy_mode": mode, "max_attempts": attempts, "priority": priority, "credentials_ref": nullable(creds.Reference), "cookies_file": nullable(creds.CookiesFile), "config_file": nullable(creds.ConfigFile), "download_options": download, "extra_args": args, "discovery_args": opt.DiscoveryExtraArgs, "timeout_seconds": timeout})
		}
	}
	for start := 0; start < len(addresses); start += enqueueChunkSize {
		group := addresses[start:min(start+enqueueChunkSize, len(addresses))]
		urls := make([]string, len(group))
		for i, a := range group {
			urls[i] = str(a["url"])
		}
		infos, err := s.resolveGroup(ctx, urls)
		if err != nil {
			return nil, false, err
		}
		for i, info := range infos {
			if info.Supported {
				if spec, e := discoverydata.SearchSite(info.Site); e == nil && spec.Site != group[i]["site"] {
					return nil, false, invalid("site 与 URL 提取器站点不一致")
				}
			}
		}
	}
	batchID := id.String()
	created := false
	concurrency := min(body.Concurrency, s.deps.Settings.Scheduler.MaxConcurrentTasks)
	err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if key != "" {
			row, e := store.QueryRowTx(ctx, tx, "SELECT id FROM crawl_batches WHERE idempotency_key=?", key)
			if e != nil {
				return e
			}
			if row != nil {
				batchID = str(row["id"])
				return nil
			}
		}
		stamp := now()
		if _, e := tx.ExecContext(ctx, `INSERT INTO crawl_batches(id,idempotency_key,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?,?)`, batchID, nullable(key), output, concurrency, body.MaxTasks, stamp, stamp); e != nil {
			return e
		}
		for _, a := range addresses {
			_, e := tx.ExecContext(ctx, `INSERT INTO crawl_addresses(id,batch_id,site,source_order,address_order,url,label,address_type,status,proxy_mode,max_attempts,priority,credentials_ref,cookies_file,config_file,download_options_json,extra_args_json,discovery_args_json,timeout_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?)`, a["id"], batchID, a["site"], a["source_order"], a["address_order"], a["url"], a["label"], a["address_type"], a["proxy_mode"], a["max_attempts"], a["priority"], a["credentials_ref"], a["cookies_file"], a["config_file"], jsonText(a["download_options"]), jsonText(a["extra_args"]), jsonText(a["discovery_args"]), a["timeout_seconds"], stamp, stamp)
			if e != nil {
				return e
			}
		}
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	s.Notify()
	result, err := s.Get(ctx, batchID)
	if err != nil {
		return nil, false, err
	}
	result["created"] = created
	result["requested_concurrency"] = body.Concurrency
	result["effective_concurrency"] = concurrency
	return result, created, nil
}
