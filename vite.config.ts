import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import pkg from "./package.json" with { type: "json" };
import { precompressAssets } from "./scripts/vite-plugin-precompress";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => {
  rmSync("dist-electron", { recursive: true, force: true });

  const isServe = command === "serve";
  const isBuild = command === "build";
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG;
  const externalDependencies = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  const aliases = {
    "@main": path.join(__dirname, "src/main"),
    "@renderer": path.join(__dirname, "src/renderer/src"),
    "@shared": path.join(__dirname, "src/shared"),
  };

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: aliases,
    },
    build: {
      chunkSizeWarningLimit: 1000,
    },
    worker: {
      format: "es",
    },
    plugins: [
      react(),
      tailwindcss(),
      precompressAssets(),
      !!process.env.ANALYZE &&
        visualizer({
          open: true,
          filename: "stats.html",
          gzipSize: true,
        }),
      electron({
        main: {
          entry: "src/main/index.ts",
          vite: {
            resolve: {
              alias: aliases,
            },
            build: {
              sourcemap,
              minify: isBuild,
              outDir: "dist-electron/main",
              rolldownOptions: {
                external: externalDependencies,
              },
            },
          },
        },
        preload: {
          input: "src/preload/index.ts",
          vite: {
            resolve: {
              alias: aliases,
            },
            build: {
              sourcemap: sourcemap ? "inline" : undefined,
              minify: isBuild,
              outDir: "dist-electron/preload",
              rolldownOptions: {
                external: externalDependencies,
              },
            },
          },
        },
        renderer: {},
      }),
    ],
    clearScreen: false,
  };
});
