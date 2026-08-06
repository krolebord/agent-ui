import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@main": path.resolve(import.meta.dirname, "src/main"),
      "@renderer": path.resolve(import.meta.dirname, "src/renderer/src"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    testTimeout: 1000 * 29,
  },
});
