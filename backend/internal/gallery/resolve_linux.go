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
	ctx, cancel := context.WithTimeout(ctx, ResolveTimeout)
	defer cancel()
	result, err := r.Capture(ctx, CaptureRequest{
		Request:        Request{ID: "resolve", URL: url, resolve: true},
		MaxOutputBytes: MaxResolveOutputBytes,
	})
	if err != nil {
		return SiteInfo{}, err
	}
	if result.ExitCode != 0 {
		return SiteInfo{}, fmt.Errorf("gallery resolve exited %d: %s", result.ExitCode, result.Stderr)
	}
	return parseSiteInfo(result.Stdout)
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
