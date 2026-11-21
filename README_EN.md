> **Under development**

# LDOS

**LoRA Dataset Operating System**

[简体中文](README.md)

LDOS is a local LoRA dataset workbench built around [gallery-dl](https://codeberg.org/mikf/gallery-dl). The pipeline runs from collect → clean → dedup → tag → export. Successful exports appear in the library for manual review.

## Features

- **Dataset pipeline**: collect from search or the library, clean with rule-based screening and keyboard triage, deduplicate with perceptual hashes and SSCD/DINO comparisons, tag with local models, and export copies with captions and a trigger word.
- **Library review**: open a source or folder, keep or trash each image and advance, and restore trashed images. Filter by tags, see tag frequencies, edit captions, and preview or undo bulk changes. Reviewing an exported copy does not modify the original dataset.
- **Dataset atlas**: a scatter map of the whole dataset from image embeddings, with clusters, their top tags and outliers; lasso a region to tag it or remove it from the dataset.
- **Library**: browse, search and rename downloaded images, edit their sidecar TXT captions, with a recycle bin; add folders or selected images to a dataset.
- **Jobs**: live progress for acquisition, scan, tagging and export jobs, with a notice when each finishes or fails.
- **Proxies, site authentication and models**: manage proxy sources, connection probes, site credentials and managed browser sessions; download and manage local models.
- **Local desktop workspace**: A mygo + Svelte interface, currently supported on Linux, backed by a local Go service. The backend listens on loopback by default and stores task and gallery state in local SQLite and filesystem data.

## Availability

LDOS currently supports Linux x86_64. A standalone desktop release is not yet available. See the [development guide](docs/development.en.md) to run it from source.

## Configuration and Data

- The configuration file is `gallery-dl-backend/config.json`; override it with `GDL_BACKEND_CONFIG`. Relative paths resolve from the configuration file.
- `GDL_BACKEND_HOST` / `GDL_BACKEND_PORT` override the listening address and port, which use loopback by default.
- Credentials, proxy subscriptions, databases, downloads and local models stay in the configured local directories and are excluded from version control.
- To use the proxy pool, add a subscription and start the pool in Network settings. Login and model downloads share a proxy setting; acquisition uses site policies.
