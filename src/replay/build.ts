import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { packTrace } from "./trace/store.ts";

const gzipAsync = promisify(gzip);
const execFileAsync = promisify(execFile);
const VIEWER_CONFIG = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "viewer",
  "vite.config.ts",
);

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);

/** Keeps inline code from closing its own <script> or <style> element. */
const inlineSafe = (code: string, tag: "script" | "style") =>
  code.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** Builds the viewer into a temporary directory and returns its script and style. Vite
 * runs as its own command, so the benchmark's code never loads Vite or its types. */
async function buildViewer() {
  const vite = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  const outDir = await mkdtemp(path.join(tmpdir(), "replay-viewer-"));
  try {
    await execFileAsync(process.execPath, [
      vite,
      "build",
      "--config",
      VIEWER_CONFIG,
      "--outDir",
      outDir,
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ]);
    const [script, style] = await Promise.all(
      ["replay.js", "replay.css"].map((name) => readFile(path.join(outDir, name), "utf8")),
    );
    if (script === undefined || style === undefined)
      throw new Error("The viewer build is incomplete");
    return { script, style };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Builds one self-contained HTML replay from a trace directory. The page needs no
 * network and opens from disk. */
export async function buildReplay(traceDir: string, outFile: string) {
  const { script, style } = await buildViewer();
  const trace = await packTrace(traceDir);
  const payload = (await gzipAsync(Buffer.from(JSON.stringify(trace)), { level: 9 })).toString(
    "base64",
  );
  const title = `${trace.header.scenario.title} · Agent Replay`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="explicit-edit-benchmark replay">
<title>${escapeHtml(title)}</title>
<style>${inlineSafe(style, "style")}</style>
</head>
<body>
<div id="app"></div>
<script id="agent-replay-trace" type="application/gzip+base64">${payload}</script>
<script type="module">${inlineSafe(script, "script")}</script>
</body>
</html>
`;
  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await writeFile(outFile, html);
  return { bytes: Buffer.byteLength(html), traceBytes: payload.length };
}
