package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/atlas"
	"ldos/backend/internal/captions"
	"ldos/backend/internal/config"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/datasetstages"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/modelservice"
	"ldos/backend/internal/reviews"
)

type pipelineRuntime struct {
	models   *modelservice.Service
	captions *captions.Service
	stages   *datasetstages.Service
	atlas    *atlas.Service
}

func (b *businessRuntime) modelSettings() config.Settings { return b.pipeline.models.Settings() }
func (b *businessRuntime) newPipeline(jobs *activity.Registry, events *activity.Bus, downloadSettings *downloads.Store) error {
	p := &pipelineRuntime{}
	b.pipeline = p
	settings := b.settings.snapshot()
	var err error
	publish := func(topic string, payload map[string]any) { _, _ = events.Publish(topic, payload) }
	stageInput := func(ctx context.Context, id, stage string) ([]map[string]any, error) {
		rows, err := b.datasets.StageInput(ctx, id, stage)
		return rows, pipelinePeerError(err)
	}
	p.models, err = modelservice.New(b.ctx, modelservice.Dependencies{Store: b.db, Settings: settings, Jobs: jobs, Downloads: downloadSettings, OnDedupEnabled: func(ctx context.Context) error {
		models := p.models.Settings()
		b.settings.mu.Lock()
		b.settings.value.Dedup = models.Dedup
		b.settings.mu.Unlock()
		if err := p.atlas.Enable(); err != nil {
			return err
		}
		return b.enableDedup()
	}})
	if err != nil {
		return err
	}
	p.captions, err = captions.New(b.ctx, captions.Dependencies{Store: b.db, Settings: settings, Jobs: jobs,
		GetDataset: func(ctx context.Context, id string) (map[string]any, error) {
			row, err := b.datasets.Get(ctx, id)
			return row, pipelinePeerError(err)
		},
		StageInput: stageInput, ReadAnnotations: b.readAnnotations, WriteAnnotation: b.writeAnnotation, WithSources: b.gallery.WithSources,
		Publish: publish, DatasetUpdated: b.datasets.PublishUpdated,
	})
	if err != nil {
		return err
	}
	p.stages, err = datasetstages.New(b.ctx, datasetstages.Dependencies{Store: b.db, Settings: settings, Jobs: jobs, StageInput: stageInput,
		DedupEnabled: func() bool { return b.modelSettings().Dedup.Enabled },
		StageInputDigest: func(ctx context.Context, id, stage string) (string, error) {
			digest, err := b.datasets.StageInputDigest(ctx, id, stage)
			return digest, pipelinePeerError(err)
		},
		ApplyCaptions: p.captions.ApplyTagger, Publish: publish, DatasetUpdated: b.datasets.PublishUpdated,
		Reviews: datasetstages.ReviewCallbacks{
			Create: func(ctx context.Context, ids []string, options map[string]any) (map[string]any, error) {
				raw, err := json.Marshal(options)
				if err != nil {
					return nil, err
				}
				var cfg reviews.FilterConfig
				if err = json.Unmarshal(raw, &cfg); err != nil {
					return nil, pipelinePeerError(err)
				}
				row, err := b.reviews.CreateDataset(ctx, ids, &cfg)
				return row, pipelinePeerError(err)
			},
			Adopt: func(ctx context.Context, id, group string, keep []string, version int64, automatic bool) (map[string]any, error) {
				row, err := b.reviews.AdoptGroup(ctx, id, group, keep, version, automatic)
				return row, pipelinePeerError(err)
			},
			Finish: func(ctx context.Context, id string) error { return pipelinePeerError(b.reviews.FinishGallery(ctx, id)) },
			Presets: func(ctx context.Context) ([]map[string]any, error) {
				presets, err := b.reviews.ListPresets(ctx)
				if err != nil {
					return nil, pipelinePeerError(err)
				}
				raw, err := json.Marshal(presets)
				if err != nil {
					return nil, err
				}
				var rows []map[string]any
				err = json.Unmarshal(raw, &rows)
				return rows, err
			},
		},
		Tagger: datasetstages.TaggerCallbacks{
			Catalog: func(ctx context.Context) ([]map[string]any, error) {
				if !p.models.Settings().Tagger.Enabled {
					return nil, &captions.Error{Status: 409, Code: "tagger_disabled", Message: "打标功能未启用"}
				}
				return p.models.ModelCatalog(), ctx.Err()
			},
			Query: func(ctx context.Context, command string, models, inputs, extra []string) ([]map[string]any, error) {
				rows, err := p.models.Query(ctx, command, models, inputs, extra)
				return rows, pipelinePeerError(err)
			},
			Tag: func(ctx context.Context, models, inputs []string, batchSize int, ref map[string]any, finished func(map[string]any)) (string, error) {
				jobRef := map[string]string{}
				for key, value := range ref {
					jobRef[key] = captions.Text(value)
				}
				row, err := p.models.Tag(ctx, modelservice.TagRequest{Models: models, Inputs: inputs, BatchSize: batchSize, JobRef: jobRef, OnFinished: func(ctx context.Context, result map[string]any) error { finished(result); return nil }})
				if err != nil {
					return "", pipelinePeerError(err)
				}
				return valueString(row["job_id"]), nil
			},
			Cancel: func(ctx context.Context, id string) error {
				if p.models.CurrentJobID() != id {
					return nil
				}
				_, err := p.models.Cancel(ctx)
				return pipelinePeerError(err)
			},
			CacheGeneration: p.models.CacheGeneration, CurrentJobID: p.models.CurrentJobID,
		},
	})
	if err != nil {
		return err
	}
	b.reviews.AddListener(p.stages.OnReviewChanged)
	b.reviews.SetActivityDescription(p.stages.DescribeReview)
	p.atlas, err = atlas.New(b.ctx, atlas.Dependencies{Store: b.db, Settings: settings, Jobs: jobs, Events: events, PythonExecutable: func() string { return p.models.Settings().Dedup.PythonExecutable },
		Datasets: atlas.DatasetCallbacks{
			StageInput: func(ctx context.Context, id, stage string) ([]map[string]any, error) {
				return b.datasets.StageInput(ctx, id, stage)
			}, HashAsset: b.datasets.HashAsset, SetAside: b.datasets.SetAside, PutBack: b.datasets.PutBack,
		},
		Gallery: atlas.GalleryCallbacks{OpenImage: datasetImages{b.gallery}.OpenImage,
			Thumbnail: func(asset string, modified int64, size int) (string, error) {
				_, etag, err := b.gallery.Thumbnail(b.ctx, asset, size)
				if err != nil {
					return "", err
				}
				return filepath.Join(settings.RuntimeDir, "gallery-thumbnails", strings.Trim(etag, "\"")+".jpg"), nil
			},
			Captions: func(ctx context.Context, ids []string) (map[string]string, error) {
				rows, err := b.readAnnotations(ctx, ids)
				if err != nil {
					return nil, err
				}
				result := map[string]string{}
				for id, row := range rows {
					if row.Content != nil {
						result[id] = *row.Content
					}
				}
				return result, nil
			},
		},
	})
	return err
}
func (p *pipelineRuntime) start() error {
	if err := p.models.Start(); err != nil {
		return err
	}
	if err := p.atlas.Start(); err != nil {
		return err
	}
	return p.stages.Start()
}
func (p *pipelineRuntime) stop() error {
	var result error
	if p.stages != nil {
		result = errors.Join(result, p.stages.Stop())
	}
	if p.atlas != nil {
		result = errors.Join(result, p.atlas.Stop())
	}
	if p.models != nil {
		result = errors.Join(result, p.models.Stop())
	}
	if p.captions != nil {
		result = errors.Join(result, p.captions.Stop())
	}
	return result
}
func (p *pipelineRuntime) register(mux *http.ServeMux) {
	p.models.Register(mux)
	p.captions.Register(mux)
	p.stages.Register(mux)
	p.atlas.Register(mux)
}
func (b *businessRuntime) checkFilters(ctx context.Context, names []string) (map[string]reviews.Capability, error) {
	checks, err := b.pipeline.models.CheckFilters(ctx, names)
	if err != nil {
		return nil, err
	}
	result := map[string]reviews.Capability{}
	for name, check := range checks {
		result[name] = reviews.Capability{Available: check.Available, Reason: check.Reason}
	}
	return result, nil
}
func annotationSnapshot(row map[string]any) captions.Annotation {
	a := captions.Annotation{AssetID: valueString(row["asset_id"]), State: valueString(row["txt_state"]), DiskVersion: valueString(row["disk_version"]), TXTVersion: captions.Number(row["txt_version"]), Error: valueString(row["error"])}
	if text, ok := row["content"].(string); ok {
		a.Content = &text
	}
	a.BOM, _ = row["bom"].(bool)
	return a
}
func (b *businessRuntime) readAnnotations(ctx context.Context, ids []string) (map[string]captions.Annotation, error) {
	result := map[string]captions.Annotation{}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		row, err := b.gallery.GetAnnotationSnapshot(ctx, id)
		if err != nil {
			code := "annotation_unavailable"
			var e *gallerycatalog.Error
			if errors.As(err, &e) {
				code = e.Code
			}
			result[id] = captions.Annotation{AssetID: id, Error: code}
			continue
		}
		result[id] = annotationSnapshot(row)
	}
	return result, nil
}
func (b *businessRuntime) writeAnnotation(ctx context.Context, id string, content *string, version captions.AnnotationWrite) (captions.Annotation, error) {
	var text *string
	if content != nil {
		v := *content
		if version.BOM && !strings.HasPrefix(v, "\ufeff") {
			v = "\ufeff" + v
		}
		text = &v
	}
	row, err := b.gallery.WriteAnnotation(ctx, id, text, gallerycatalog.AnnotationWrite{ExpectedTxtVersion: version.TXTVersion, ExpectedDiskVersion: version.DiskVersion})
	if err != nil {
		return captions.Annotation{}, pipelinePeerError(err)
	}
	row["bom"] = text != nil && strings.HasPrefix(*text, "\ufeff")
	return annotationSnapshot(row), nil
}
func pipelinePeerError(err error) error {
	if err == nil {
		return nil
	}
	var d *datasets.Error
	if errors.As(err, &d) {
		return &captions.Error{Status: d.Status, Code: d.Code, Message: d.Message, Details: d.Details}
	}
	var g *gallerycatalog.Error
	if errors.As(err, &g) {
		return &captions.Error{Status: g.Status, Code: g.Code, Message: g.Code, Details: g.Details}
	}
	var r *reviews.Error
	if errors.As(err, &r) {
		return &captions.Error{Status: r.Status, Code: r.Code, Message: r.Message, Details: r.Details}
	}
	var m *modelservice.Error
	if errors.As(err, &m) {
		return &captions.Error{Status: m.Status, Code: m.Code, Message: m.Message}
	}
	return err
}
