package diagnostics

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func readDatabase(ctx context.Context, path string) bool {
	if !present(path) {
		return true
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return false
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var n int
	return db.QueryRowContext(ctx, "SELECT 1").Scan(&n) == nil
}
func (s *Service) Doctor(ctx context.Context) map[string]any {
	settings := s.settings()
	configOK := false
	if st, err := os.Lstat(settings.Path); err == nil {
		configOK = st.Mode().IsRegular() && st.Mode().Perm()&0077 == 0 && st.Mode().Perm()&0600 == 0600
	}
	database := privateDirectory(filepath.Dir(settings.DatabasePath), "SQLite 目录")
	if database["status"] == "ok" && !readDatabase(ctx, settings.DatabasePath) {
		database = component("error", "SQLite 数据库不可读", true)
	}
	installProxy := os.Getenv("HTTPS_PROXY") != "" || os.Getenv("https_proxy") != "" || os.Getenv("HTTP_PROXY") != "" || os.Getenv("http_proxy") != ""
	install := component("disabled", "未设置安装/下载代理环境变量；它不代表项目抓取代理池状态", false)
	if installProxy {
		install = component("ok", "检测到安装/下载代理环境变量；它不代表项目抓取代理池已配置", false)
	}
	galleryPython := component("error", "gallery-dl Python 执行器依赖不完整", true)
	if executable(settings.Gallery.PythonExecutable) {
		if probe, err := runProbe(ctx, settings.Gallery.PythonExecutable, galleryProbe); err == nil && probe["ready"] == true {
			galleryPython = component("ok", "gallery-dl Python 执行器依赖可用", true)
		}
	}
	modelPermissions := component("disabled", "模型缓存权限检查随去重禁用", false)
	if settings.Dedup.Enabled {
		modelPermissions = privateDirectory(settings.Dedup.ModelDir, "模型缓存目录")
		if modelPermissions["status"] == "ok" {
			modelPermissions = privateFiles("模型与 embedding 缓存", filepath.Join(settings.Dedup.ModelDir, sscdFile), filepath.Join(settings.Dedup.ModelDir, dinoCheckpoint), filepath.Join(settings.Dedup.ModelDir, "embeddings.sqlite3"), filepath.Join(settings.Dedup.ModelDir, "embeddings.sqlite3-wal"), filepath.Join(settings.Dedup.ModelDir, "embeddings.sqlite3-shm"))
		}
	}
	output := component("ok", "默认输出目录位于应用管理 runtime 内", false)
	rel, err := filepath.Rel(settings.RuntimeDir, settings.DefaultOutputRoot)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		output = component("ok", "外部输出目录权限由用户维护，doctor 不会修改", false)
		if st, err := os.Stat(settings.DefaultOutputRoot); err != nil || !st.IsDir() {
			output = component("error", "外部输出目录不可读写", false)
		} else if st.Mode().Perm()&0022 != 0 {
			output = component("optional_warning", "外部输出目录可被组或其他用户写入；doctor 仅报告，不会修改", false)
		}
	}
	items := Snapshot{"linux": check(runtime.GOOS == "linux", "Linux 主机"), "backend_go": component("ok", "Go 业务后端 "+runtime.Version(), true), "gallery_python": galleryPython,
		"gallery_source": check(present(filepath.Join(settings.Gallery.RepoPath, "gallery_dl", "__init__.py")), "gallery-dl 执行器源码"), "config": check(configOK, "正式配置文件及 0600 权限"), "sqlite": database,
		"sqlite_file_permissions": privateFiles("SQLite 主文件与 sidecar", settings.DatabasePath, settings.DatabasePath+"-wal", settings.DatabasePath+"-shm"), "runtime_permissions": privateDirectory(settings.RuntimeDir, "runtime 目录"), "credentials_permissions": privateDirectory(filepath.Dir(settings.Gallery.CacheFile), "credentials/managed 目录"), "model_cache_permissions": modelPermissions, "external_output_permissions": output, "install_proxy": install, "project_proxy": ProjectProxy(settings, nil, nil), "mihomo": Core(settings), "chrome": chrome(settings)}
	for name, item := range s.Models(ctx, true) {
		items[name] = item
	}
	return map[string]any{"ready": ready(items), "components": items, "time": now()}
}
