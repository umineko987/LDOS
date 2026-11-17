package crawls

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

// Preparation uses the existing native task service. Its repository is a staging
// adapter so task creation, source keys and the batch link commit together.
// Notification is deferred until after that commit; workers cannot see an orphan.
type preparedRepository struct {
	service *Service
	policy  scheduler.Policy
}

func (r *preparedRepository) GetTaskByIdempotency(ctx context.Context, key string) (map[string]any, error) {
	row, err := r.service.deps.Store.QueryRow(ctx, "SELECT * FROM tasks WHERE idempotency_key=?", key)
	return projectTask(row), err
}
func (r *preparedRepository) GetSitePolicy(context.Context, string) (map[string]any, error) {
	var policy map[string]any
	_ = json.Unmarshal([]byte(jsonText(r.policy)), &policy)
	return map[string]any{"policy": policy}, nil
}
func (r *preparedRepository) CreateTask(_ context.Context, row map[string]any, _ string) (map[string]any, bool, error) {
	var snapshot map[string]any
	if err := json.Unmarshal([]byte(jsonText(r.policy)), &snapshot); err != nil {
		return nil, false, err
	}
	delete(snapshot, "allowed_proxy_ids")
	row["policy"] = snapshot
	return row, true, nil
}

type deferNotification struct{ tasks.Control }

func (deferNotification) Notify() {}

type preparedTask struct {
	row      map[string]any
	key      string
	sequence int
	unit     Unit
}

func directTwitterMedia(site, target string) bool {
	if site != "twitter" && site != "x" {
		return false
	}
	u, e := url.Parse(target)
	return e == nil && (strings.EqualFold(u.Hostname(), "pbs.twimg.com") || strings.EqualFold(u.Hostname(), "video.twimg.com"))
}
func (s *Service) prepareChunk(ctx context.Context, batch, address map[string]any, policy scheduler.Policy, chunk []HashedUnit, offset int) ([]preparedTask, error) {
	prepared := make([]preparedTask, 0, len(chunk))
	settings := s.deps.Settings
	policy.MaxConcurrency = max(1, min(integer(batch["concurrency"]), settings.Scheduler.MaxConcurrentTasks))
	if options, ok := address["download_options"].(map[string]any); ok && options["eh"] != nil {
		var eh scheduler.EHOptions
		if err := json.Unmarshal([]byte(jsonText(options["eh"])), &eh); err != nil {
			return nil, err
		}
		policy.EHDownload = &eh
	}
	for index, candidate := range chunk {
		unit := candidate.Unit
		site := unit.Site
		if site == "" {
			site = str(address["site"])
		}
		key := fmt.Sprintf("crawl:%s:%s:%s", batch["id"], address["id"], candidate.Digest[:48])
		args := append(stringsOf(address["extra_args"]), unit.ExtraArgs...)
		repo := &preparedRepository{service: s, policy: policy}
		direct := directTwitterMedia(site, unit.URL)
		cookie := optional(str(address["cookies_file"]))
		if direct {
			cookie = nil
		}
		credentialRequest := CredentialsRequest{Reference: optional(str(address["credentials_ref"])), CookiesFile: cookie, ConfigFile: optional(str(address["config_file"]))}
		service, err := tasks.New(repo, tasks.Dependencies{Resolve: s.deps.Resolve, Credentials: func(ctx context.Context, site string) (tasks.Credentials, error) {
			if direct {
				return tasks.Credentials{}, nil
			}
			return s.deps.Credentials(ctx, site, credentialRequest)
		}, ValidateArgs: func(values []string) ([]string, error) {
			return s.deps.ValidateArgs(append(append([]string{}, policy.ExtraArgs...), values...))
		}, ValidateTarget: func(ctx context.Context, target string) error {
			return s.deps.ValidateTarget(ctx, target, str(address["proxy_mode"]), policy)
		}, Control: deferNotification{}}, tasks.Config{RuntimeDir: settings.RuntimeDir, ProjectDir: settings.ProjectDir, OutputRoot: settings.DefaultOutputRoot, AllowedOutputRoots: settings.AllowedOutputRoots, AllowedCookieRoots: settings.AllowedCookieRoots, AllowedConfigRoots: settings.AllowedConfigRoots, AllowPrivateTargets: settings.Server.AllowPrivateTargets, StrictTargetDNS: false, DefaultPolicy: settings.DefaultSitePolicy})
		if err != nil {
			return nil, err
		}
		body := tasks.Create{URL: unit.URL, Site: &site, OutputDir: ptr(str(batch["output_dir"])), ProxyMode: ptr(str(address["proxy_mode"])), MaxAttempts: ptr(integer(address["max_attempts"])), Priority: integer(address["priority"]), CredentialsRef: credentialRequest.Reference, CookiesFile: cookie, ConfigFile: credentialRequest.ConfigFile, EHDownload: policy.EHDownload, ExtraArgs: args}
		row, _, err := service.Enqueue(ctx, body, &key)
		if err != nil {
			return nil, err
		}
		prepared = append(prepared, preparedTask{row, key, offset + index + 1, unit})
	}
	return prepared, nil
}
func (s *Service) enqueueChunk(ctx context.Context, batch, address map[string]any, policy scheduler.Policy, chunk []HashedUnit, offset int) ([]string, error) {
	prepared, err := s.prepareChunk(ctx, batch, address, policy, chunk, offset)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		view, e := store.QueryRowTx(ctx, tx, `SELECT cb.id,cb.status,cb.cancel_requested,cb.max_tasks,ca.status AS address_status,ca.started_at FROM crawl_batches cb JOIN crawl_addresses ca ON ca.batch_id=cb.id WHERE ca.id=?`, address["id"])
		if e != nil {
			return e
		}
		if view == nil || flag(view["cancel_requested"]) || terminal(str(view["status"])) || str(view["status"]) == "paused" || str(view["address_status"]) != "planning" || number(view["started_at"]) != number(address["started_at"]) {
			return nil
		}
		count, e := store.QueryRowTx(ctx, tx, "SELECT COUNT(*) AS n FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE ca.batch_id=?", batch["id"])
		if e != nil {
			return e
		}
		total := integer(count["n"])
		for _, item := range prepared {
			values := item.row
			stamp := now()
			existing, e := store.QueryRowTx(ctx, tx, "SELECT id FROM tasks WHERE idempotency_key=?", item.key)
			if e != nil {
				return e
			}
			var taskID string
			if existing == nil {
				if total >= integer(view["max_tasks"]) {
					return &Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("批次媒体任务达到 max_tasks=%v", view["max_tasks"])}
				}
				taskID = str(values["id"])
				_, e = tx.ExecContext(ctx, `INSERT INTO tasks(id,idempotency_key,url,site,subcategory,extractor,status,priority,output_dir,proxy_mode,max_attempts,attempt_count,next_run_at,created_at,updated_at,cookies_file,config_file,credentials_ref,extra_args_json,policy_json,tried_proxy_ids_json) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,0,?,?,?,?,?,?,?,?,'[]')`, taskID, item.key, values["url"], values["site"], values["subcategory"], values["extractor"], values["priority"], values["output_dir"], values["proxy_mode"], values["max_attempts"], stamp, stamp, stamp, values["cookies_file"], values["config_file"], values["credentials_ref"], jsonText(values["extra_args"]), jsonText(values["policy"]))
				if e != nil {
					return e
				}
				if _, e = tx.ExecContext(ctx, "INSERT INTO task_events(task_id,ts,event_type,payload_json) VALUES(?,?,'queued',?)", taskID, stamp, jsonText(map[string]any{"site": values["site"]})); e != nil {
					return e
				}
			} else {
				taskID = str(existing["id"])
			}
			linked, e := store.QueryRowTx(ctx, tx, "SELECT address_id FROM crawl_address_tasks WHERE task_id=?", taskID)
			if e != nil {
				return e
			}
			if linked == nil {
				if total >= integer(view["max_tasks"]) {
					return tooLarge(total+1, integer(view["max_tasks"]))
				}
				sequence := item.sequence
				occupied, e := store.QueryRowTx(ctx, tx, "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND sequence_no=?", address["id"], sequence)
				if e != nil {
					return e
				}
				if occupied != nil {
					last, e := store.QueryRowTx(ctx, tx, "SELECT COALESCE(MAX(sequence_no),0)+1 AS n FROM crawl_address_tasks WHERE address_id=?", address["id"])
					if e != nil {
						return e
					}
					sequence = integer(last["n"])
				}
				if _, e = tx.ExecContext(ctx, "INSERT INTO crawl_address_tasks(address_id,task_id,sequence_no,created_at) VALUES(?,?,?,?)", address["id"], taskID, sequence, stamp); e != nil {
					return e
				}
				total++
			} else if str(linked["address_id"]) != str(address["id"]) {
				return errorsNewLink(taskID)
			}
			if item.unit.SourceKey != nil {
				if _, e = tx.ExecContext(ctx, "INSERT INTO crawl_task_source_keys(task_id,source_key,source_url,created_at) VALUES(?,?,?,?) ON CONFLICT(task_id,source_key) DO NOTHING", taskID, *item.unit.SourceKey, text(item.unit.SourceURL), stamp); e != nil {
					return e
				}
			}
			ids = append(ids, taskID)
		}
		if _, e = tx.ExecContext(ctx, "UPDATE crawl_addresses SET planned_task_count=(SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?),updated_at=? WHERE id=?", address["id"], now(), address["id"]); e != nil {
			return e
		}
		return refreshCounts(ctx, tx, str(batch["id"]))
	})
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		s.deps.NotifyTasks()
	}
	return ids, nil
}
func errorsNewLink(id string) error {
	return fmt.Errorf("爬取媒体任务已经属于其他地址: %s", id)
}
