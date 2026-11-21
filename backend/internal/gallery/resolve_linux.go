package gallery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const ResolveTimeout = 5 * time.Second
const MaxResolveOutputBytes int64 = 16 * 1024

// SiteInfo is executor metadata, independent of task and HTTP service types.
type SiteInfo struct {
	Site        string `json:"site"`
	Subcategory string `json:"subcategory"`
	Extractor   string `json:"extractor"`
	Supported   bool   `json:"supported"`
	Host        string `json:"host"`
}

// Resolve performs local extractor selection, not extraction or a CLI dump job.
// It shares Capture's registry, output budget and process-group cleanup. An
// earlier caller deadline wins; even an unbounded context gets ResolveTimeout.
// Cancellation and errors return only after the worker has been reaped.
func (r *Runner) Resolve(ctx context.Context, url string) (SiteInfo, error) {
	output, err := r.resolveOutput(ctx, Request{ID: "resolve", URL: url, resolve: true}, 1)
	if err != nil {
		return SiteInfo{}, err
	}
	return parseSiteInfo(output)
}

// ResolveBatch selects extractors in input order in one supervised worker.
func (r *Runner) ResolveBatch(ctx context.Context, urls []string) ([]SiteInfo, error) {
	input, err := json.Marshal(urls)
	if err != nil {
		return nil, err
	}
	output, err := r.resolveOutput(ctx, Request{ID: "resolve", resolve: true, resolveInput: input}, len(urls))
	if err != nil {
		return nil, err
	}
	var rows []json.RawMessage
	if err := json.Unmarshal([]byte(output), &rows); err != nil {
		return nil, fmt.Errorf("invalid gallery batch resolve JSON: %w", err)
	}
	if len(rows) != len(urls) {
		return nil, fmt.Errorf("gallery batch resolve returned %d results for %d URLs", len(rows), len(urls))
	}
	infos := make([]SiteInfo, len(rows))
	for i, row := range rows {
		infos[i], err = parseSiteInfo(string(row))
		if err != nil {
			return nil, err
		}
	}
	return infos, nil
}

func (r *Runner) resolveOutput(ctx context.Context, req Request, count int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, ResolveTimeout)
	defer cancel()
	result, err := r.Capture(ctx, CaptureRequest{Request: req, MaxOutputBytes: int64(count) * MaxResolveOutputBytes})
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("gallery resolve exited %d: %s", result.ExitCode, result.Stderr)
	}
	return result.Stdout, nil
}

func parseSiteInfo(output string) (SiteInfo, error) {
	// Pointers distinguish required empty/false values from missing or null fields.
	var wire struct {
		Site        *string `json:"site"`
		Subcategory *string `json:"subcategory"`
		Extractor   *string `json:"extractor"`
		Supported   *bool   `json:"supported"`
		Host        *string `json:"host"`
	}
	decoder := json.NewDecoder(strings.NewReader(output))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return SiteInfo{}, fmt.Errorf("invalid gallery resolve JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return SiteInfo{}, errors.New("gallery resolve returned trailing output")
	}
	if wire.Site == nil || wire.Subcategory == nil || wire.Extractor == nil || wire.Supported == nil || wire.Host == nil || *wire.Site == "" {
		return SiteInfo{}, errors.New("gallery resolve response requires all five site fields")
	}
	return SiteInfo{Site: *wire.Site, Subcategory: *wire.Subcategory, Extractor: *wire.Extractor,
		Supported: *wire.Supported, Host: *wire.Host}, nil
}
