package tasks

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var variablePattern = regexp.MustCompile(`\$\w+|\$\{[^}]*\}`)

func expandPath(value string) string {
	value = variablePattern.ReplaceAllStringFunc(value, func(token string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(token, "$"), "{"), "}")
		if value, ok := os.LookupEnv(key); ok {
			return value
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

// resolveMissing follows existing ancestors but permits not-yet-created leaves.
func resolveMissing(value string) (string, error) {
	value, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// A dangling symlink must not be mistaken for an absent leaf.
	if info, statErr := os.Lstat(value); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", err
	}
	parent := filepath.Dir(value)
	if parent == value {
		return "", err
	}
	resolved, err = resolveMissing(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(value)), nil
}

func within(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// ResolveCredentialFile applies the same allowed-root boundary to search and task inputs.
func ResolveCredentialFile(value, base string, roots []string, label string) (string, error) {
	return allowedFile(value, base, roots, label)
}

func allowedFile(value, base string, roots []string, label string) (string, error) {
	if value == "" {
		return "", nil
	}
	path := expandPath(value)
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New(label + "不存在或不是文件")
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	for _, root := range roots {
		root, err := resolveMissing(root)
		if err != nil {
			continue
		}
		if within(resolved, root) {
			info, err := os.Stat(resolved)
			if err == nil && info.Mode().IsRegular() {
				return resolved, nil
			}
		}
	}
	return "", errors.New(label + "超出配置的许可目录或不是文件")
}

func (c Config) outputDir(value, id string) (string, error) {
	path := expandPath(value)
	if path == "" {
		path = filepath.Join(c.OutputRoot, id)
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(c.OutputRoot, path)
	}
	path, err := resolveMissing(path)
	if err != nil {
		return "", errors.New("输出目录路径无效")
	}
	runtime, err := resolveMissing(c.RuntimeDir)
	if err != nil {
		return "", err
	}
	for _, root := range c.AllowedOutputRoots {
		root, err := resolveMissing(root)
		if err != nil || !within(path, root) {
			continue
		}
		mode := os.FileMode(0777)
		if within(path, runtime) {
			mode = 0700
		}
		// Anchor at the nearest existing parent and use os.Root for all creation
		// beneath it, so a replaced descendant cannot escape the selected root.
		anchor := root
		for {
			info, statErr := os.Stat(anchor)
			if statErr == nil {
				if !info.IsDir() {
					return "", errors.New("输出根目录不是目录")
				}
				break
			}
			if !errors.Is(statErr, os.ErrNotExist) {
				return "", errors.New("无法访问输出根目录")
			}
			parent := filepath.Dir(anchor)
			if parent == anchor {
				return "", statErr
			}
			anchor = parent
		}
		opened, err := os.OpenRoot(anchor)
		if err != nil {
			return "", errors.New("无法打开输出根目录")
		}
		rel, _ := filepath.Rel(anchor, path)
		err = opened.MkdirAll(rel, mode)
		if err == nil && mode == 0700 {
			err = opened.Chmod(rel, 0700)
		}
		opened.Close()
		if err != nil {
			return "", errors.New("无法创建输出目录")
		}
		return path, nil
	}
	return "", errors.New("输出目录超出 allowed_output_roots")
}
