package config

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Browser and model settings share one read-modify-rename gate so concurrent
// writes cannot discard unrelated sections. The current document is always read.
var runtimeConfigMu sync.Mutex

func UpdateSection(ctx context.Context, path, section string, values map[string]any) error {
	runtimeConfigMu.Lock()
	defer runtimeConfigMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	failed := errors.New("保存运行配置失败")
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return failed
	}
	defer root.Close()
	name := filepath.Base(path)
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return failed
	}
	f, err := root.Open(name)
	if err != nil {
		return failed
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxBytes+1))
	f.Close()
	if err != nil || len(data) > MaxBytes {
		return failed
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(data, &document) != nil || document == nil {
		return failed
	}
	fields := map[string]json.RawMessage{}
	if raw, ok := document[section]; ok && string(raw) != "null" {
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return failed
		}
	}
	for key, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return failed
		}
		fields[key] = encoded
	}
	document[section], err = json.Marshal(fields)
	if err != nil {
		return failed
	}
	data, err = json.MarshalIndent(document, "", "  ")
	if err != nil || len(data)+1 > MaxBytes {
		return failed
	}
	temp := ".runtime-config-" + rand.Text()
	out, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return failed
	}
	defer root.Remove(temp)
	_, err = out.Write(append(data, '\n'))
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		return failed
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = root.Rename(temp, name); err != nil {
		return failed
	}
	dir, err := root.Open(".")
	if err != nil {
		return failed
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return failed
	}
	return nil
}
