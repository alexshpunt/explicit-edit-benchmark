import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSharedSource } from "../reference/concurrent-commit.mjs";
import { publishEdits } from "../reference/ordinary-edit.mjs";
import { extractCurrentHeader } from "../extraction/edit.mjs";

const workspace = process.argv[2];
const lines = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
let delivered = false;
for await (const line of lines) {
  let request;
  try {
    if (delivered) throw Error("Reference participant already received its module");
    delivered = true;
    request = JSON.parse(line);
    // Cooperating reference actors use an ordinary inherited-descriptor flock.
    // This is their Bash-accessible edit transaction, not controller scheduling.
    // Read AFTER acquiring it: textual diff3 cannot reliably distinguish nested
    // peers' identical closing directives from one another.
    const descriptor = openSync(workspace, "r");
    try {
      execFileSync("/usr/bin/flock", ["--exclusive", "3"], {
        stdio: ["ignore", "ignore", "pipe", descriptor],
      });
      const before = await readSharedSource(workspace);
      const after = extractCurrentHeader(before, request);
      writeFileSync(path.join(workspace, request.file), after[request.file], { flag: "wx" });
      // The new target now exists; only main needs publication. This avoids
      // reacquiring our directory lock through the missing-target editor path.
      const result = publishEdits(
        workspace,
        { ...before, [request.file]: after[request.file] },
        after,
      );
      if (result.conflicts.length) throw Error("Concurrent extraction publication conflicted");
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          status: "edited",
          written: [request.file, ...result.written],
        }) + "\n",
      );
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id: request?.id, status: "failed", error: error.message }) + "\n",
    );
  }
}
