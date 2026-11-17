package crawls

import (
	"context"
	"fmt"

	"ldos/backend/internal/activity"
)

// Publish changes while a batch is downloading, not only its start and finish.
// The registry coalesces unchanged samples and throttles progress events.
func (s *Service) publishProgress(ctx context.Context, id string) error {
	if s.deps.Jobs == nil {
		return nil
	}
	counts, err := s.deps.Store.QueryRow(ctx, `SELECT COUNT(*) AS total,
		COALESCE(SUM(t.status IN ('starting','running','cancelling')),0) AS running,
		COALESCE(SUM(t.status='succeeded'),0) AS succeeded,
		COALESCE(SUM(t.status='failed'),0) AS failed,
		COALESCE(SUM(t.status='cancelled'),0) AS cancelled
		FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id
		JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=?`, id)
	if err != nil {
		return err
	}
	total, running := integer(counts["total"]), integer(counts["running"])
	succeeded, failed, cancelled := integer(counts["succeeded"]), integer(counts["failed"]), integer(counts["cancelled"])
	finished := succeeded + failed + cancelled
	message := fmt.Sprintf("待下载 %d · 下载中 %d · 成功 %d · 失败 %d · 已取消 %d", total-finished-running, running, succeeded, failed, cancelled)
	_, err = s.deps.Jobs.Update("crawl:"+id, activity.UpdateOptions{Current: &finished, Total: &total, Message: &message})
	return err
}
