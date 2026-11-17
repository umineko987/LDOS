package gallery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
)

// ResolveDanbooruAuth evaluates the same command/config/credential precedence as
// extraction, offline. Secret-bearing stdout is consumed privately, never sent
// through diagnostic redaction, callbacks or CaptureResult.
func (r *Runner) ResolveDanbooruAuth(ctx context.Context, req Request) (http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, ResolveTimeout)
	defer cancel()
	req.ID = "danbooru-auth"
	req.resolve = false
	p, err := r.prepare(req, 0)
	if err != nil {
		return nil, errors.New("Danbooru API 回退无法解析已配置的认证或参数")
	}
	req.ID = p.marker
	args := p.cmd.Args
	p.cmd.Args = append(append(append([]string{}, args[:7]...), "--danbooru-auth"), args[7:]...)
	var stdout bytes.Buffer
	read := func(pipe io.Reader, name string) error {
		data, err := io.ReadAll(io.LimitReader(pipe, 64*1024+1))
		if len(data) > 64*1024 {
			return ErrCaptureLimit
		}
		if name == "stdout" {
			stdout.Write(data)
		}
		if errors.Is(err, os.ErrClosed) {
			return nil
		}
		return err
	}
	result, err := r.execute(ctx, req, p, 0, read)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil || result.ExitCode != 0 || result.TimedOut {
		return nil, errors.New("Danbooru API 回退认证解析器执行失败")
	}
	var wire struct {
		Headers map[string]string `json:"headers"`
		Error   string            `json:"error"`
	}
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("Danbooru API 回退认证解析器返回无效结果")
	}
	if wire.Error != "" {
		message := "Danbooru API 回退无法解析或保留已配置的认证，请检查配置、凭据和 Cookie"
		switch wire.Error {
		case "unsupported_cookies":
			message = "Danbooru API 回退无法保留浏览器 Cookie 或轮换 Cookie，请提供有效的 Cookie 文件"
		case "no_valid_cookies":
			message = "Danbooru API 回退没有适用于此请求的有效 Cookie，请更新 Cookie"
		case "incomplete_credentials":
			message = "Danbooru API 回退需要完整的用户名和 API key"
		case "unsupported_headers":
			message = "Danbooru API 回退无法保留当前请求头配置"
		}
		return nil, errors.New(message)
	}
	if wire.Headers == nil {
		return nil, errors.New("Danbooru API 回退认证解析器返回无效结果")
	}
	headers := make(http.Header, len(wire.Headers))
	for key, value := range wire.Headers {
		if key == "" || strings.ContainsAny(key, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return nil, errors.New("Danbooru API 回退认证请求头无效")
		}
		headers.Set(key, value)
	}
	return headers, nil
}
