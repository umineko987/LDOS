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
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
