package crawls

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"ldos/backend/internal/activity"
)

func TestBatchProgressPublishesTaskTransitionsAndLiveCounts(t *testing.T) {
	for _, finalStatus := range []string{"succeeded", "failed", "cancelled"} {
		t.Run(finalStatus, func(t *testing.T) {
			s, _, _ := fixture(t)
			ctx := context.Background()
			bus := activity.NewBus(40)
			s.deps.Jobs = activity.NewRegistry(bus)
			batch := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
			id := str(batch["id"])
			_, err := s.deps.Jobs.Start("crawl.batch", "test", activity.StartOptions{ID: "crawl:" + id})
			good(t, err)
			var cursor uint64
			checkEvent := func(current int, message string) {
				t.Helper()
				s.deps.Jobs.Flush()
				events, _ := bus.EventsAfter(cursor)
				var latest *activity.Job
				for _, event := range events {
					cursor = event.Seq
					var payload struct {
						Job activity.Job `json:"job"`
					}
					good(t, json.Unmarshal(event.Data, &payload))
					if payload.Job.ID == "crawl:"+id {
						latest = &payload.Job
					}
				}
				if latest == nil || latest.Current == nil || *latest.Current != current || latest.Total == nil || *latest.Total != 2 || !strings.Contains(latest.Message, message) {
					t.Fatalf("missing download progress current=%d message=%q: %+v", current, message, latest)
				}
			}

			good(t, s.RunOnce(ctx))
			checkEvent(0, "待下载 2")
			rows, err := s.ListTasks(ctx, id, "", 100, 0)
			good(t, err)
			if len(rows) != 2 {
				t.Fatalf("tasks: %d", len(rows))
			}
			first, second := str(rows[0]["id"]), str(rows[1]["id"])
			good(t, s.exec(ctx, "UPDATE tasks SET status='running' WHERE id=?", first))
			good(t, s.RunOnce(ctx))
			checkEvent(0, "下载中 1")

			good(t, s.exec(ctx, "UPDATE tasks SET status='succeeded' WHERE id=?", first))
			good(t, s.RunOnce(ctx))
			checkEvent(1, "成功 1")
			code, partial := request(t, s, "GET", "/api/v1/crawls/"+id+"?view=desktop", "")
			if code != http.StatusOK || str(partial["status"]) != "running" || integer(partial["succeeded_task_count"]) != 1 || integer(batchAddresses(partial)[0]["succeeded_task_count"]) != 1 {
				t.Fatalf("live HTTP counts: %d %+v", code, partial)
			}

			good(t, s.exec(ctx, "UPDATE tasks SET status=? WHERE id=?", finalStatus, second))
			good(t, s.RunOnce(ctx))
			checkEvent(2, "待下载 0")
			code, finished := request(t, s, "GET", "/api/v1/crawls/"+id+"?view=desktop", "")
			want := "completed_with_errors"
			if finalStatus == "succeeded" {
				want = "succeeded"
			}
			if code != http.StatusOK || str(finished["status"]) != want || integer(finished["succeeded_task_count"])+integer(finished["failed_task_count"])+integer(finished["cancelled_task_count"]) != 2 {
				t.Fatalf("final HTTP counts: %d %+v", code, finished)
			}
			code, page := request(t, s, "GET", "/api/v1/crawls/"+id+"/tasks?view=tasks", "")
			items := rowsOf(page["items"])
			if code != http.StatusOK || len(items) != 2 || str(items[0]["status"]) != "succeeded" || str(items[1]["status"]) != finalStatus {
				t.Fatalf("final task rows: %d %+v", code, page)
			}
		})
	}
}
