import { writeFileSync, writeSync } from "node:fs";

const ideTools = [
  "codemode",
  "read",
  "write",
  "search",
  "diff",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "undo",
];

/** Tools each IDE harness must and must not declare. The variant without Bash
 * leaves editing and commands to the IDE tools and Codemode.
 */
export const IDE_HARNESS_TOOLS = Object.freeze({
  "pi-agent-ide-codemode": { required: [...ideTools, "bash"], forbidden: [] },
  "pi-agent-ide-codemode-no-bash": { required: ideTools, forbidden: ["bash"] },
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
