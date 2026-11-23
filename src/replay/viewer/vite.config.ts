import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import preactPreset from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

async function serveTrace(response: ServerResponse) {
  const directory = process.env.REPLAY_TRACE;
  if (!directory) {
    response.statusCode = 500;
    response.end("Set REPLAY_TRACE to a trace directory");
    return;
  }
  try {
    const { packTrace } = await import("../trace/store.ts");
    const trace = await packTrace(directory);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(trace));
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
}

/** In `npm run replay:dev`, serves the trace directory named by REPLAY_TRACE at /__trace. */
function devTrace(): Plugin {
  return {
    name: "replay-dev-trace",
    configureServer(server) {
      server.middlewares.use("/__trace", (_request, response) => {
        void serveTrace(response);
      });
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  plugins: [preactPreset(), devTrace()],
  build: {
    // The replay command builds into a temporary directory of its own.
    outDir: path.join(here, "../../../.tmp/replay-viewer"),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    target: "es2022",
    rolldownOptions: {
      output: {
        entryFileNames: "replay.js",
        chunkFileNames: "replay-[name].js",
        assetFileNames: "replay[extname]",
      },
    },
  },
});
