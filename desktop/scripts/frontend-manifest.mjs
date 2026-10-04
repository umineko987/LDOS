import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const manifestName = "frontend-manifest.json";

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => relative(dist, file) !== manifestName)
    .sort();
}

const files = [];
for (const file of await collectFiles(dist)) {
  const bytes = await readFile(file);
  files.push({
    path: relative(dist, file).split(sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  });
}

const manifest = {
  build_source: "desktop",
  entrypoint: "index.html",
  files,
  schema_version: 1,
};
await writeFile(
  join(dist, manifestName),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
