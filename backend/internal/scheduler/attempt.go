package scheduler

import (
	"context"
	"errors"
	"math/rand/v2"
	"os"

	"ldos/backend/internal/redaction"
	"ldos/backend/internal/store"
)

type attemptResult struct {
	decision Decision
	code     *int
	lease    *Lease
	tail     string
}

func (s *Scheduler) execute(ctx, lifecycle context.Context, id string) error {
	attempt, err := s.db.BeginAttempt(ctx, id)
	if err != nil {
		return s.finishUnstarted(id, lifecycle.Err() != nil, err)
	}
	attemptID := stringField(attempt, "id")
	task := attempt["task"].(map[string]any)
	policy, policyErr := ParsePolicy(task["policy"])
	artifacts := newArtifacts(stringField(task, "output_dir"))
	logLine := func(stream, line string) error {
		s.logs.push(id, attemptID, stream, line)
		if stream == "stdout" {
			if count, total, write := artifacts.observe(line); write {
				return s.db.UpdateArtifacts(ctx, id, count, total)
			}
		}
		return nil
	}
	result := attemptResult{decision: Decision{"backend_configuration", false, false, "任务策略无效"}}
	if policyErr == nil {
		result, err = s.runAttempt(ctx, id, attemptID, task, policy, logLine)
	}
	// Worker cancellation must not cancel final persistence or lease release.
	finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.settings.ShutdownGrace)
	defer cancel()
	latest, readErr := s.db.GetTask(finalCtx, id)
	if readErr != nil {
		err = errors.Join(err, readErr)
	}
	cancelled := boolField(latest, "cancel_requested")
	if cancelled {
		result.decision = Decision{"cancelled", false, false, "任务已取消"}
	} else if lifecycle.Err() != nil {
		result.decision = Decision{"backend_shutdown", true, false, "后端停止，任务将重新排队"}
	} else if err != nil {
		var configuration ConfigurationError
		if errors.As(err, &configuration) || errors.Is(err, os.ErrNotExist) {
			result.decision = Decision{"backend_configuration", false, false, redaction.Text(err.Error(), 1000)}
		} else {
			result.decision = Decision{"backend_error", true, false, redaction.Text(err.Error(), 1000)}
		}
	}
	result.decision = PartialArtifactFailure(result.decision, artifacts.seen())
	var cleanupErr error
	if result.lease != nil {
		if releaseErr := s.deps.Proxy.Release(finalCtx, id, result.decision.ProxyFault, result.decision.Message); releaseErr != nil {
			s.logs.push(id, attemptID, "backend", "释放代理租约异常："+redaction.Text(releaseErr.Error(), 500))
			cleanupErr = releaseErr
		}
	}
	cleanupErr = errors.Join(cleanupErr, s.db.ClearLease(finalCtx, id, attemptID))
	if result.decision.ErrorClass == "authentication" && s.deps.InvalidateCredentials != nil {
		contextText := result.tail
		if contextText == "" {
			contextText = result.decision.Message
		}
		invalidated, authErr := s.deps.InvalidateCredentials(finalCtx, stringField(task, "site"), stringField(task, "cookies_file"), contextText)
		if authErr != nil {
			s.logs.push(id, attemptID, "backend", "更新托管授权状态失败："+redaction.Text(authErr.Error(), 500))
		} else if invalidated {
			s.logs.push(id, attemptID, "backend", "托管登录凭证已标记失效；后续排队任务等待重新授权。")
		}
	}
	s.logs.flush(finalCtx)
	finish := store.FinishAttemptOptions{Status: AttemptStatus(result.decision), ExitCode: result.code, ErrorClass: result.decision.ErrorClass, ErrorMessage: result.decision.Message, Retryable: result.decision.Retryable}
	if result.lease != nil {
		endpoint := redaction.Text(result.lease.Endpoint, 500)
		finish.ProxyNodeID = &result.lease.NodeID
		finish.ProxyEndpoint = &endpoint
	}
	if finishErr := s.db.FinishAttempt(finalCtx, attemptID, finish); finishErr != nil {
		return errors.Join(cleanupErr, finishErr)
	}
	if artifacts.seen() > 0 {
		count, total := artifacts.totals()
		cleanupErr = errors.Join(cleanupErr, s.db.UpdateArtifacts(finalCtx, id, count, total))
	}
	if readErr != nil {
		return errors.Join(cleanupErr, readErr)
	}
	if latest == nil {
		return cleanupErr
	}
	transition := Transition(result.decision, cancelled, intField(attempt, "attempt_no"), intField(latest, "max_attempts"))
	if transition == "requeue" {
		node := ""
		if result.lease != nil {
			node = result.lease.NodeID
		}
		delay := RetryDelay(policy.BackoffBase, intField(attempt, "attempt_no"), intField(latest, "backoff_anchor_attempt"), s.settings.RetryBackoffCap, rand.Float64()*s.settings.RetryJitter)
		requeued, writeErr := s.db.RequeueTask(finalCtx, id, store.RequeueTaskOptions{NextRunAt: unixNow() + delay, ExitCode: result.code, ErrorClass: result.decision.ErrorClass, ErrorMessage: result.decision.Message, TriedProxyIDs: TriedProxyIDs(stringsField(latest, "tried_proxy_ids"), node, result.decision.ProxyFault), ExpectedAttemptID: attemptID})
		if writeErr != nil {
			return errors.Join(cleanupErr, writeErr)
		}
		if requeued {
			s.Notify()
			return cleanupErr
		}
		// A cancellation may commit after the snapshot but before requeue.
		latest, writeErr = s.db.GetTask(finalCtx, id)
		if writeErr != nil {
			return errors.Join(cleanupErr, writeErr)
		}
		if !boolField(latest, "cancel_requested") {
			return cleanupErr
		}
		transition = "cancelled"
	}
	options := store.CompleteTaskOptions{ExitCode: result.code, ErrorClass: result.decision.ErrorClass, ErrorMessage: result.decision.Message, ExpectedAttemptID: attemptID}
	if transition == "succeeded" {
		options.ErrorClass = ""
		options.ErrorMessage = ""
	}
	if transition == "cancelled" {
		options.ErrorClass = "cancelled"
		options.ErrorMessage = "任务已取消"
	}
	_, err = s.db.CompleteTask(finalCtx, id, transition, options)
	return errors.Join(cleanupErr, err)
}

func (s *Scheduler) runAttempt(ctx context.Context, id, attemptID string, task map[string]any, p Policy, logLine func(string, string) error) (result attemptResult, err error) {
	mode := stringField(task, "proxy_mode")
	if mode != "direct" {
		allowed := p.AllowedProxyIDs
		if allowed == nil && p.ProxyProbeScope != nil {
			allowed, err = s.db.ProbeNodeIDs(ctx, *p.ProxyProbeScope)
			if err != nil {
				return
			}
		}
		result.lease, err = s.deps.Proxy.Acquire(ctx, ProxyRequest{TaskID: id, NodeTags: p.NodeTags, ExcludeIDs: stringsField(task, "tried_proxy_ids"), AllowedIDs: allowed, ProbeBeforeUse: p.ProbeBeforeUse, ProbeURL: p.ProbeURL})
		if errors.Is(err, ErrPoolUnavailable) {
			result.decision = Decision{"proxy_unavailable", false, false, "代理不可用，任务已终止（不会回退直连）"}
			_ = logLine("backend", result.decision.Message)
			return result, nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			if mode == "required" {
				result.decision = Decision{"proxy_unavailable", true, true, "required 模式下代理租约获取失败：" + redaction.Text(err.Error(), 500)}
				_ = logLine("backend", result.decision.Message)
				return result, nil
			}
			_ = logLine("backend", "代理池降级，本次任务使用直连："+redaction.Text(err.Error(), 500))
			err = nil
		}
		if result.lease == nil {
			if mode == "required" {
				result.decision = Decision{"proxy_unavailable", true, false, "当前没有符合站点策略的健康代理节点"}
				_ = logLine("backend", result.decision.Message)
				return result, nil
			}
			_ = logLine("backend", "代理池当前无可租用节点，本次任务使用直连")
		} else {
			lease := result.lease
			endpoint := redaction.Text(lease.Endpoint, 500)
			if err = s.db.SetLease(ctx, id, attemptID, lease.NodeID, endpoint, stringField(task, "site")); err != nil {
				return
			}
			_ = logLine("backend", "已分配代理节点 "+lease.Name+" ("+lease.Protocol+") -> "+endpoint)
		}
	}
	current, err := s.db.GetTask(ctx, id)
	if err != nil {
		return result, err
	}
	if boolField(current, "cancel_requested") {
		result.decision = Decision{"cancelled", false, false, "任务已取消"}
		return result, nil
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	request := RunRequest{URL: stringField(task, "url"), OutputDir: stringField(task, "output_dir"), Site: stringField(task, "site"), CookiesFile: stringField(task, "cookies_file"), ConfigFile: stringField(task, "config_file"), CredentialsRef: stringField(task, "credentials_ref"), Policy: p, ExtraArgs: append(append([]string{}, p.ExtraArgs...), stringsField(task, "extra_args")...), OnLine: logLine}
	if request.Site != "exhentai" {
		request.Policy.StallTimeout = 0
	}
	if result.lease != nil {
		request.ProxyURL = result.lease.Endpoint
	}
	request.OnStarted = func(pid int, marker string) error { return s.db.SetProcess(ctx, id, attemptID, pid, marker) }
	out, err := s.deps.Runner.Run(ctx, id, request)
	result.code = out.ExitCode
	result.tail = out.OutputTail
	result.decision = Classify(out.ExitCode, out.OutputTail, false, out.TimedOut)
	return result, err
}

func (s *Scheduler) finishUnstarted(id string, stopping bool, cause error) error {
	ctx, cancel := context.WithTimeout(context.Background(), s.settings.ShutdownGrace)
	defer cancel()
	task, err := s.db.GetTask(ctx, id)
	if err != nil || task == nil {
		return err
	}
	status := stringField(task, "status")
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		return nil
	}
	if boolField(task, "cancel_requested") {
		_, err = s.db.CompleteTask(ctx, id, "cancelled", store.CompleteTaskOptions{ErrorClass: "cancelled", ErrorMessage: "任务已取消"})
		return err
	}
	if stopping {
		_, err = s.db.RequeueTask(ctx, id, store.RequeueTaskOptions{NextRunAt: unixNow(), ErrorClass: "backend_shutdown", ErrorMessage: "后端停止，任务将重新排队"})
		return err
	}
	_, err = s.db.CompleteTask(ctx, id, "failed", store.CompleteTaskOptions{ErrorClass: "backend_error", ErrorMessage: redaction.Text(cause.Error(), 1000)})
	return err
}
