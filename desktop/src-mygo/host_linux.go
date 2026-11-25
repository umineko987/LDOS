package main

import (
	"context"
	"errors"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
)

// Host is the only service exposed to the page. Business operations stay on
// Python's existing HTTP/SSE API; lifecycle methods are deliberately unexported.
type Host struct{ backend *backendManager }

func (h *Host) RuntimeMetadata() (RuntimeMetadata, error) { return h.backend.runtimeMetadata() }
func (h *Host) BackendStatus() BackendStatus              { return h.backend.currentStatus() }

func (*Host) SelectDirectory(ctx context.Context) (*string, error) {
	return selectPath(ctx, true)
}

func (*Host) SelectBrowserExecutable(ctx context.Context) (*string, error) {
	return selectPath(ctx, false)
}

func selectPath(ctx context.Context, directory bool) (*string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	title := "选择目录"
	if !directory {
		title = "选择 Chrome、Chromium、Microsoft Edge 或 Firefox"
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: title, Directory: directory})
	if err != nil {
		return nil, errors.New("dialog_path_unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, nil
	}
	if !utf8.ValidString(paths[0]) {
		return nil, errors.New("dialog_path_not_utf8")
	}
	return &paths[0], nil
}

func (*Host) RevealInFileManager(path string) error {
	if path == "" || strings.ContainsRune(path, 0) || !utf8.ValidString(path) {
		return errors.New("invalid_reveal_path")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return errors.New("invalid_reveal_path")
	}
	// mygo v0.9.1's ShowItemInFolder discards platform errors. Use the
	// standard Linux file-manager interface so the Host preserves its error
	// contract, falling back to mygo's error-returning directory opener.
	uri := (&url.URL{Scheme: "file", Path: absolute}).String()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err = exec.CommandContext(ctx, "gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", "["+strconv.Quote(uri)+"]", "").Run()
	if err == nil {
		return nil
	}
	if err := mygo.Shell.OpenPath(filepath.Dir(absolute)); err != nil {
		return errors.New("reveal_failed")
	}
	return nil
}
