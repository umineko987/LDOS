package discovery

import (
	"context"
	"errors"
	"fmt"
	"os"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

type Request struct {
	Site, URL                                          string
	Keyword                                            *string
	Limit                                              int
	RangeKind                                          string
	RangeLimit                                         *int
	Policy                                             scheduler.Policy
	ProxyMode, CredentialsRef, CookiesFile, ConfigFile string
	ExtraArgs                                          []string
	TimeoutSeconds                                     float64
}
type GalleryPlan struct {
	Site, RangeKind         string
	ResultLimit, RangeLimit int
	Args                    []string
}

func BuildGalleryPlan(request Request) (GalleryPlan, error) {
	spec, err := discoverydata.SearchSite(request.Site)
	if err != nil {
		return GalleryPlan{}, err
	}
	args, err := discoverydata.ValidateArgs(request.ExtraArgs)
	if err != nil {
		return GalleryPlan{}, err
	}
	if spec.Site == "pixiv" {
		args, err = discoverydata.PixivFirstMediaArgs(args)
		if err != nil {
			return GalleryPlan{}, err
		}
	}
	kind := request.RangeKind
	if kind == "" {
		kind = spec.SearchRange
	}
	option, ok := map[string]string{"file": "--range", "post": "--post-range", "child": "--child-range"}[kind]
	if !ok {
		return GalleryPlan{}, errors.New("搜索范围无效")
	}
	limit := request.Limit
	if request.RangeLimit != nil {
		limit = *request.RangeLimit
	}
	return GalleryPlan{spec.Site, kind, request.Limit, limit, append([]string{"--dump-json", option, fmt.Sprintf("1-%d", limit)}, args...)}, nil
}

type GalleryAdapter struct{ Transport *Transport }

func (a *GalleryAdapter) Discover(ctx context.Context, request Request) (map[string]any, error) {
	plan, err := BuildGalleryPlan(request)
	if err != nil {
		return nil, err
	}
	mode := request.ProxyMode
	if mode == "" {
		mode = request.Policy.ProxyMode
	}
	secure := request.Keyword != nil
	outcome, err := a.Transport.Execute(ctx, ExecuteOptions{URL: request.URL, Mode: mode, Prefix: "discover", Policy: request.Policy, Secure: secure, AcquireErrorFatal: secure || mode == "required", NodeTags: request.Policy.NodeTags, Cleanup: a.Transport.CleanupOperation,
		Operation: func(ctx context.Context, attempt Attempt) (any, error) {
			result, err := a.Transport.Gallery.Capture(ctx, gallery.CaptureRequest{Request: gallery.Request{ID: attempt.ID, URL: request.URL, OutputDir: a.Transport.OperationDirectory(attempt.ID), ProxyURL: attempt.Endpoint(), HTTPTimeout: duration(request.Policy.HTTPTimeout), GalleryRetries: request.Policy.GalleryRetries, TaskTimeout: duration(request.TimeoutSeconds), CookiesFile: request.CookiesFile, ConfigFile: request.ConfigFile, CredentialsRef: request.CredentialsRef, Site: plan.Site, ExtraArgs: plan.Args}})
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return nil, &Error{Code: "discovery_configuration", Message: redaction.Text(err.Error(), 1000)}
				}
				return nil, err
			}
			decision := scheduler.Classify(&result.ExitCode, result.Stderr, false, result.TimedOut)
			if decision.ErrorClass != "success" {
				return nil, &Failure{Message: decision.Message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable, ProxyFault: decision.ProxyFault, AuthContext: result.Stderr}
			}
			candidates, authors, err := discoverydata.ParseOutput(plan.Site, result.Stdout, request.URL, plan.ResultLimit)
			if err != nil {
				var parseError *Error
				if !errors.As(err, &parseError) {
					return nil, err
				}
				message := redaction.Text(parseError.Message, 1000)
				code := 1
				decision := scheduler.Classify(&code, result.Stderr+"\n"+message, false, false)
				details := map[string]any{"public_code": parseError.Code}
				if values, ok := parseError.Details.(map[string]any); ok {
					if list, ok := values["errors"].([]string); ok {
						safe := []string{}
						for _, value := range list[:min(5, len(list))] {
							safe = append(safe, redaction.Text(value, 500))
						}
						details["errors"] = safe
					}
				}
				return nil, &Failure{Message: message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable, ProxyFault: decision.ProxyFault, AuthContext: result.Stderr, Details: details}
			}
			return map[string]any{"candidates": candidates, "authors": authors}, nil
		}, Classify: func(err error, _ Attempt) *Failure {
			message := redaction.Text(err.Error(), 1000)
			code := 1
			decision := scheduler.Classify(&code, message, false, false)
			return &Failure{Message: message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable, ProxyFault: decision.ProxyFault}
		},
	})
	if err != nil {
		var exhausted *Exhausted
		if !errors.As(err, &exhausted) {
			return nil, err
		}
		failure := exhausted.Failure
		details := map[string]any{"attempts": exhausted.AttemptCount, "message": failure.Message, "proxy": exhausted.Proxy}
		if public, ok := failure.Details["public_code"].(string); ok && public != "" && !failure.Retryable {
			if values, ok := failure.Details["errors"]; ok {
				details["errors"] = values
			}
			return nil, &Error{Code: public, Message: failure.Message, Details: details}
		}
		public := "discovery_failed"
		if failure.ErrorClass == "authentication" {
			public = "authentication"
			message := failure.AuthContext
			if message == "" {
				message = failure.Message
			}
			a.Transport.NotifyAuthFailure(ctx, plan.Site, request.CookiesFile, message)
		}
		message := redaction.Text(failure.Message, 1000)
		details["message"] = message
		return nil, &Error{Code: public, Message: message, Details: details}
	}
	result := outcome.Value.(map[string]any)
	result["site"] = plan.Site
	result["keyword"] = nil
	if request.Keyword != nil {
		result["keyword"] = *request.Keyword
	}
	result["search_url"] = request.URL
	result["candidate_count"] = len(result["candidates"].([]map[string]any))
	result["author_count"] = len(result["authors"].([]map[string]any))
	result["proxy"] = outcome.Proxy
	result["attempts"] = outcome.Attempts
	return result, nil
}
