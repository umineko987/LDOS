package tasks

import (
	"testing"

	"ldos/backend/internal/scheduler"
)

func TestDecodeCreateRejectsInvalidBoundaryInputs(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"missing url", `{}`},
		{"null object", `null`},
		{"array body", `[]`},
		{"null url", `{"url":null}`},
		{"null priority", `{"url":"https://gallery.example/item","priority":null}`},
		{"null args", `{"url":"https://gallery.example/item","extra_args":null}`},
		{"null argument", `{"url":"https://gallery.example/item","extra_args":[null]}`},
		{"non string argument", `{"url":"https://gallery.example/item","extra_args":[123]}`},
		{"unknown field", `{"url":"https://gallery.example/item","unexpected":true}`},
		{"private policy override", `{"url":"https://gallery.example/item","_policy_override":{}}`},
		{"private credentials override", `{"url":"https://gallery.example/item","_skip_managed_credentials":true}`},
		{"unknown EH field", `{"url":"https://gallery.example/item","eh_download":{"unknown":true}}`},
		{"null image mode", `{"url":"https://gallery.example/item","eh_download":{"image_mode":null}}`},
		{"null GP policy", `{"url":"https://gallery.example/item","eh_download":{"gp_policy":null}}`},
		{"non object EH", `{"url":"https://gallery.example/item","eh_download":[]}`},
		{"invalid image mode", `{"url":"https://gallery.example/item","eh_download":{"image_mode":"thumbnail"}}`},
		{"invalid GP policy", `{"url":"https://gallery.example/item","eh_download":{"gp_policy":"continue"}}`},
		{"wrong priority type", `{"url":"https://gallery.example/item","priority":"1"}`},
		{"trailing object", `{"url":"https://gallery.example/item"}{}`},
		{"invalid UTF8", "{\"url\":\"https://gallery.example/\xff\"}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeCreate([]byte(tc.body)); err == nil {
				t.Fatalf("DecodeCreate(%q) unexpectedly succeeded", tc.body)
			}
		})
	}
}

func TestDecodeCreateOmittedAndNullableFields(t *testing.T) {
	for _, body := range []string{
		`{"url":" https://gallery.example/item "}`,
		`{"url":" https://gallery.example/item ","site":null,"output_dir":null,"proxy_mode":null,"max_attempts":null,"credentials_ref":null,"cookies_file":null,"config_file":null,"eh_download":null}`,
	} {
		got, err := DecodeCreate([]byte(body))
		if err != nil {
			t.Fatalf("DecodeCreate(%s): %v", body, err)
		}
		if got.URL != "https://gallery.example/item" || got.Priority != 0 || got.ExtraArgs == nil || len(got.ExtraArgs) != 0 {
			t.Fatalf("wrong normalized defaults: %+v", got)
		}
		if got.Site != nil || got.OutputDir != nil || got.ProxyMode != nil || got.MaxAttempts != nil || got.CredentialsRef != nil || got.CookiesFile != nil || got.ConfigFile != nil || got.EHDownload != nil {
			t.Fatalf("nullable fields must remain absent: %+v", got)
		}
	}
}

func TestDecodeCreateEHDefaults(t *testing.T) {
	for _, tc := range []struct {
		name    string
		options string
		want    scheduler.EHOptions
	}{
		{"empty", `{}`, scheduler.EHOptions{ImageMode: "original", GPPolicy: "stop"}},
		{"image override", `{"image_mode":"resample"}`, scheduler.EHOptions{ImageMode: "resample", GPPolicy: "stop"}},
		{"GP override", `{"gp_policy":"resized"}`, scheduler.EHOptions{ImageMode: "original", GPPolicy: "resized"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DecodeCreate([]byte(`{"url":"exhentai:r:https://gallery.example/item","eh_download":` + tc.options + `}`))
			if err != nil {
				t.Fatal(err)
			}
			if got.EHDownload == nil || *got.EHDownload != tc.want {
				t.Fatalf("EH options = %+v, want %+v", got.EHDownload, tc.want)
			}
		})
	}
}
