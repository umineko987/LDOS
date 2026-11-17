package discovery

import (
	"context"

	"ldos/backend/internal/scheduler"
)

// ValidateTarget admits a crawl without a DNS lookup or an extra proxy lease.
// DNS resolution happens only when the selected transport makes the request.
func (t *Transport) ValidateTarget(ctx context.Context, target, mode string, policy scheduler.Policy) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err := t.Validator.ValidateStatic(target)
	return err
}
