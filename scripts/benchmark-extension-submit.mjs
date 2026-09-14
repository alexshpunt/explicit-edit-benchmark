#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_EXTENSION_ARMS,
  extensionInstallation,
  preparePiExtensionConfig,
} from "./pi-extension-arms.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export const extensionSubmitUsage = `Usage:
  npm run benchmark:extension:submit -- --extension NAME --auth-file FILE [--concurrency N] [--timeout-seconds N]

Installs the exact shared Pi release and selected extension into a temporary runtime, runs the paid
smoke and all 226 tasks on openai-codex/gpt-5.6-luna at low reasoning, and opens a Dataset pull
request. The runtime is removed afterward.`;

/** Parse one paid extension observation without allowing model or version drift. */
export function extensionSubmitOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--extension", "--auth-file", "--concurrency", "--timeout-seconds"].includes(flag))
      throw Error(`Unknown option: ${flag ?? "(missing)"}`);
    if (value === undefined) throw Error(`Missing value for ${flag}`);
    if (options.has(flag)) throw Error(`Duplicate option: ${flag}`);
    options.set(flag, value);
  }
  const extension = options.get("--extension");
  const authFile = options.get("--auth-file");
  if (!extension) throw Error("--extension is required");
  if (!PI_EXTENSION_ARMS[extension]) throw Error(`Unknown Pi extension arm: ${extension}`);
  if (!authFile) throw Error("--auth-file is required");
  const concurrency = Number(options.get("--concurrency") ?? 10);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw Error("concurrency must be a positive integer");
  const timeoutSeconds = Number(options.get("--timeout-seconds") ?? 120);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
    throw Error("timeout-seconds must be a positive integer");
  return { extension, authFile, concurrency, timeoutSeconds };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function main(args) {
  if (args.includes("--help")) {
    console.log(extensionSubmitUsage);
    return;
  }
  const options = extensionSubmitOptions(args);
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `explicit-edit-${options.extension}-`));
  const config = path.join(runtimeRoot, "benchmark-config.json");
  try {
    console.log(`Installing exact runtime for ${options.extension}…`);
    await run("npm", [
      "install",
      "--prefix",
      runtimeRoot,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--save=false",
      ...extensionInstallation(options.extension),
    ]);
    await preparePiExtensionConfig({
      id: options.extension,
      runtimeRoot,
      authFile: options.authFile,
      output: config,
    });
    await run(process.execPath, [
      path.join(root, "scripts", "benchmark-submit.mjs"),
      "--config",
      config,
      "--concurrency",
      String(options.concurrency),
      "--timeout-seconds",
      String(options.timeoutSeconds),
    ]);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`benchmark:extension:submit: ${error.message}`);
    process.exitCode = 1;
  });
