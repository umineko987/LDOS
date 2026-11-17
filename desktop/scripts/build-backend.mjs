import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The desktop backend build currently supports Linux x86_64 only");
}
const backend = fileURLToPath(new URL("../../backend/", import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(backend, "build/ldos-backend");
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync("go", ["build", "-trimpath", "-o", output, "./cmd/ldos-backend"], {
  cwd: backend,
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
