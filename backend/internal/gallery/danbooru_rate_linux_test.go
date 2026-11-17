package gallery

import (
	"path/filepath"
	"slices"
	"testing"

	"ldos/backend/internal/danboorurate"
)

func TestEveryWorkerReceivesRuntimeDanbooruRatePath(t *testing.T) {
	runner, request := newTestRunner(t)
	want := filepath.Join(filepath.Dir(runner.settings.CacheFile), danboorurate.FileName)
	t.Setenv(danboorurate.Environment, "/stale/other-runtime.lock")
	for _, resolve := range []bool{false, true} {
		request.resolve = resolve
		process, err := runner.prepare(request, 0)
		if err != nil {
			t.Fatal(err)
		}
		if got := runner.DanbooruRatePath(); got != want {
			t.Fatalf("rate path %q, want %q", got, want)
		}
		if got := process.cmd.Environ(); !slices.Contains(got, danboorurate.Environment+"="+want) {
			t.Fatalf("worker missing runtime rate file: %v", got)
		}
	}
}
