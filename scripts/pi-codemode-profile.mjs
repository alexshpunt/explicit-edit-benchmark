import { writeFileSync, writeSync } from "node:fs";

// Pi Agent IDE keeps diff, undo, ast_search and lsp_search deferred behind
// tool_search, so they are not part of the active loadout it starts with.
const ideTools = [
  "codemode",
  "tool_search",
  "read",
  "write",
  "search",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
];

const hashlineTools = ["read", "replace", "insert", "grep", "undo_last_change", "write"];

/** Tools each extension harness must and must not declare. The IDE variant without
 * Bash leaves editing and commands to the IDE tools and Codemode. pi-hashline-edit-pro
 * replaces Pi's read, grep and edit with anchored tools and keeps write and Bash; its
 * variant without Bash keeps the same tools except Bash.
 */
export const IDE_HARNESS_TOOLS = Object.freeze({
  "pi-agent-ide-codemode": { required: [...ideTools, "bash"], forbidden: [] },
  "pi-agent-ide-codemode-no-bash": { required: ideTools, forbidden: ["bash"] },
  "pi-hashline-edit-pro": { required: [...hashlineTools, "bash"], forbidden: ["edit"] },
  "pi-hashline-edit-pro-no-bash": { required: hashlineTools, forbidden: ["edit", "bash"] },
});

/** Return the required tools absent from an observed loadout, and any forbidden tool present. */
export function missingProfileTools(tools, harness = process.env.RENDERER_PI_HARNESS) {
  const expected = IDE_HARNESS_TOOLS[harness ?? "pi-agent-ide-codemode"];
  if (!expected) return [`unknown harness ${harness}`];
  const names = new Set(tools);
  return [
    ...expected.required.filter((name) => !names.has(name)),
    ...expected.forbidden.filter((name) => names.has(name)).map((name) => `-${name}`),
  ];
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
        `Invalid ${process.env.RENDERER_PI_HARNESS} loadout (${phase}): missing or forbidden ${missing.join(", ")}\n`,
      );
      // Lifecycle handler errors can be reported and ignored by Pi. This benchmark-only
      // process must stop instead; the runner terminates its remaining process group.
      process.exit(1);
    }
  };
  pi.on("session_start", () => check("active", pi.getActiveTools()));
  pi.on("context_with_system", (event) => check("model", declaredToolNames(event.messages)));
}
