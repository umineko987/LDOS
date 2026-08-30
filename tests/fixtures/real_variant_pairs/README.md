# Real-variant regression fixture

This directory replaces the former dependency on a developer's
`gallery-dl-backend/runtime/downloads/...` tree.

- The four PNG files are original deterministic drawings produced by
  `generate.py`; no downloaded artwork or user data is included.
- The fixture, generator, manifest, and model-output vectors are copyright
  2026 LDOS contributors and licensed under the repository's
  [MIT License](../../../LICENSE).
- `embeddings.json` contains only numerical outputs for these drawings. The
  SSCD and DINOv2 model weights are **not** redistributed. Their immutable
  source revisions and SHA-256 values are recorded in `manifest.json`.
- The recolored outline pair must classify as `L1-SSCD`. The color/grayscale
  structural pair deliberately has low SSCD similarity and must classify as
  `L2-结构` through DINO, edge, and geometric evidence.

Reproduce the images, compare decoded pixels across platforms, and verify the committed file hashes:

```bash
./.venv/bin/python tests/fixtures/real_variant_pairs/generate.py --check
```

After preparing the pinned public models with the normal CPU setup, verify
that fresh model outputs match the committed vectors:

```bash
./.venv/bin/python tests/fixtures/real_variant_pairs/refresh_embeddings.py \
  --model-dir .models --check
```

Omitting `--check` refreshes `embeddings.json` and `manifest.json`. A model
or fixture download/checksum failure is fatal; neither command silently
skips.
