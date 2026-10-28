import { paraglideVitePlugin } from "@inlang/paraglide-js";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

import packageJson from "./package.json" with { type: "json" };
import tauriConfig from "./src-tauri/tauri.conf.json" with { type: "json" };
import { devCsp } from "./scripts/external-boot.ts";

export default defineConfig({
  clearScreen: false,
  build: { assetsInlineLimit: 0 },
  plugins: [
    // 编译选项在 project.inlang/paraglide.config.ts。
    paraglideVitePlugin({ project: "./project.inlang" }),
    tailwindcss(),
    sveltekit({
      // Tauri 从 dist/ 加载；hash 路由下 SvelteKit 只产出一个 index.html，路由全部走 location.hash。
      adapter: adapter({ pages: "dist", assets: "dist" }),
      router: { type: "hash" },
      // 桌面应用随安装包更新，不需要轮询新版本；版本号固定，构建产物可复现。
      version: { name: packageJson.version, pollInterval: 0 },
    }),
    devCsp(tauriConfig.app.security.devCsp),
  ],
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/{domain,keys,events,api}/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/lib/api/schema.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 95 },
    },
  },
});
