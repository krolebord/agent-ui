import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// Extensions worth compressing. Images, fonts and archives are already
// compressed, so a second pass only wastes build time and disk.
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

// Below this the framing overhead outweighs anything deflate can save.
const MIN_SIZE_BYTES = 1024;

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

/**
 * Writes `.gz` and `.br` siblings next to every compressible build asset so the
 * headless server can hand them straight to the client. Assets are
 * content-hashed and served `immutable`, so compressing once here costs nothing
 * at runtime. Quality is maxed for the same reason.
 */
export function precompressAssets(): Plugin {
  let outDir = "";

  return {
    name: "agent-ui:precompress",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const stats = await stat(outDir).catch(() => null);
      if (!stats?.isDirectory()) return;

      let compressed = 0;
      let rawTotal = 0;
      let gzipTotal = 0;
      let brotliTotal = 0;

      for await (const filePath of walkFiles(outDir)) {
        const ext = path.extname(filePath);
        if (ext === ".gz" || ext === ".br") continue;
        if (!COMPRESSIBLE_EXTENSIONS.has(ext)) continue;

        const source = await readFile(filePath);
        if (source.byteLength < MIN_SIZE_BYTES) continue;

        const [gzipped, brotlied] = await Promise.all([
          gzipAsync(source, { level: constants.Z_BEST_COMPRESSION }),
          brotliAsync(source, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
            },
          }),
        ]);

        // A variant that grew is worse than no variant at all.
        if (gzipped.byteLength < source.byteLength) {
          await writeFile(`${filePath}.gz`, gzipped);
          gzipTotal += gzipped.byteLength;
        }
        if (brotlied.byteLength < source.byteLength) {
          await writeFile(`${filePath}.br`, brotlied);
          brotliTotal += brotlied.byteLength;
        }

        compressed++;
        rawTotal += source.byteLength;
      }

      if (compressed === 0) return;
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
      console.log(
        `precompress: ${compressed} files, ${mb(rawTotal)} MB raw -> ${mb(gzipTotal)} MB gzip / ${mb(brotliTotal)} MB brotli`,
      );
    },
  };
}
