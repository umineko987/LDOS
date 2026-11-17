package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"ldos/backend/internal/proxytransport"
)

type HTTPResult struct {
	StatusCode int
	Headers    http.Header
	Text       string
	Payload    any
	JSONError  error
}

func requestJSON(ctx context.Context, method, target string, params url.Values, body any, endpoint string, timeout time.Duration) (HTTPResult, error) {
	client, closeClient, err := proxytransport.NewHTTPClient(ctx, endpoint, max(timeout, time.Second))
	if err != nil {
		return HTTPResult{}, err
	}
	defer closeClient()
	parsed, err := url.Parse(target)
	if err != nil {
		return HTTPResult{}, err
	}
	query := parsed.Query()
	for key, values := range params {
		for _, value := range values {
			query.Add(key, value)
		}
	}
	parsed.RawQuery = query.Encode()
	var data []byte
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return HTTPResult{}, err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, parsed.String(), bytes.NewReader(data))
	if err != nil {
		return HTTPResult{}, err
	}
	request.Header.Set("User-Agent", "gallery-dl-backend/0.3")
	if headers := danbooruRequestHeaders(ctx); len(headers) != 0 {
		if parsed.Scheme != "https" || parsed.Host != "danbooru.donmai.us" {
			return HTTPResult{}, errors.New("Danbooru 认证请求头不能发送到其他站点")
		}
		for key, values := range headers {
			request.Header[key] = append([]string(nil), values...)
		}
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return HTTPResult{}, err
	}
	defer response.Body.Close()
	data, err = io.ReadAll(response.Body)
	if err != nil {
		return HTTPResult{}, err
	}
	text := []rune(string(data))
	if len(text) > 4000 {
		text = text[:4000]
	}
	result := HTTPResult{StatusCode: response.StatusCode, Text: string(text), Headers: response.Header.Clone()}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	result.JSONError = decoder.Decode(&result.Payload)
	if result.JSONError == nil && decoder.Decode(new(any)) != io.EOF {
		result.JSONError = errors.New("invalid trailing JSON")
	}
	return result, nil
}
