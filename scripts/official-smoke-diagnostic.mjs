import { open, readFile } from "node:fs/promises";
import path from "node:path";

const taskId = "replace-all-10-plain";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function stderrPrefix(file) {
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function failureKind(result, stderr, exactMatch) {
  const evidence = `${stderr}\n${typeof result.error === "string" ? result.error : ""}`;
  if (result.timedOut) return "timeout";
  if (/\b(401|403|unauthorized|forbidden|expired token|invalid api key)\b/i.test(evidence))
    return "authentication";
  if (/\b(404|model not found|unknown model|unsupported model)\b/i.test(evidence))
    return "model-unavailable";
  if (/\b(429|rate.?limit|quota exceeded)\b/i.test(evidence)) return "rate-limit";
  if (/\b(ERR_MODULE_NOT_FOUND|cannot find module|module not found)\b/i.test(evidence))
    return "missing-module";
  if (
    /\b(bwrap|bubblewrap)\b/i.test(evidence) &&
    /\b(permission denied|operation not permitted)\b/i.test(evidence)
  )
    return "sandbox-permission";
  if (result.exitCode !== 0) return "process-failed";
  if (Array.isArray(result.errors) && result.errors.length) return "agent-errors";
  if (exactMatch === false) return "incorrect-edit";
  return "unknown";
}

/** Return only allowlisted smoke facts. Never return model text, stderr, paths, or error messages. */
export async function officialSmokeDiagnostic(runDirectory, profile) {
  if (!/^[a-z0-9-]+$/.test(profile)) throw Error("Invalid smoke profile");
  const trial = path.join(runDirectory, "trials", `${taskId}__r01__${profile}`);
  const result = await readJson(path.join(trial, "result.json"));
  const comparison = await readJson(path.join(trial, "comparison.json")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const stderr = await stderrPrefix(path.join(trial, "agent", "stderr.log"));
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    kind: failureKind(result, stderr, comparison?.exactMatch),
    exitCode: count(result.exitCode),
    timedOut: result.timedOut === true,
    modelRounds: count(result.modelRounds),
    toolCalls: count(result.toolCalls),
    events: count(result.eventCount),
    agentErrors: Array.isArray(result.errors) ? result.errors.length : null,
    exactMatch: typeof comparison?.exactMatch === "boolean" ? comparison.exactMatch : null,
  };
}
