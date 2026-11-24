package crawls

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
)

const enqueueChunkSize = 50

func (s *Service) siteLock(site string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock := s.siteLocks[site]
	if lock == nil {
		lock = make(chan struct{}, 1)
		s.siteLocks[site] = lock
	}
	return lock
}
func (s *Service) plannable(ctx context.Context, batchID string) (bool, error) {
	b, err := s.tickView(ctx, batchID)
	return b != nil && !flag(b["cancel_requested"]) && !terminal(str(b["status"])) && str(b["status"]) != "paused", err
}
func (s *Service) activate(ctx context.Context, batch, address map[string]any) (err error) {
	id := str(address["id"])
	started, err := s.beginPlanning(ctx, id)
	if err != nil || !started {
		return err
	}
	token, err := s.deps.Store.QueryRow(ctx, "SELECT started_at,status FROM crawl_addresses WHERE id=?", id)
	if err != nil {
		return err
	}
	if token == nil || str(token["status"]) != "planning" {
		return nil
	}
	address["started_at"] = token["started_at"]
	linked := []string{}
	defer func() {
		if err == nil {
			return
		}
		cleanup := context.WithoutCancel(ctx)
		if cancelErr := s.cancelTasks(cleanup, linked); cancelErr != nil {
			s.recordError(cancelErr)
		}
		valid, e := s.plannable(cleanup, str(batch["id"]))
		if e != nil {
			s.recordError(e)
			return
		}
		current, e := s.deps.Store.QueryRow(cleanup, "SELECT status,started_at FROM crawl_addresses WHERE id=?", id)
		if e != nil {
			s.recordError(e)
			return
		}
		if current == nil || str(current["status"]) != "planning" || number(current["started_at"]) != number(address["started_at"]) {
			return
		}
		if !valid {
			err = s.suspendPlanning(cleanup, batch, address)
			return
		}
		if ctx.Err() != nil {
			message := "顺序管理器停止，已创建的媒体任务已取消"
			running, e := s.markRunning(cleanup, id, message)
			if e != nil {
				s.recordError(e)
			} else if !running {
				e = s.exec(cleanup, "UPDATE crawl_addresses SET status='pending',updated_at=?,last_error='顺序管理器停止，地址等待重新规划' WHERE id=? AND status='planning'", now(), id)
				if e != nil {
					s.recordError(e)
				}
			}
			s.deps.NotifyTasks()
			return
		}
		if valid {
			message := redaction.Text(err.Error(), 2000)
			running, e := s.markRunning(cleanup, id, message)
			if e == nil && !running {
				e = s.failAddress(cleanup, id, message)
			}
			if e != nil {
				s.recordError(e)
			}
			if !running {
				_, e = s.finishBatch(cleanup, str(batch["id"]))
				if e != nil {
					s.recordError(e)
				}
			}
			s.deps.NotifyTasks()
			err = nil
		}
	}()
	counts, err := s.deps.Store.QueryRow(ctx, `SELECT COUNT(*) AS total,COALESCE(SUM(ca.id=?),0) AS own FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE ca.batch_id=?`, id, batch["id"])
	if err != nil {
		return err
	}
	remaining := integer(batch["max_tasks"]) - integer(counts["total"]) + integer(counts["own"])
	if remaining <= 0 {
		return &Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("批次媒体任务达到 max_tasks=%v", batch["max_tasks"])}
	}
	policy, err := s.deps.PolicyFor(ctx, str(address["site"]))
	if err != nil {
		return err
	}
	lock := s.siteLock(str(address["site"]))
	select {
	case lock <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	var units []Unit
	skipped := 0
	func() {
		defer func() { <-lock }()
		policy, err = s.probePolicy(ctx, address, policy)
		if err != nil {
			return
		}
		var valid bool
		valid, err = s.plannable(ctx, str(batch["id"]))
		if err != nil || !valid {
			return
		}
		units, skipped, err = s.planAddress(ctx, batch, address, policy, remaining)
	}()
	if err != nil {
		return err
	}
	valid, err := s.plannable(ctx, str(batch["id"]))
	if err != nil {
		return err
	}
	if !valid {
		return s.suspendPlanning(ctx, batch, address)
	}
	if err = s.exec(ctx, "UPDATE crawl_addresses SET pre_dedup_skipped_count=?,updated_at=? WHERE id=? AND status='planning'", skipped, now(), id); err != nil {
		return err
	}
	deduplicated := Deduplicate(units)
	if len(deduplicated) == 0 {
		if skipped > 0 {
			finished, e := s.preDeduplicated(ctx, id, skipped)
			if e != nil {
				return e
			}
			if finished {
				_, err = s.finishBatch(ctx, str(batch["id"]))
				s.Notify()
				return err
			}
		}
		return &Error{Code: "empty_crawl_plan", Message: "该地址没有发现可下载图片"}
	}
	if len(deduplicated) > remaining {
		return &Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("该地址媒体数超过批次剩余额度 %d", remaining)}
	}
	for offset := 0; offset < len(deduplicated); offset += enqueueChunkSize {
		valid, err = s.plannable(ctx, str(batch["id"]))
		if err != nil {
			return err
		}
		if !valid {
			return s.suspendPlanning(ctx, batch, address)
		}
		chunk := deduplicated[offset:min(offset+enqueueChunkSize, len(deduplicated))]
		ids, e := s.enqueueChunk(ctx, batch, address, policy, chunk, offset)
		if e != nil {
			return e
		}
		linked = append(linked, ids...)
		if len(ids) != len(chunk) {
			valid, err = s.plannable(ctx, str(batch["id"]))
			if err != nil {
				return err
			}
			if !valid {
				return s.suspendPlanning(ctx, batch, address)
			}
			return errors.New("批量任务入队返回数量不匹配")
		}
	}
	valid, err = s.plannable(ctx, str(batch["id"]))
	if err != nil {
		return err
	}
	if !valid {
		return s.suspendPlanning(ctx, batch, address)
	}
	running, err := s.markRunning(ctx, id, "")
	if err != nil {
		return err
	}
	if !running {
		valid, err = s.plannable(ctx, str(batch["id"]))
		if err != nil {
			return err
		}
		if valid {
			return errors.New("媒体任务已创建，但地址状态切换失败")
		}
	}
	if err = s.releaseHeld(ctx, id); err != nil {
		return err
	}
	s.deps.NotifyTasks()
	return nil
}
func (s *Service) suspendPlanning(ctx context.Context, batch, address map[string]any) error {
	b, err := s.tickView(ctx, str(batch["id"]))
	if err != nil || b == nil {
		return err
	}
	if str(b["status"]) == "paused" {
		return s.exec(ctx, "UPDATE crawl_addresses SET status='pending',updated_at=? WHERE id=? AND status='planning' AND started_at=?", now(), address["id"], address["started_at"])
	}
	if flag(b["cancel_requested"]) {
		rows, err := s.addressTasks(ctx, str(address["id"]))
		if err != nil {
			return err
		}
		ids := []string{}
		for _, r := range rows {
			if !taskTerminal(str(r["status"])) {
				ids = append(ids, str(r["id"]))
			}
		}
		return s.cancelTasks(context.WithoutCancel(ctx), ids)
	}
	return nil
}
func (s *Service) probePolicy(ctx context.Context, address map[string]any, policy scheduler.Policy) (scheduler.Policy, error) {
	// Do not mutate policy slices owned by the policy provider.
	policy.NodeTags = append([]string{}, policy.NodeTags...)
	policy.ExtraArgs = append([]string{}, policy.ExtraArgs...)
	if str(address["proxy_mode"]) == "direct" {
		return policy, nil
	}
	target := text(policy.ProbeURL)
	if target == "" {
		u, err := url.Parse(str(address["url"]))
		if err != nil || u.Hostname() == "" {
			return policy, &Error{Code: "invalid_probe_target", Message: "图站地址缺少可探活的主机名"}
		}
		host := u.Hostname()
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		if port := u.Port(); port != "" && port != "443" {
			host += ":" + port
		}
		target = "https://" + host + "/"
	}
	result, probeErr := s.deps.ProbeForTarget(ctx, target)
	if ctx.Err() != nil {
		return policy, ctx.Err()
	}
	ids := []string{}
	seen := map[string]bool{}
	message := ""
	total := result.Total
	if probeErr != nil {
		message = redaction.Text(probeErr.Error(), 1000)
		total = 0
	} else {
		for _, node := range result.Results {
			if node.Healthy && node.ID != "" && !seen[node.ID] {
				seen[node.ID] = true
				ids = append(ids, node.ID)
			}
		}
	}
	sort.Strings(ids)
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `INSERT INTO crawl_address_proxy_probes(address_id,target_url,total_count,healthy_count,checked_at,last_error) VALUES(?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET target_url=excluded.target_url,total_count=excluded.total_count,healthy_count=excluded.healthy_count,checked_at=excluded.checked_at,last_error=excluded.last_error`, address["id"], target, total, len(ids), now(), message); e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, "DELETE FROM crawl_address_proxy_nodes WHERE address_id=?", address["id"]); e != nil {
			return e
		}
		for _, id := range ids {
			if _, e := tx.ExecContext(ctx, "INSERT INTO crawl_address_proxy_nodes(address_id,node_id) VALUES(?,?)", address["id"], id); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return policy, err
	}
	if str(address["proxy_mode"]) == "required" {
		if probeErr != nil {
			return policy, &Error{Code: "proxy_probe_failed", Message: fmt.Sprintf("%s 代理探活失败: %s", address["site"], message)}
		}
		if len(ids) == 0 {
			return policy, &Error{Code: "proxy_unavailable", Message: fmt.Sprintf("%s 图站探活后没有可用代理节点", address["site"])}
		}
	}
	policy.ProbeURL = &target
	policy.ProxyProbeScope = ptr(str(address["id"]))
	policy.AllowedProxyIDs = ids
	return policy, nil
}
func (s *Service) planAddress(ctx context.Context, batch, address map[string]any, policy scheduler.Policy, maximum int) ([]Unit, int, error) {
	site := str(address["site"])
	mode := str(address["proxy_mode"])
	target := str(address["url"])
	cookies := str(address["cookies_file"])
	if site == "exhentai" {
		var pages []int
		if raw, exists := address["download_options"]; exists {
			options, ok := raw.(map[string]any)
			if !ok {
				return nil, 0, invalid("EH download_options 格式无效")
			}
			if selected, exists := options["eh_pages"]; exists {
				if err := json.Unmarshal([]byte(jsonText(selected)), &pages); err != nil {
					return nil, 0, invalid("eh_pages 必须是页码数组")
				}
				if err := validateEHPages(pages); err != nil {
					return nil, 0, err
				}
				sort.Ints(pages)
			}
		}
		units, _, err := s.planEHPages(ctx, target, policy, mode, cookies, maximum, pages)
		return units, 0, err
	}
	sourceKeys := map[string]bool{}
	if site == "pixiv" || site == "twitter" {
		rows, err := s.deps.Store.QueryRows(ctx, `SELECT DISTINCT ctsk.source_key FROM crawl_task_source_keys ctsk JOIN tasks t ON t.id=ctsk.task_id JOIN crawl_address_tasks cat ON cat.task_id=t.id JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE ca.batch_id=? AND t.site='danbooru' AND t.status='succeeded' AND ctsk.source_key LIKE ?`, batch["id"], site+":%")
		if err != nil {
			return nil, 0, err
		}
		for _, r := range rows {
			sourceKeys[str(r["source_key"])] = true
		}
	}
	exactWork := str(address["address_type"]) == "workbench_work" && (site == "pixiv" || site == "twitter")
	discoveryArgs := stringsOf(address["discovery_args"])
	if exactWork {
		filter, err := discoverydata.ExactWorkPostFilter(site, target)
		if err != nil {
			return nil, 0, invalid(err.Error())
		}
		discoveryArgs = append(discoveryArgs, "--post-filter", filter, "--child-filter", "False")
	}
	result, err := s.deps.Discovery.Discover(ctx, discovery.Request{Site: site, URL: target, Limit: maximum + len(sourceKeys) + 1, Policy: policy, ProxyMode: mode, CredentialsRef: str(address["credentials_ref"]), CookiesFile: cookies, ConfigFile: str(address["config_file"]), ExtraArgs: discoveryArgs, TimeoutSeconds: number(address["timeout_seconds"])})
	if err != nil {
		return nil, 0, err
	}
	candidates := rowsOf(result["candidates"])
	if exactWork {
		candidates, err = exactWorkCandidates(site, target, candidates)
		if err != nil {
			return nil, 0, err
		}
	}
	if len(candidates) == 0 {
		return nil, 0, &Error{Code: "address_empty", Message: fmt.Sprintf("该地址没有发现作品: %s", target)}
	}
	skipped := 0
	kept := make([]map[string]any, 0, len(candidates))
	for _, item := range candidates {
		key := CandidateSourceKey(site, item["id"], candidateURL(item))
		if key != nil && sourceKeys[*key] {
			count, err := mediaCount(item["media_count"])
			if err != nil {
				count = 1
			}
			skipped += count
		} else {
			kept = append(kept, item)
		}
	}
	units, _, err := s.PlanMedia(ctx, kept, policy, mode, cookies, maximum)
	return units, skipped, err
}

func exactWorkCandidates(site, target string, candidates []map[string]any) ([]map[string]any, error) {
	filter, err := discoverydata.ExactWorkPostFilter(site, target)
	if err != nil {
		return nil, invalid(err.Error())
	}
	work := SourceKeyFromURL(target)
	if work == nil || !strings.HasPrefix(*work, site+":") {
		return nil, invalid("所选作品地址必须包含有效的作品 ID")
	}
	id := strings.TrimPrefix(*work, site+":")
	for _, item := range candidates {
		canonical, err := discoverydata.CanonicalWorkAddress(site, str(item["url"]))
		key := SourceKeyFromURL(canonical)
		if err != nil || str(item["site"]) != site || str(item["id"]) != id || key == nil || *key != *work {
			continue
		}
		item["download_url"] = canonical
		if site == "twitter" {
			var media []string
			seen := map[string]bool{}
			for _, source := range stringsOf(item["media_urls"]) {
				if directTwitterMedia(site, source) && !seen[source] {
					media = append(media, source)
					seen[source] = true
				}
			}
			item["media_urls"] = media
			count, err := mediaCount(item["media_count"])
			if err != nil {
				return nil, err
			}
			if len(media) >= count {
				return []map[string]any{item}, nil
			}
		}
		// Apply the work ID to both posts and files, and block queued children.
		item["extra_args"] = []string{"--post-filter", filter, "--filter", filter, "--child-filter", "False"}
		return []map[string]any{item}, nil
	}
	return nil, &Error{Code: "selected_work_not_found", Message: "提取器未返回所选作品: " + target}
}
func (s *Service) preDeduplicated(ctx context.Context, addressID string, skipped int) (bool, error) {
	finished := false
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		a, e := store.QueryRowTx(ctx, tx, "SELECT batch_id FROM crawl_addresses WHERE id=? AND status='planning'", addressID)
		if e != nil || a == nil {
			return e
		}
		b, e := store.QueryRowTx(ctx, tx, "SELECT cancel_requested,status FROM crawl_batches WHERE id=?", a["batch_id"])
		if e != nil || b == nil || flag(b["cancel_requested"]) || str(b["status"]) == "paused" {
			return e
		}
		counts, e := store.QueryRowTx(ctx, tx, `SELECT COUNT(*) AS total,COALESCE(SUM(t.status NOT IN ('succeeded','failed','cancelled')),0) AS active,COALESCE(SUM(t.status='succeeded'),0) AS succeeded,COALESCE(SUM(t.status='failed'),0) AS failed,COALESCE(SUM(t.status='cancelled'),0) AS cancelled FROM crawl_address_tasks cat JOIN tasks t ON t.id=cat.task_id WHERE cat.address_id=?`, addressID)
		if e != nil {
			return e
		}
		if integer(counts["active"]) > 0 {
			_, e = tx.ExecContext(ctx, "UPDATE crawl_addresses SET status='running',updated_at=? WHERE id=?", now(), addressID)
			finished = e == nil
			return e
		}
		status := "succeeded"
		if integer(counts["failed"])+integer(counts["cancelled"]) > 0 {
			status = "failed"
		}
		stamp := now()
		_, e = tx.ExecContext(ctx, "UPDATE crawl_addresses SET status=?,pre_dedup_skipped_count=?,planned_task_count=?,succeeded_task_count=?,failed_task_count=?,cancelled_task_count=?,finished_at=?,updated_at=?,last_error='',planning_error='' WHERE id=?", status, skipped, counts["total"], counts["succeeded"], counts["failed"], counts["cancelled"], stamp, stamp, addressID)
		if e != nil {
			return e
		}
		finished = true
		return refreshCounts(ctx, tx, str(a["batch_id"]))
	})
	return finished, err
}
