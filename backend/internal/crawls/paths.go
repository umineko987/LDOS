package crawls

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var pathVariable = regexp.MustCompile(`\$\w+|\$\{[^}]*\}`)

func expandPath(value string) string {
	value = pathVariable.ReplaceAllStringFunc(value, func(token string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(token, "$"), "{"), "}")
		if v, ok := os.LookupEnv(key); ok {
			return v
		}
		return token
	})
	if value == "~" || strings.HasPrefix(value, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(value, "~"))
		}
	}
	return value
}
func resolveMissing(path string) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	value, err := filepath.EvalSymlinks(path)
	if err == nil {
		return value, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if info, e := os.Lstat(path); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", err
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", err
	}
	value, err = resolveMissing(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(value, filepath.Base(path)), nil
}
func within(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// outputDir follows the task output boundary, including symlinks and missing
// leaves. Directory creation is anchored through os.Root, never a bare MkdirAll.
func (s *Service) outputDir(value, id string) (string, error) {
	path := expandPath(value)
	if path == "" {
		path = filepath.Join(s.deps.Settings.DefaultOutputRoot, id)
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(s.deps.Settings.DefaultOutputRoot, path)
	}
	path, err := resolveMissing(path)
	if err != nil {
		return "", errors.New("输出目录路径无效")
	}
	runtime, err := resolveMissing(s.deps.Settings.RuntimeDir)
	if err != nil {
		return "", err
	}
	for _, root := range s.deps.Settings.AllowedOutputRoots {
		root, e := resolveMissing(root)
		if e != nil || !within(path, root) {
			continue
		}
		mode := os.FileMode(0777)
		if within(path, runtime) {
			mode = 0700
		}
		anchor := root
		for {
			info, e := os.Stat(anchor)
			if e == nil {
				if !info.IsDir() {
					return "", errors.New("输出根目录不是目录")
				}
				break
			}
			if !errors.Is(e, os.ErrNotExist) {
				return "", errors.New("无法访问输出根目录")
			}
			parent := filepath.Dir(anchor)
			if parent == anchor {
				return "", e
			}
			anchor = parent
		}
		opened, e := os.OpenRoot(anchor)
		if e != nil {
			return "", errors.New("无法打开输出根目录")
		}
		rel, _ := filepath.Rel(anchor, path)
		e = opened.MkdirAll(rel, mode)
		if e == nil && mode == 0700 {
			e = opened.Chmod(rel, mode)
		}
		opened.Close()
		if e != nil {
			return "", errors.New("无法创建输出目录")
		}
		return path, nil
	}
	return "", errors.New("输出目录超出 allowed_output_roots")
}
