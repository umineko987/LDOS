// 旧版工作台（legacy-src）的独立构建。产物写进 static/legacy/，
// 由 SvelteKit 原样复制到 dist/legacy/，新外壳侧栏的「旧版工作台」入口指向它。
// 各功能迁移完成后（Phase 11）连同 legacy-src 一起删除。
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: path("./legacy-src"),
  base: "./",
  publicDir: false,
  cacheDir: path("./node_modules/.vite-legacy"),
  clearScreen: false,
  build: {
    outDir: path("./static/legacy"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // 旧版是单包应用，不再拆分；只压住体积告警。
    chunkSizeWarningLimit: 1200,
  },
  plugins: [tailwindcss(), svelte({ configFile: false, preprocess: vitePreprocess() })],
  resolve: { alias: { $lib: path("./legacy-src/lib") } },
  test: {
    root: path("./legacy-src"),
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
