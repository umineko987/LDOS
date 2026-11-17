package modelservice

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Spec struct {
	Key               string             `json:"key"`
	Repo              string             `json:"repo"`
	Revision          string             `json:"revision"`
	Adapter           string             `json:"adapter"`
	Files             []string           `json:"-"`
	DefaultThresholds map[string]float64 `json:"default_thresholds"`
	License           string             `json:"license"`
	Gated             bool               `json:"gated"`
	DisplayName       string             `json:"-"`
}

// Catalog returns the pinned registry from tagger/specs.py, with owned maps.
func Catalog() []Spec {
	wd := func(key, repo, rev, title string) Spec {
		return Spec{Key: key, Repo: repo, Revision: rev, Adapter: "wd_onnx", Files: []string{"model.onnx", "selected_tags.csv"}, DefaultThresholds: map[string]float64{"general": .35, "character": .85, "rating": 0}, License: "open", DisplayName: title}
	}
	return []Spec{
		wd("wd-vit-v3", "SmilingWolf/wd-vit-tagger-v3", "7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f", "WD ViT v3"),
		wd("wd-convnext-v3", "SmilingWolf/wd-convnext-tagger-v3", "d39e46de298d27340111b64965e20b8185c407e6", "WD ConvNeXt v3"),
		wd("wd-swinv2-v3", "SmilingWolf/wd-swinv2-tagger-v3", "627aef95638667ddcaa3ac8ae625e88ea5b02f51", "WD SwinV2 v3"),
		wd("wd-vit-large-v3", "SmilingWolf/wd-vit-large-tagger-v3", "ae469aa2e4706a3af08d3673cf73a11d1add314c", "WD ViT-Large v3"),
		wd("wd-eva02-large-v3", "SmilingWolf/wd-eva02-large-tagger-v3", "b25b82a03f7282e41aa2f257a52c7583b710bd1c", "WD EVA02-Large v3"),
		{Key: "wd-eva02-2026-canary", Repo: "ashen-sensored/wd-eva02-tagger-2026-canary", Revision: "c45a59a3f17c0ca6066072b1c213e0c12a90e242", Adapter: "timm_canary", Files: []string{"model.safetensors", "selected_tags.csv", "config.json"}, DefaultThresholds: map[string]float64{"general": .6094, "character": .85, "rating": 0}, License: "apache-2.0", DisplayName: "WD EVA02 2026 Canary"},
		{Key: "pixai-tagger-v1", Repo: "pixai-labs/pixai-tagger-v1.0", Revision: "9fe10addf9326e292da8a85a98ea74cd91b41771", Adapter: "pixai_hf", Files: []string{"model.safetensors", "config.json", "preprocessor_config.json", "tagger_pipeline.py"}, DefaultThresholds: map[string]float64{"general": .17, "character": .27, "style": .15, "copyright": .24, "meta": .17, "rating": .41}, License: "open", DisplayName: "PixAI Tagger v1.0"},
		{Key: "cl-tagger-v2", Repo: "cella110n/cl_tagger_v2", Revision: "b57909b8e9c63f71e208a26473e7aabdf45ed6b6", Adapter: "cl_onnx", Files: []string{"v2_00/model.onnx", "v2_00/model.onnx.data", "v2_00/model_vocabulary.json"}, DefaultThresholds: map[string]float64{"general": .55, "character": .55, "copyright": .55, "meta": .55, "rating": .55, "quality": .55}, License: "CL Tagger v2 Model License v1.0（下载/执行即视为同意，禁止再分发）", Gated: true, DisplayName: "CL Tagger v2"},
	}
}
func (s *Service) spec(key string) (Spec, bool) {
	for _, v := range s.specs {
		if v.Key == key {
			return v, true
		}
	}
	return Spec{}, false
}
func installed(root string, spec Spec) bool {
	dir := filepath.Join(root, spec.Key)
	if safePath(dir) != nil {
		return false
	}
	data, e := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if e != nil || safePath(filepath.Join(dir, "manifest.json")) != nil {
		return false
	}
	var m struct{ Key, Revision string }
	if json.Unmarshal(data, &m) != nil || m.Key != spec.Key || m.Revision != spec.Revision {
		return false
	}
	for _, f := range spec.Files {
		p := filepath.Join(dir, f)
		if safePath(p) != nil {
			return false
		}
		st, e := os.Stat(p)
		if e != nil || !st.Mode().IsRegular() {
			return false
		}
	}
	return true
}
func (s *Service) ModelCatalog() []Record {
	out := []Record{}
	for _, v := range s.specs {
		thresholds := map[string]float64{}
		for k, x := range v.DefaultThresholds {
			thresholds[k] = x
		}
		out = append(out, Record{"key": v.Key, "repo": v.Repo, "revision": v.Revision, "adapter": v.Adapter, "gated": v.Gated, "license": v.License, "default_thresholds": thresholds, "installed": installed(s.deps.Settings.Tagger.ModelDir, v)})
	}
	return out
}
func (s *Service) InstalledBytes(key string) int64 {
	v, ok := s.spec(key)
	if !ok {
		return 0
	}
	var total int64
	for _, f := range v.Files {
		p := filepath.Join(s.deps.Settings.Tagger.ModelDir, key, f)
		if safePath(p) == nil {
			total += fileSize(p)
		}
	}
	return total
}

const dinoRepository = "facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"

type modelFile struct {
	Path, URL, Hash string
	Size            int64
}

func defaultModelFiles() map[string][]modelFile {
	return map[string][]modelFile{
		"sscd":         {{"sscd_disc_mixup.torchscript.pt", "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt", "9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56", 98791638}},
		"dino":         {{"torch/hub/checkpoints/dinov2_vits14_pretrain.pth", "https://dl.fbaipublicfiles.com/dinov2/dinov2_vits14/dinov2_vits14_pretrain.pth", "b938bf1bc15cd2ec0feacfe3a1bb553fe8ea9ca46a7e1d8d00217f29aef60cd9", 88283115}},
		"completeness": {{"review_filters/completeness_mobilenetv3_v2.2_dist.onnx", "https://huggingface.co/deepghs/anime_completeness/resolve/315b0207c474c7dd0e9f6e282a51ffe00f3f11bd/mobilenetv3_v2.2_dist/model.onnx", "41908bb124475dd853707452743ce4599fb03c4adacbd4188d8e35fd8705256f", 16827558}},
		"ccip":         {{"review_filters/ccip_feat.onnx", "https://huggingface.co/deepghs/ccip_onnx/resolve/eb2acdd29af1703388d3d0c04221add322bc9110/ccip-caformer-24-randaug-pruned/model_feat.onnx", "4ea118d16496274f4f6e08d3afc768cc592389e8f7f32f8732ce2215c228ac5f", 150248245}, {"review_filters/ccip_metric.onnx", "https://huggingface.co/deepghs/ccip_onnx/resolve/eb2acdd29af1703388d3d0c04221add322bc9110/ccip-caformer-24-randaug-pruned/model_metrics.onnx", "7e4646fdfbe369ad485b227ec47ac4092c98b8deef3af44e19fdbd8ba7bc25c1", 1649}},
	}
}
