from __future__ import annotations

import unittest

from pydantic import ValidationError

from gdl_backend.schemas import FilterConfig, FilterPresetWrite


class FilterNameContractTests(unittest.TestCase):
    def test_preset_and_snapshot_names_match_desktop_validation(self):
        options = dict(basic_dedup=True, filter_monochrome=False, filter_sketch=False,
                       filter_character=False, similarity_groups=True, reference_asset_ids=[])
        for schema, field in ((FilterPresetWrite, "name"), (FilterConfig, "preset_name")):
            for raw, expected in (("  我的预设  ", "我的预设"), ("🎨" * 80, "🎨" * 80)):
                with self.subTest(schema=schema.__name__, name=raw):
                    result = schema.model_validate({field: raw, "options": options})
                    self.assertEqual(getattr(result, field), expected)
            for raw in (" ", "🎨" * 81, "x\n", "\tx", "x\x00y", "x\x7f", 1):
                with self.subTest(schema=schema.__name__, name=raw), self.assertRaises(ValidationError):
                    schema.model_validate({field: raw, "options": options})
