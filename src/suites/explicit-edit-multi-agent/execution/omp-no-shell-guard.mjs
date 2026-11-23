import { writeFileSync, writeSync } from "node:fs";

/** Oh My Pi extension for the no-Bash harness. The bash and debug tools are off
 * through settings, but eval cells reach a shell through `sh()`, child_process,
 * Bun.spawn and the Bun shell, so this guard refuses such cells before they run. The
 * check reads the cell's source text: it stops ordinary use, and a deliberate
 * workaround stays visible in the trace. The loadout check stops the process before
 * any model request when Bash or the debugger is active or the guard sees no eval
 * tool to watch.
 */

const SHELL_PATTERNS = [
  // A path such as /bin/sh or a property such as x.sh is not the helper.
  [/(?<![\w$./])sh(?![\w$])/, "the sh() helper"],
  [/child_process/, "child_process"],
  [/\bBun\s*\.\s*(?:spawn|spawnSync|\$)/, "Bun.spawn or the Bun shell"],
  [
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:bun|node:worker_threads|worker_threads)["']/,
    "a Bun or worker module import",
  ],
  [/__shell__|__omp_call_tool__/, "the internal shell bridge"],
  [/\bprocess\s*\.\s*(?:binding|dlopen)\b/, "native process bindings"],
];

/** Tools that run commands or programs. */
const SHELL_TOOLS = new Set(["bash", "debug", "exec", "shell", "ssh"]);

export const NO_SHELL_REASON =
  "Shell commands are not available in this benchmark run. The bash tool is off, and eval cells may not use the sh() helper, child_process, Bun.spawn, the Bun shell or percent commands. Edit files with the editing tools or with plain JavaScript file reads and writes.";

/** Why an eval cell or tool call is refused, or undefined when it may run. */
export function shellUse(toolName, input) {
  if (SHELL_TOOLS.has(toolName)) return `the ${toolName} tool`;
  if (toolName !== "eval") return undefined;
  if (input?.language !== "js") return "a non-JavaScript eval cell";
  const code = typeof input.code === "string" ? input.code : "";
  if (code.trimStart().startsWith("%")) return "a percent command";
  return SHELL_PATTERNS.find(([pattern]) => pattern.test(code))?.[1];
}

/** What is wrong with an active loadout of the no-Bash harness. */
export const loadoutProblems = (tools) => [
  ...tools.filter((tool) => SHELL_TOOLS.has(tool)).map((tool) => `${tool} is active`),
  ...(tools.includes("eval") ? [] : ["eval is not active"]),
];

export default function noShellGuard(pi) {
  pi.on("session_start", () => {
    const tools = [...pi.getActiveTools()].sort();
    const problems = loadoutProblems(tools);
    writeFileSync(
      `${process.env.PI_CODING_AGENT_DIR}/no-shell-profile.json`,
      JSON.stringify({ tools, problems }) + "\n",
    );
    if (problems.length) {
      writeSync(2, `Invalid Oh My Pi no-Bash loadout: ${problems.join(", ")}\n`);
      process.exit(1);
    }
  });
  pi.on("tool_call", (event) => {
    const use = shellUse(event.toolName, event.input);
    return use ? { block: true, reason: `${NO_SHELL_REASON} Refused: ${use}.` } : undefined;
  });
}
