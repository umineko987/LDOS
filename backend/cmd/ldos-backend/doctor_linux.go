package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"

	"ldos/backend/internal/config"
	"ldos/backend/internal/diagnostics"
)

func runDoctor(settings config.Settings, jsonOutput bool) error {
	service := diagnostics.New(context.Background(), func() config.Settings { return settings })
	defer service.Stop()
	result := service.Doctor(context.Background())
	if jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(result); err != nil {
			return err
		}
	} else {
		fmt.Println("LDOS Linux doctor (Go)")
		items := result["components"].(diagnostics.Snapshot)
		names := make([]string, 0, len(items))
		for name := range items {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			item := items[name]
			fmt.Printf("[%s] %s: %s\n", item["status"], name, item["summary"])
		}
		fmt.Printf("doctor ready: %t\n", result["ready"])
	}
	if result["ready"] != true {
		return errors.New("doctor: required components are not ready")
	}
	return nil
}
