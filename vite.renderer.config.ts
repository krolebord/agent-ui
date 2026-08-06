import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@main": path.join(__dirname, "src/main"),
      "@renderer": path.join(__dirname, "src/renderer/src"),
      "@shared": path.join(__dirname, "src/shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  worker: {
    format: "es",
  },
  plugins: [react(), tailwindcss()],
  clearScreen: false,
});
