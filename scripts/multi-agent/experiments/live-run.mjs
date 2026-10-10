import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSlice } from "./offline-run.mjs";

/** Run the unchanged slice through one real Baseline Agent with explicit private configuration. */
export function liveSlice(initialSource, workloadPath, output, baseline, options = {}) {
  return runSlice(initialSource, workloadPath, output, { ...options, baseline });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4)
      throw Error(
        "Usage: node scripts/multi-agent/experiments/live-run.mjs INITIAL_SOURCE WORKLOAD_JSON NEW_OUTPUT PRIVATE_CONFIG_JSON",
      );
    const baseline = JSON.parse(await readFile(args[3], "utf8"));
    const report = await liveSlice(...args.slice(0, 3), baseline, { signal: controller.signal });
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
