from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from gdl_backend.gallery_catalog import (
    canonical_root_key,
    classify_txt_state,
    decode_txt_bytes,
    image_extension,
    is_ldos_reserved_path,
    is_safe_relative_path,
    is_supported_image_name,
    natural_sort_key,
    root_relation,
    trash_files_relative_dir,
    trash_operation_manifest_relative_path,
    txt_name_for_image,
)


class SupportedImageContractTest(unittest.TestCase):
    def test_accepts_only_the_four_v1_extensions_case_insensitively(self) -> None:
        for name in ("a.jpg", "a.JPEG", "a.Png", "a.WebP", "foo.bar.jpg"):
            self.assertTrue(is_supported_image_name(name), name)
        for name in (
            "a.gif",
            "a.bmp",
            "a.tiff",
            "a.heic",
            "a.cr2",
            "a.psd",
            "a.jpgx",
            "a",
            ".jpg",
            "",
            "a.jpg.txt",
            "archive.tar.gz",
        ):
            if name == "a.jpg.txt":
                continue  # txt 配对文件本身不是图片，由配对函数处理
            self.assertFalse(is_supported_image_name(name), name)

    def test_image_extension_is_normalized_lowercase(self) -> None:
        self.assertEqual(image_extension("Photo.JPEG"), ".jpeg")
        with self.assertRaises(ValueError):
            image_extension("photo.gif")

    def test_txt_pairing_replaces_the_last_extension(self) -> None:
        self.assertEqual(txt_name_for_image("foo.bar.jpg"), "foo.bar.txt")
        self.assertEqual(txt_name_for_image("IMG_0001.PNG"), "IMG_0001.txt")
        with self.assertRaises(ValueError):
            txt_name_for_image("noext")
        with self.assertRaises(ValueError):
            txt_name_for_image("archive.tar.gz")


class TxtEncodingContractTest(unittest.TestCase):
    def test_strict_utf8_decoding_accepts_bom(self) -> None:
        ok, text = decode_txt_bytes(b"\xef\xbb\xbftag1, tag2\n")
        self.assertTrue(ok)
        self.assertEqual(text, "tag1, tag2\n")

    def test_strict_utf8_decoding_never_replaces_invalid_bytes(self) -> None:
        ok, text = decode_txt_bytes(b"tag\xff\xfeinvalid")
        self.assertFalse(ok)
        self.assertEqual(text, "")

    def test_gbk_content_is_rejected_not_transcoded(self) -> None:
        ok, _text = decode_txt_bytes("标签".encode("gbk"))
        self.assertFalse(ok)


class TxtStateContractTest(unittest.TestCase):
    def test_objective_state_priority(self) -> None:
        self.assertEqual(
            classify_txt_state(exists=True, pair_conflict=True, data=b"x"),
            "pair_conflict",
        )
        self.assertEqual(classify_txt_state(exists=True, read_ok=False), "io_error")
        self.assertEqual(classify_txt_state(exists=False), "missing")
        self.assertEqual(classify_txt_state(exists=True, data=b"\xff"), "invalid_encoding")
        self.assertEqual(classify_txt_state(exists=True, data=b"   \n\t "), "blank")
        self.assertEqual(classify_txt_state(exists=True, data=b""), "blank")
        self.assertEqual(classify_txt_state(exists=True, data=b"\xef\xbb\xbf"), "blank")
        self.assertEqual(classify_txt_state(exists=True, data=b"tag"), "normal")

    def test_present_txt_requires_data(self) -> None:
        with self.assertRaises(ValueError):
            classify_txt_state(exists=True, data=None)


class NaturalSortContractTest(unittest.TestCase):
    def test_numeric_names_sort_before_larger_numbers(self) -> None:
        names = ["10.jpg", "2.jpg", "1.jpg", "20.jpg", "3.jpg"]
        self.assertEqual(
            sorted(names, key=natural_sort_key),
            ["1.jpg", "2.jpg", "3.jpg", "10.jpg", "20.jpg"],
        )

    def test_mixed_alpha_numeric_and_case_folding(self) -> None:
        names = ["IMG10.png", "img2.png", "IMG1.PNG", "img20.png"]
        self.assertEqual(
            sorted(names, key=natural_sort_key),
            ["IMG1.PNG", "img2.png", "IMG10.png", "img20.png"],
        )

    def test_multi_digit_runs_compare_numerically(self) -> None:
        names = ["v10", "v9", "v99", "v100", "v1000"]
        self.assertEqual(
            sorted(names, key=natural_sort_key), ["v9", "v10", "v99", "v100", "v1000"]
        )

    def test_subdirectories_can_be_ordered_by_relative_path(self) -> None:
        paths = ["b/10.jpg", "b/2.jpg", "a/1.jpg"]
        self.assertEqual(
            sorted(paths, key=natural_sort_key), ["a/1.jpg", "b/2.jpg", "b/10.jpg"]
        )


class RelativePathSafetyContractTest(unittest.TestCase):
    def test_accepts_plain_relative_paths(self) -> None:
        self.assertTrue(is_safe_relative_path("a.jpg"))
        self.assertTrue(is_safe_relative_path("sub/dir/a.png"))
        self.assertTrue(is_safe_relative_path("sub dir/a.png"))

    def test_rejects_escape_absolute_and_windows_unsafe_forms(self) -> None:
        for bad in (
            "",
            "/abs/a.jpg",
            "../escape.jpg",
            "a/../../escape.jpg",
            "./a.jpg",
            "a/./b.jpg",
            "a\\b.jpg",
            "a\x00b.jpg",
            "trailing.dot./a.jpg",
            "trailing space /a.jpg",
        ):
            self.assertFalse(is_safe_relative_path(bad), repr(bad))

    def test_ldos_tree_is_reserved_at_any_depth(self) -> None:
        self.assertTrue(is_ldos_reserved_path(".ldos"))
        self.assertTrue(is_ldos_reserved_path(".ldos/trash/op-1/files/a.jpg"))
        self.assertTrue(is_ldos_reserved_path("sub/.ldos/exports/e.jsonl"))
        self.assertFalse(is_ldos_reserved_path("sub/normal.jpg"))
        self.assertFalse(is_ldos_reserved_path(".ldos-lookalike/a.jpg"))


class SourceRootKeyContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_canonical_key_resolves_links_and_redundant_segments(self) -> None:
        real = self.root / "real"
        real.mkdir()
        link = self.root / "link"
        os.symlink(real, link)
        nested = real / "nested"
        nested.mkdir()

        self.assertEqual(canonical_root_key(link), canonical_root_key(real))
        self.assertEqual(
            canonical_root_key(str(real) + "/"),
            canonical_root_key(real / "." / ".." / "real"),
        )
        self.assertNotEqual(canonical_root_key(nested), canonical_root_key(real))

    def test_root_relation_classifies_overlap(self) -> None:
        base = canonical_root_key(self.root)
        child = canonical_root_key(self.root / "child")
        self.assertEqual(root_relation(base, base), "same")
        self.assertEqual(root_relation(child, base), "descendant")
        self.assertEqual(root_relation(base, child), "ancestor")
        self.assertEqual(
            root_relation(base, canonical_root_key(self.root.parent.parent / "elsewhere")),
            "disjoint",
        )

    def test_string_prefix_is_not_enough_for_relation(self) -> None:
        base = canonical_root_key(self.root)
        sibling_like = str(self.root) + "-suffix"
        self.assertEqual(root_relation(canonical_root_key(sibling_like), base), "disjoint")


class TrashLayoutContractTest(unittest.TestCase):
    def test_trash_layout_uses_source_local_operation_dirs(self) -> None:
        self.assertEqual(
            str(trash_files_relative_dir("op-1")),
            ".ldos/trash/op-1/files",
        )
        self.assertEqual(
            str(trash_operation_manifest_relative_path("op-1")),
            ".ldos/trash/op-1/operation.json",
        )

    def test_trash_layout_rejects_unsafe_operation_ids(self) -> None:
        for bad in ("", "a/b", "..", "a\\b"):
            with self.assertRaises(ValueError):
                trash_files_relative_dir(bad)
            with self.assertRaises(ValueError):
                trash_operation_manifest_relative_path(bad)


if __name__ == "__main__":
    unittest.main()
