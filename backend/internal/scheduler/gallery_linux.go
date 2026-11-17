package scheduler

import (
	"context"
	"time"

	"ldos/backend/internal/gallery"
)

// GalleryRunner adapts the necessary gallery-dl executor. Scheduling, retry
// decisions, leases and persistence remain native Go responsibilities.
type GalleryRunner struct{ Runner *gallery.Runner }

func (g GalleryRunner) Run(ctx context.Context, id string, r RunRequest) (RunResult, error) {
	if _, err := g.Runner.ValidateArgs(r.ExtraArgs); err != nil {
		return RunResult{}, ConfigurationError{err}
	}
	request := gallery.Request{
		ID: id, URL: r.URL, OutputDir: r.OutputDir, Site: r.Site,
		CookiesFile: r.CookiesFile, ConfigFile: r.ConfigFile, CredentialsRef: r.CredentialsRef, ProxyURL: r.ProxyURL,
		HTTPTimeout: seconds(r.Policy.HTTPTimeout), TaskTimeout: seconds(r.Policy.TaskTimeout), GalleryRetries: r.Policy.GalleryRetries,
		ExtraArgs: r.ExtraArgs, OnStarted: r.OnStarted,
	}
	if r.Policy.EHDownload != nil {
		request.EHDownload = &gallery.EHDownloadOptions{ImageMode: r.Policy.EHDownload.ImageMode, GPPolicy: r.Policy.EHDownload.GPPolicy}
	}
	out, err := g.Runner.Run(ctx, gallery.RunRequest{Request: request, StallTimeout: seconds(r.Policy.StallTimeout), OnLine: r.OnLine})
	result := RunResult{OutputTail: out.OutputTail, TimedOut: out.TimedOut}
	if out.PID > 0 {
		result.ExitCode = &out.ExitCode
	}
	return result, err
}

func seconds(value float64) time.Duration { return time.Duration(value * float64(time.Second)) }

func StaleProcessTerminator(grace time.Duration) func(context.Context, int, string) error {
	return func(ctx context.Context, pid int, marker string) error {
		_, err := gallery.TerminateStaleProcess(ctx, pid, marker, grace)
		return err
	}
}
