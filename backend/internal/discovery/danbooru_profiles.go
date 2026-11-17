package discovery

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

// A profile attempt owns one lease for both the identity lookup and artist URLs.
func (a *DanbooruAdapter) danProfileJSON(ctx context.Context, target string, params url.Values, attempt Attempt, policy scheduler.Policy) (any, error) {
	return a.danJSONRequest(ctx, target, params, attempt, policy)
}

func (a *DanbooruAdapter) ArtistProfile(ctx context.Context, name string, policy scheduler.Policy, mode string) (map[string]any, error) {
	policy = danTargetPolicy(policy)
	tags, fallback := a.danNodeTags(policy)
	target := danBaseURL + "/artists.json"
	outcome, err := a.Transport.Execute(ctx, ExecuteOptions{URL: target, Mode: mode, Policy: policy, Prefix: "dan-artist", Secure: true, NodeTags: tags, FallbackTags: fallback, AcquireErrorFatal: true,
		Operation: func(ctx context.Context, attempt Attempt) (any, error) {
			payload, err := a.danProfileJSON(ctx, target, url.Values{"search[name]": {name}, "limit": {"20"}}, attempt, policy)
			if err != nil {
				return nil, err
			}
			rows, ok := danRows(payload)
			if !ok || len(rows) == 0 {
				return nil, nil
			}
			var exact map[string]any
			for _, raw := range rows {
				row, ok := raw.(map[string]any)
				if ok && discoverydata.TagKey(stringValue(row["name"])) == discoverydata.TagKey(name) {
					exact = row
					break
				}
			}
			if exact == nil {
				return nil, nil
			}
			artistID, ok := integer(exact["id"])
			if !ok {
				return nil, errors.New("Danbooru artist ID 无效")
			}
			payload, err = a.danProfileJSON(ctx, danBaseURL+"/artist_urls.json", url.Values{"search[artist_id]": {strconv.Itoa(artistID)}, "limit": {"100"}}, attempt, policy)
			if err != nil {
				return nil, err
			}
			related := []map[string]any{}
			urlRows, _ := danRows(payload)
			for _, raw := range urlRows {
				row, ok := raw.(map[string]any)
				if !ok || !danTruthy(row["url"]) {
					continue
				}
				classified := discoverydata.ClassifyExternalProfile(stringValue(row["url"]))
				classified["id"] = row["id"]
				active, exists := row["is_active"]
				classified["active"] = !exists || danTruthy(active)
				related = append(related, classified)
			}
			primary := stringValue(exact["name"])
			if primary == "" {
				primary = name
			}
			return map[string]any{"id": strconv.Itoa(artistID), "name": primary, "other_names": danStrings(exact["other_names"]), "group_name": exact["group_name"], "profile_url": fmt.Sprintf("%s/artists/%d", danBaseURL, artistID), "works_url": danBaseURL + "/posts?" + url.Values{"tags": {primary}}.Encode(), "related_profiles": related, "proxy": attempt.Proxy}, nil
		}, Classify: func(err error, attempt Attempt) *Failure {
			return danClassifyFailure(err, attempt)
		},
	})
	if err != nil {
		var exhausted *Exhausted
		if errors.As(err, &exhausted) {
			return nil, &Error{Code: "danbooru_artist_lookup_failed", Message: exhausted.Failure.Message, Details: map[string]any{"attempts": exhausted.Attempts, "proxy": exhausted.Proxy}}
		}
		return nil, err
	}
	if outcome.Value == nil {
		return nil, nil
	}
	return outcome.Value.(map[string]any), nil
}

func (a *DanbooruAdapter) ArtistProfiles(ctx context.Context, names []string, policy scheduler.Policy, mode string, limit int) ([]map[string]any, []map[string]string, error) {
	unique := []string{}
	seen := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			unique = append(unique, name)
		}
	}
	unique = unique[:min(max(0, limit), len(unique))]
	profilesByIndex := make([]map[string]any, len(unique))
	errorsByIndex := make([]error, len(unique))
	var workers sync.WaitGroup
	// Fixed workers bound active requests and preserve order via indexed slots.
	jobs := make(chan int)
	for i := 0; i < min(4, len(unique)); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				profilesByIndex[index], errorsByIndex[index] = a.ArtistProfile(ctx, unique[index], policy, mode)
			}
		}()
	}
	for index := range unique {
		select {
		case jobs <- index:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return nil, nil, ctx.Err()
		}
	}
	close(jobs)
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	profiles := []map[string]any{}
	failures := []map[string]string{}
	for index, name := range unique {
		if err := errorsByIndex[index]; err != nil {
			failures = append(failures, map[string]string{"artist": name, "message": redaction.Text(err.Error(), 1000)})
		} else if profile := profilesByIndex[index]; profile != nil {
			profiles = append(profiles, profile)
		}
	}
	return profiles, failures, nil
}
