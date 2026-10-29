import type { ModelStatus, ModelUse } from "#lib/domain/models.ts";
import { m } from "#lib/paraglide/messages.js";

export const STATUS_LABELS: Record<ModelStatus, () => string> = {
  installed: m.models_status_installed,
  missing: m.models_status_missing,
  installing: m.models_status_installing,
  failed: m.models_status_failed,
  needs_license: m.models_status_needs_license,
  disabled: m.models_status_disabled,
};

export const USE_LABELS: Record<ModelUse, () => string> = {
  dedup: m.models_use_dedup,
  atlas: m.models_use_atlas,
  clean: m.models_use_clean,
  tag: m.models_use_tag,
};
