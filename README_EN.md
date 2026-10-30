# LDOS

**LoRA Dataset Operating System**

[简体中文](README.md)

LDOS is a local LoRA dataset workbench built around [gallery-dl](https://codeberg.org/mikf/gallery-dl). Each dataset moves through a pipeline: collect → clean → dedup → tag → review → export.

## Features

- **Dataset pipeline**: collect (ordered acquisition batches from source search, or images added from the library), clean (rule-based screening plus keyboard triage), dedup (near-duplicates from perceptual hashes and SSCD/DINO models, compared side by side), tag (local tagger models), review, and export (captions and trigger word written to a target folder).
- **Tag studio**: filter by tag queries, add, remove or replace tags in bulk, preview the diff before writing, and undo; keep a blacklist and a tag frequency table.
- **Dataset atlas**: a scatter map of the whole dataset from image embeddings, with clusters, their top tags and outliers; lasso a region to tag it or remove it from the dataset.
- **Library**: browse, search and rename downloaded images, edit their sidecar TXT captions, with a recycle bin; add folders or selected images to a dataset.
- **Jobs**: live progress for acquisition, scan, tagging and export jobs, with a notice when each finishes or fails.
- **Proxies, site authentication and models**: manage proxy sources, connection probes, site credentials and managed browser sessions; download and manage local models.
- **Local desktop workspace**: A Tauri + Svelte interface backed by a local FastAPI service. The backend listens on loopback by default and stores task and gallery state in local SQLite and filesystem data.

## Quick Start

Choose an installation method for the complete instructions:

| Method | Use case | Guide |
|---|---|---|
| Build from source | Reproduce the desktop release build on Linux or Windows | [Build LDOS from Source](docs/source-build.en.md) |
| Install a Release | Install an official Linux or Windows x86_64 package | [Install LDOS from a Release](docs/release-install.en.md) |
