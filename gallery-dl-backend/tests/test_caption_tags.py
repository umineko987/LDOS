"""caption 标签解析/序列化与批量变换的纯函数语义。"""

from __future__ import annotations

import unittest

from gdl_backend.caption_tags import (
    apply_op,
    apply_ops,
    diff_tags,
    format_caption,
    merge_tagger_tags,
    parse_caption,
    pin_trigger,
)


class ParseFormatTests(unittest.TestCase):
    def test_parse_trims_drops_empty_and_dedupes_keeping_first(self) -> None:
        self.assertEqual(
            parse_caption("  1girl,solo ,, long hair\nsolo,\r\n smile , 1girl "),
            ["1girl", "solo", "long hair", "smile"],
        )

    def test_parse_empty_and_none(self) -> None:
        self.assertEqual(parse_caption(None), [])
        self.assertEqual(parse_caption(""), [])
        self.assertEqual(parse_caption(" , \n "), [])

    def test_format_matches_tagger_separator_and_round_trips(self) -> None:
        tags = ["sks", "1girl", "hatsune miku", r"tail \(animal\)"]
        text = format_caption(tags)
        self.assertEqual(text, r"sks, 1girl, hatsune miku, tail \(animal\)")
        self.assertEqual(parse_caption(text), tags)

    def test_tags_compare_exactly(self) -> None:
        self.assertEqual(parse_caption("Smile, smile, long_hair, long hair"),
                         ["Smile", "smile", "long_hair", "long hair"])


class OpTests(unittest.TestCase):
    base = ["sks", "1girl", "hat", "smile", "red eyes"]

    def test_add_back_and_front_skip_existing(self) -> None:
        self.assertEqual(apply_op(self.base, {"op": "add", "tags": ["smile", "outdoors"]}),
                         [*self.base, "outdoors"])
        self.assertEqual(apply_op(self.base, {"op": "add", "tags": ["outdoors"], "position": "front"}),
                         ["outdoors", *self.base])

    def test_remove(self) -> None:
        self.assertEqual(apply_op(self.base, {"op": "remove", "tags": ["hat", "absent"]}),
                         ["sks", "1girl", "smile", "red eyes"])

    def test_replace_in_place_and_collapse_when_target_exists(self) -> None:
        self.assertEqual(apply_op(self.base, {"op": "replace", "from": "hat", "to": "cap"}),
                         ["sks", "1girl", "cap", "smile", "red eyes"])
        self.assertEqual(apply_op(self.base, {"op": "replace", "from": "hat", "to": "smile"}),
                         ["sks", "1girl", "smile", "red eyes"])
        self.assertEqual(apply_op(self.base, {"op": "replace", "from": "absent", "to": "x"}), self.base)

    def test_merge_into_first_position(self) -> None:
        self.assertEqual(
            apply_op(self.base, {"op": "merge", "tags": ["smile", "hat"], "into": "happy"}),
            ["sks", "1girl", "happy", "red eyes"],
        )
        # into 本身已存在：合并后只剩一个，位置取最先出现的那个
        self.assertEqual(
            apply_op(self.base, {"op": "merge", "tags": ["red eyes"], "into": "1girl"}),
            ["sks", "1girl", "hat", "smile"],
        )
        self.assertEqual(apply_op(self.base, {"op": "merge", "tags": ["absent"], "into": "x"}), self.base)

    def test_pin_moves_existing_in_given_order(self) -> None:
        self.assertEqual(apply_op(self.base, {"op": "pin", "tags": ["smile", "absent", "hat"]}),
                         ["smile", "hat", "sks", "1girl", "red eyes"])

    def test_apply_ops_keeps_trigger_first(self) -> None:
        result = apply_ops(self.base, [{"op": "add", "tags": ["solo"], "position": "front"},
                                       {"op": "pin", "tags": ["smile"]}], trigger_word="sks")
        self.assertEqual(result, ["sks", "smile", "solo", "1girl", "hat", "red eyes"])
        # 触发词不在 caption 里时，批量操作不擅自补上
        self.assertEqual(apply_ops(["a"], [{"op": "add", "tags": ["b"]}], trigger_word="sks"), ["a", "b"])

    def test_unknown_op_raises(self) -> None:
        with self.assertRaises(ValueError):
            apply_op(self.base, {"op": "explode", "tags": []})

    def test_input_is_not_mutated(self) -> None:
        tags = list(self.base)
        apply_op(tags, {"op": "remove", "tags": ["hat"]})
        self.assertEqual(tags, self.base)


class MergeTaggerTests(unittest.TestCase):
    def test_overwrite_pins_trigger(self) -> None:
        self.assertEqual(
            merge_tagger_tags(["manual"], ["1girl", "sks", "solo"], previous_tagger_tags=None,
                              mode="overwrite", trigger_word="sks"),
            ["sks", "1girl", "solo"],
        )

    def test_fill_empty_only_touches_empty(self) -> None:
        self.assertEqual(
            merge_tagger_tags(["manual"], ["1girl"], previous_tagger_tags=None, mode="fill_empty"),
            ["manual"],
        )
        self.assertEqual(
            merge_tagger_tags([], ["1girl"], previous_tagger_tags=None, mode="fill_empty", trigger_word="sks"),
            ["sks", "1girl"],
        )

    def test_merge_keeps_manual_additions_and_removals(self) -> None:
        previous = ["1girl", "hat", "smile"]
        # 用户删了 hat，加了 my style
        current = ["sks", "1girl", "my style", "smile"]
        fresh = ["1girl", "hat", "smile", "outdoors"]
        self.assertEqual(
            merge_tagger_tags(current, fresh, previous_tagger_tags=previous, mode="merge", trigger_word="sks"),
            ["sks", "my style", "1girl", "smile", "outdoors"],
        )

    def test_merge_without_history_treats_existing_as_manual(self) -> None:
        self.assertEqual(
            merge_tagger_tags(["hand written", "1girl"], ["1girl", "solo"], previous_tagger_tags=None,
                              mode="merge"),
            ["hand written", "1girl", "solo"],
        )

    def test_merge_drops_stale_tagger_tags(self) -> None:
        # 上次打标给过 hat，这次阈值调高后不再给：不算手改，应当去掉
        self.assertEqual(
            merge_tagger_tags(["1girl", "hat"], ["1girl"], previous_tagger_tags=["1girl", "hat"], mode="merge"),
            ["1girl"],
        )

    def test_unknown_mode(self) -> None:
        with self.assertRaises(ValueError):
            merge_tagger_tags([], [], previous_tagger_tags=None, mode="append")


class HelperTests(unittest.TestCase):
    def test_pin_trigger(self) -> None:
        self.assertEqual(pin_trigger(["a", "sks", "b"], "sks"), ["sks", "a", "b"])
        self.assertEqual(pin_trigger(["a"], " sks "), ["sks", "a"])
        self.assertEqual(pin_trigger(["a", "a"], ""), ["a"])

    def test_diff(self) -> None:
        self.assertEqual(diff_tags(["a", "b", "c"], ["c", "d", "a"]), {"added": ["d"], "removed": ["b"]})


if __name__ == "__main__":
    unittest.main()
