// 用后端的虚拟环境运行 openapi-snapshot.py。解释器可用 LDOS_BACKEND_PYTHON 指定。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const backend = fileURLToPath(new URL("../../gallery-dl-backend/", import.meta.url));
const script = fileURLToPath(new URL("./openapi-snapshot.py", import.meta.url));
const python =
  process.env.LDOS_BACKEND_PYTHON ??
  [`${backend}.venv/bin/python`, `${backend}.venv/Scripts/python.exe`].find((candidate) => existsSync(candidate));

if (!python) {
  console.error("openapi-snapshot: 找不到后端解释器，请设置 LDOS_BACKEND_PYTHON");
  process.exit(1);
}

const result = spawnSync(python, ["-I", script], { stdio: "inherit" });
process.exit(result.status ?? 1);
