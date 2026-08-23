import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  clearScreen: false,
  plugins: [svelte()],
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts"],
      exclude: ["src/core/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
