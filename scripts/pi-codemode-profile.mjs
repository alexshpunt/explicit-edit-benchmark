import { writeFileSync, writeSync } from "node:fs";

const requiredTools = [
  "codemode",
  "read",
  "bash",
  "write",
  "search",
  "diff",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "select",
  "undo",
];

/** Return the required Codemode/standalone tools absent from an observed loadout. */
export function missingProfileTools(tools) {
  const names = new Set(tools);
  return requiredTools.filter((name) => !names.has(name));
}

/** Replay Pi's system tool declarations, including removals, without changing context. */
export function declaredToolNames(messages) {
  const names = new Set();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names].sort();
}

/** Reject a mislabeled isolated benchmark process before it can request model inference. */
export default function codemodeProfile(pi) {
  const check = (phase, tools) => {
    const missing = missingProfileTools(tools);
    writeFileSync(
      `${process.env.PI_CODING_AGENT_DIR}/codemode-profile.json`,
      JSON.stringify({ phase, tools: [...tools].sort(), missing }) + "\n",
    );
    if (missing.length) {
      writeSync(
        2,
        `Invalid pi-agent-ide-codemode loadout (${phase}): missing ${missing.join(", ")}\n`,
      );
      // Lifecycle handler errors can be reported and ignored by Pi. This benchmark-only
      // process must stop instead; the runner terminates its remaining process group.
      process.exit(1);
    }
  };
  pi.on("session_start", () => check("active", pi.getActiveTools()));
  pi.on("context_with_system", (event) => check("model", declaredToolNames(event.messages)));
}
