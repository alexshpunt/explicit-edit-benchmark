import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFullLive } from "./full-live-run.mjs";

/** Run the grouped one-hour profile without changing the sequential control.
 * All 2930 atomic instructions stay present; one ordered list is one model turn.
 * The fixed one-hour deadline includes initial grading and kills unfinished work.
 */
export function runGroupedFullLive(proof, config, output, { signal } = {}) {
  return runFullLive(proof, config, output, { signal, profile: "grouped-hour" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const report = await runGroupedFullLive(...process.argv.slice(2, 5), {
    signal: controller.signal,
  });
  process.exitCode = report.status === "pass" ? 0 : 1;
}
