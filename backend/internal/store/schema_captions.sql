CREATE TABLE IF NOT EXISTS caption_batches (
 id TEXT PRIMARY KEY, dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
 source_id TEXT REFERENCES gallery_sources(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 params_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, undone_at REAL,
 undo_stats_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'complete',
 CHECK ((dataset_id IS NULL) != (source_id IS NULL))
);
CREATE TABLE IF NOT EXISTS caption_batch_items (
 batch_id TEXT NOT NULL REFERENCES caption_batches(id) ON DELETE CASCADE, asset_id TEXT NOT NULL, before_text TEXT, before_version TEXT NOT NULL,
 after_text TEXT, after_version TEXT NOT NULL, tagger_tags_json TEXT, write_state TEXT NOT NULL DEFAULT 'written', undo_state TEXT,
 before_bom INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id, asset_id)
);
