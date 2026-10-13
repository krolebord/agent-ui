import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const externalDependencies = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

export default defineConfig({
  resolve: {
    alias: {
      "@main": path.join(__dirname, "src/main"),
      "@renderer": path.join(__dirname, "src/renderer/src"),
      "@shared": path.join(__dirname, "src/shared"),
    },
  },
  build: {
    ssr: true,
    outDir: "dist-headless",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: {
        index: "src/headless/index.ts",
        "embedding-worker": "src/main/session-memory/embedding/worker.ts",
      },
      external: externalDependencies,
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  clearScreen: false,
});
