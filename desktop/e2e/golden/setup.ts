// 黄金路径的全局准备：在临时目录里建数据目录、素材和模型占位，启动真实后端（和桌面宿主开发模式同一个入口：
// `python -m gdl_backend --config …`，带 GDL_BACKEND_PARENT_PIPE 和 LDOS_DESKTOP_ORIGIN），返回的函数负责收尾。
// 去重和打标的子进程走 fakes/ 里的替身（真实 worker / CLI，推理换成按像素判断），不需要模型、不联网。
//
// 解释器默认用仓库里 setup-linux.sh 建好的两个虚拟环境，可以用环境变量覆盖：
//   LDOS_GOLDEN_BACKEND_PYTHON  后端（默认 gallery-dl-backend/.venv/bin/python）
//   LDOS_GOLDEN_TOOL_PYTHON     去重 worker 和打标 CLI（默认 .venv/bin/python，要有 numpy、opencv、Pillow）
//   LDOS_GOLDEN_KEEP=1          收尾时保留临时目录（后端日志在 <临时目录>/backend.log）

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const FAKES = join(HERE, "fakes");
/** 开发服务器的 origin；后端靠 LDOS_DESKTOP_ORIGIN 放行它的跨源请求（和 src-tauri 开发模式一样）。 */
const DEV_ORIGIN = "http://localhost:1420";

/** 传给用例的路径和地址（globalSetup 写进 process.env，worker 进程继承）。 */
export interface GoldenEnv {
  readonly apiOrigin: string;
  /** 导入的图片文件夹。 */
  readonly source: string;
  /** 导出目标目录。 */
  readonly exportTarget: string;
}

export function goldenEnv(): GoldenEnv {
  const apiOrigin = process.env.LDOS_GOLDEN_API;
  const source = process.env.LDOS_GOLDEN_SOURCE;
  const exportTarget = process.env.LDOS_GOLDEN_EXPORT;
  if (!apiOrigin || !source || !exportTarget) throw new Error("黄金路径要用 playwright.golden.config.ts 跑（npm run test:e2e:golden）");
  return { apiOrigin, source, exportTarget };
}

function python(variable: string, fallback: string): string {
  const path = process.env[variable] || join(REPO, fallback);
  if (!existsSync(path)) throw new Error(`找不到 ${path}：先跑 scripts/setup-linux.sh，或用 ${variable} 指定解释器`);
  return path;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((done) => child.once("exit", () => done()));
}

async function waitHealthy(origin: string, child: ChildProcess, log: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // 还没开始监听。
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  const tail = readFileSync(log, "utf8").split("\n").slice(-30).join("\n");
  throw new Error(`后端没有就绪（退出码 ${child.exitCode}）：\n${tail}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const backendPython = python("LDOS_GOLDEN_BACKEND_PYTHON", "gallery-dl-backend/.venv/bin/python");
  const toolPython = python("LDOS_GOLDEN_TOOL_PYTHON", ".venv/bin/python");

  const root = mkdtempSync(join(tmpdir(), "ldos-golden-"));
  const data = join(root, "data");
  const source = join(root, "pictures", "golden_set");
  const exportTarget = join(root, "export");
  const dedupModels = join(data, "models", "dedup");
  const taggerModels = join(data, "models", "tagger");
  for (const directory of [data, exportTarget, join(root, "bin")]) mkdirSync(directory, { recursive: true });
  execFileSync(toolPython, [join(FAKES, "prepare.py"), source, dedupModels, taggerModels], { stdio: "inherit" });

  // 去重 Python 的替身：过滤模型探测交给 filter_probe.py，worker 等其余调用照常交给真实解释器。
  const dedupPython = join(root, "bin", "dedup-python");
  writeFileSync(dedupPython, [
    "#!/bin/sh",
    'case "$1" in',
    `  */review_filter_models.py) shift; exec '${toolPython}' '${join(FAKES, "filter_probe.py")}' "$@" ;;`,
    "esac",
    `exec '${toolPython}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(dedupPython, 0o755);

  const port = await freePort();
  const runtime = join(data, "runtime");
  const credentials = join(data, "credentials");
  const config = join(data, "config.json");
  writeFileSync(config, JSON.stringify({
    runtime_dir: runtime,
    database_path: join(runtime, "backend.sqlite3"),
    default_output_root: join(data, "downloads"),
    allowed_output_roots: [join(data, "downloads")],
    allowed_config_roots: [credentials],
    allowed_cookie_roots: [credentials],
    server: { host: "127.0.0.1", port, cors_origins: [], allow_private_targets: false, strict_target_dns: true },
    encrypted_dns: { enabled: false },
    gallery: {
      repo_path: join(REPO, "gallery-dl-codeberg"),
      cache_file: join(credentials, "managed", "gallery-dl-cache.sqlite3"),
      python_executable: backendPython,
      migrate_default_auth: false,
    },
    auth: { chrome_executable: "", authorization_proxy: "" },
    proxy: {
      enabled: false,
      auto_start: false,
      engine: "native",
      subscription_urls: [],
      inline_nodes: [],
      allowed_node_roots: [join(data, "subscriptions")],
      transport_core_enabled: false,
    },
    dedup: {
      enabled: true,
      python_executable: dedupPython,
      worker_script: join(FAKES, "dedup_worker.py"),
      core_script: join(REPO, "dedup", "dedup_core.py"),
      model_dir: dedupModels,
      device: "cpu",
      workers: 1,
      no_sscd: true,
      no_dino: true,
      poll_interval_seconds: 0.2,
    },
    tagger: {
      enabled: true,
      python_executable: toolPython,
      cli_script: join(FAKES, "tagger_cli.py"),
      model_dir: taggerModels,
      cache_path: join(data, "tagger", "tags.sqlite3"),
    },
  }, null, 2));

  const log = join(root, "backend.log");
  const output = openSync(log, "a");
  const local = "localhost,127.0.0.1,::1";
  // stdin 留着不关：GDL_BACKEND_PARENT_PIPE=1 时后端读到 EOF 就退出，测试进程意外退出也不会留下后端。
  const backend = spawn(backendPython, ["-m", "gdl_backend", "--config", config], {
    cwd: join(REPO, "gallery-dl-backend"),
    env: {
      ...process.env,
      GDL_BACKEND_PARENT_PIPE: "1",
      LDOS_DESKTOP_ORIGIN: DEV_ORIGIN,
      PYTHONUNBUFFERED: "1",
      no_proxy: local,
      NO_PROXY: local,
    },
    stdio: ["pipe", output, output],
  });
  const apiOrigin = `http://127.0.0.1:${port}`;

  const teardown = async () => {
    backend.stdin?.end();
    const stopped = await Promise.race([exited(backend).then(() => true), new Promise((done) => setTimeout(() => done(false), 15_000))]);
    if (!stopped) {
      backend.kill("SIGKILL");
      await exited(backend);
    }
    if (process.env.LDOS_GOLDEN_KEEP === "1") console.log(`黄金路径临时目录保留在 ${root}`);
    else rmSync(root, { recursive: true, force: true });
  };

  try {
    await waitHealthy(apiOrigin, backend, log);
  } catch (error) {
    await teardown();
    throw error;
  }
  process.env.LDOS_GOLDEN_API = apiOrigin;
  process.env.LDOS_GOLDEN_SOURCE = source;
  process.env.LDOS_GOLDEN_EXPORT = exportTarget;
  return teardown;
}
