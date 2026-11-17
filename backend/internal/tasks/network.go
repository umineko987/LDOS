package tasks

import (
	"context"
	"regexp"
	"strings"

	"ldos/backend/internal/network"
)

var urlPattern = regexp.MustCompile(`(?i)^(?:[a-z0-9_-]+:(?:r:)?)?https?://`)

func plainURL(value string) string {
	lower := strings.ToLower(value)
	i, j := strings.Index(lower, "http://"), strings.Index(lower, "https://")
	if i < 0 || (j >= 0 && j < i) {
		i = j
	}
	if i >= 0 {
		return value[i:]
	}
	return value
}

type LookupIP func(context.Context, string) ([]string, error)

func (s *Service) validateTarget(ctx context.Context, target string) error {
	if s.deps.ValidateTarget != nil {
		return s.deps.ValidateTarget(ctx, target)
	}
	return ValidateTarget(ctx, target, s.config.AllowPrivateTargets, s.config.StrictTargetDNS, s.deps.LookupIP)
}

// ValidateTarget only checks the URL. Legacy DNS options stay in the signature
// for existing callers, but no longer trigger lookups or reject DNS answers.
func ValidateTarget(ctx context.Context, value string, allowPrivate, strict bool, lookup LookupIP) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := network.ValidateSyntax(plainURL(strings.TrimSpace(value)), allowPrivate)
	return err
}
