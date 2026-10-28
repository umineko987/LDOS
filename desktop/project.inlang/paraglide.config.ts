import { defineConfig } from "@inlang/paraglide-js";

// Vite 插件和 `npm run i18n` 共用这份配置，开发、构建、检查编译出同一个运行时。
export default defineConfig({
  outdir: "./src/lib/paraglide",
  strategy: ["localStorage", "baseLocale"],
  localStorageKey: "ldos.locale",
  emitTsDeclarations: true,
});
