"""Check publication rules without relying on developer-local Git excludes."""

from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RepositoryHygieneTests(unittest.TestCase):
    def test_local_material_is_ignored_and_project_inputs_remain_publishable(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            subprocess.run(
                ["git", "init", "--quiet", str(checkout)], check=True,
                capture_output=True, text=True,
            )
            (checkout / ".gitignore").write_bytes((ROOT / ".gitignore").read_bytes())
            excluded = [
                "docs/source-build.md", "docs/vendor/reference.json",
                "progress.md", "PROGRESS.MD", "dotanime.md", "notes/design.md",
                ".pi/mcp.json", ".agents/skills/local/SKILL.md",
                ".claude/settings.json", ".codex/config.toml", ".cursor/rules.json",
                ".mcp.json", "skills-lock.json", ".vscode/settings.json",
                ".env", ".env.local", "desktop/.env.production", ".netrc",
                ".git-credentials", "private.key", "private.pem",
                "gallery-dl-backend/config.json",
                "gallery-dl-backend/credentials/session.json",
                "gallery-dl-backend/runtime/state.json", "subscriptions/pool.yaml",
                "account.cookies.txt", "browser-profiles/Default/Preferences",
                "hf_at.txt", "data.sqlite3", "downloads/image.jpg",
            ]
            included = [
                "README.md", "README_EN.md", "backend/README.md", "nested/readme.MD",
                "LICENSE", "LICENSE.md", "NOTICE.md", "THIRD-PARTY-NOTICES.md",
                ".env.example", ".env.production.example",
                "gallery-dl-backend/config.example.json",
                "backend/cmd/ldos-backend/main_linux.go",
                "backend/internal/search/lifecycle_test.go",
                "desktop/src/lib/api/queries/crawls-refresh.test.ts",
                "tests/test_repository_hygiene.py", ".github/workflows/ci.yml",
                "scripts/setup-linux.sh", "desktop/package-lock.json",
            ]
            result = subprocess.run(
                ["git", "-c", "core.excludesFile=/dev/null", "check-ignore",
                 "--no-index", "--stdin"],
                cwd=checkout, input="\n".join(excluded + included) + "\n",
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(set(result.stdout.splitlines()), set(excluded))

    def test_public_readme_links_do_not_depend_on_local_notes(self):
        for relative in ("README.md", "README_EN.md", "backend/README.md"):
            source = ROOT / relative
            for target in re.findall(r"\]\(([^)]+)\)", source.read_text(encoding="utf-8")):
                if target.startswith(("https://", "http://", "mailto:", "#")):
                    continue
                with self.subTest(source=relative, target=target):
                    destination = (source.parent / target.split("#", 1)[0]).resolve()
                    self.assertTrue(destination.exists(), target)
                    self.assertTrue(destination.is_relative_to(ROOT), target)
                    result = subprocess.run(
                        ["git", "check-ignore", "--no-index", "--", str(destination)],
                        cwd=ROOT, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 1, target)


if __name__ == "__main__":
    unittest.main()
