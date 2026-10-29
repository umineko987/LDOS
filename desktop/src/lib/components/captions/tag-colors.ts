// 标签类别的文字颜色（app.css 的 --tag-*）。画风和画师同色，质量词和元信息同色。
// 类名写全，Tailwind 才扫得到。

import type { TagCategory } from "#lib/domain/captions.ts";
import { m } from "#lib/paraglide/messages.js";

export const TAG_TEXT_CLASS: Readonly<Record<TagCategory, string>> = {
  character: "text-tag-character",
  copyright: "text-tag-copyright",
  artist: "text-tag-artist",
  style: "text-tag-artist",
  general: "text-tag-general",
  meta: "text-tag-meta",
  quality: "text-tag-meta",
  rating: "text-tag-rating",
};

export const TAG_CATEGORY_LABEL: Readonly<Record<TagCategory, () => string>> = {
  character: m.captions_category_character,
  copyright: m.captions_category_copyright,
  artist: m.captions_category_artist,
  style: m.captions_category_style,
  general: m.captions_category_general,
  meta: m.captions_category_meta,
  quality: m.captions_category_quality,
  rating: m.captions_category_rating,
};
