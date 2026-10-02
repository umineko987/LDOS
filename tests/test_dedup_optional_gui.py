import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dedup"))
SCRIPT_PATH = ROOT / "dedup" / "dedup_core.py"
SPEC = importlib.util.spec_from_file_location("dedup_optional_gui_core", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)


class OptionalGuiImportTests(unittest.TestCase):
    def test_load_gui_modules_returns_injected_modules_in_order(self):
        names = (
            "PIL.ImageTk",
            "tkinter",
            "tkinter.ttk",
            "tkinter.messagebox",
        )
        modules = {name: object() for name in names}
        calls = []

        def import_module(name):
            calls.append(name)
            return modules[name]

        loaded = DEDUP._load_gui_modules(import_module)

        self.assertEqual(calls, list(names))
        self.assertEqual(loaded, tuple(modules[name] for name in names))

    def test_load_gui_modules_fails_closed_when_any_module_is_missing(self):
        calls = []

        def import_module(name):
            calls.append(name)
            if name == "tkinter.ttk":
                raise ImportError("synthetic missing Tk module")
            return object()

        loaded = DEDUP._load_gui_modules(import_module)

        self.assertEqual(
            calls,
            ["PIL.ImageTk", "tkinter", "tkinter.ttk"],
        )
        self.assertEqual(loaded, (None, None, None, None))


if __name__ == "__main__":
    unittest.main()
