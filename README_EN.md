# LDOS

**LoRA Dataset Operating System**

[简体中文](README.md)

LDOS is a local desktop workspace built around [gallery-dl](https://codeberg.org/mikf/gallery-dl) for image acquisition, batch scheduling, gallery organization, and duplicate review in LoRA dataset workflows.

## Features

- **Ordered image acquisition**: Search sources, select addresses, and create acquisition batches in input order.
- **Batch and task management**: Monitor progress, cancel or retry tasks, and replan acquisition batches.
- **Proxy and site authentication**: Manage proxy sources, connection probes, site credentials, and managed browser sessions.
- **Duplicate review**: Generate duplicate candidates with perceptual hashes and SSCD/DINO models, then review and apply the results.
- **Gallery and dataset export**: Browse, search, and manage downloaded images, then copy complete directories to dataset destinations.
- **Local desktop workspace**: A Tauri + Svelte interface backed by a local FastAPI service. The backend listens on loopback by default and stores task and gallery state in local SQLite and filesystem data.

## Quick Start

Choose an installation method for the complete instructions:

| Method | Use case | Guide |
|---|---|---|
| Build from source | Reproduce the desktop release build on Linux or Windows | [Build LDOS from Source](docs/source-build.en.md) |
| Install a Release | Install an official Linux or Windows x86_64 package | [Install LDOS from a Release](docs/release-install.en.md) |
