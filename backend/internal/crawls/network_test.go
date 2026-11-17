package crawls

import (
	"context"
	"errors"
	"testing"

	"ldos/backend/internal/scheduler"
)

func TestCrawlAdmissionAndMediaEnqueueUseProxyValidation(t *testing.T) {
	for _, mode := range []string{"prefer", "required"} {
		t.Run(mode, func(t *testing.T) {
			s, db, _ := fixture(t)
			ctx := context.Background()
			s.deps.Settings.Server.AllowPrivateTargets = false
			s.deps.Settings.Server.StrictTargetDNS = true
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode = mode
			s.deps.PolicyFor = func(context.Context, string) (scheduler.Policy, error) { return policy, nil }
			var targets []string
			s.deps.ValidateTarget = func(_ context.Context, target, gotMode string, got scheduler.Policy) error {
				if gotMode != mode || got.ProxyMode != mode {
					t.Fatal("lost execution mode", gotMode, got.ProxyMode)
				}
				targets = append(targets, target)
				return nil
			}
			batch := createBatch(t, s, batchRequest("https://www.pixiv.net/artworks/101"))
			address := batchAddresses(batch)[0]
			// This hostname cannot resolve locally. Only delegated proxy validation
			// is allowed to admit it; no live network is needed by this regression.
			media := "https://media.example.invalid/image.jpg"
			chunk := Deduplicate([]Unit{{Site: "pixiv", URL: media}})
			prepared, err := s.prepareChunk(ctx, batch, address, policy, chunk, 0)
			good(t, err)
			if len(prepared) != 1 || prepared[0].row["proxy_mode"] != mode || len(targets) != 2 || targets[1] != media {
				t.Fatal("media validation lost", prepared, targets)
			}
			s.deps.ValidateTarget = func(context.Context, string, string, scheduler.Policy) error { return errors.New("private DNS answer") }
			if _, err = s.prepareChunk(ctx, batch, address, policy, chunk, 0); err == nil {
				t.Fatal("media validation bypassed")
			}
			if _, _, err = s.Create(ctx, batchRequest("https://www.pixiv.net/artworks/102"), nil); err == nil {
				t.Fatal("batch validation bypassed")
			}
			row, err := db.QueryRow(ctx, "SELECT COUNT(*) AS n FROM tasks")
			good(t, err)
			if row["n"] != int64(0) {
				t.Fatal("preparation persisted tasks", row)
			}
		})
	}
}
