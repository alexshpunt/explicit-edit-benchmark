import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveIdePackage } from "../../../../scripts/prepare-benchmark.mjs";

/** Additive tool selections of the IDE harnesses: Codemode joins Pi's default
 * tools, and the variant without Bash also removes Bash.
 */
const IDE_TOOL_ARGS = Object.freeze({
  "pi-agent-ide-codemode": ["--tools", "+codemode"],
  "pi-agent-ide-codemode-no-bash": ["--tools", "+codemode,-bash"],
});

/** Resolve an isolated native participant without starting a process or reading credentials. */
export async function resolvePiParticipantProfile(config) {
  const keys = new Set([
    "runtime",
    "model",
    "thinking",
    "authFile",
    "modelsFile",
    "envFile",
    "harness",
  ]);
  assert.ok(
    Object.keys(config).every((key) => keys.has(key)),
    "Unknown Pi participant configuration key",
  );
  assert.ok(
    typeof config.runtime === "string" &&
      typeof config.model === "string" &&
      config.model.includes("/"),
    "Explicit runtime and provider/model are required",
  );
  assert.ok(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinking),
    "Explicit thinking level is required",
  );
  const harness = config.harness === undefined ? "baseline-agent" : config.harness;
  assert.ok(
    harness === "baseline-agent" || Object.hasOwn(IDE_TOOL_ARGS, harness),
    "Unsupported native Pi harness",
  );
  const runtime = await realpath(config.runtime);
  const manifest = JSON.parse(
    await readFile(
      path.join(runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  );
  const base = { runtime, version: manifest.version };
  if (harness === "baseline-agent") {
    return {
      ...base,
      baseline: true,
      harness,
      toolArgs: ["--tools", "bash"],
      extensionArgs: [],
      settings: null,
    };
  }
  const installed = resolveIdePackage(path.join(runtime, "node_modules/pi-agent-ide"));
  const directory = await realpath(installed.directory);
  const entry = await realpath(installed.entry);
  const inside = (root, file) => {
    const relative = path.relative(root, file);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    );
  };
  assert.ok(
    inside(runtime, directory) && inside(directory, entry),
    "IDE package and entry must stay inside the mounted runtime",
  );
  const ide = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  assert.equal(ide.name, "pi-agent-ide");
  assert.match(installed.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (ide.gitHead !== undefined) assert.match(ide.gitHead, /^[a-f0-9]{40}$/);
  const version =
    installed.version +
    (ide.gitHead ? `${installed.version.includes("+") ? "." : "+"}${ide.gitHead}` : "");
  return {
    ...base,
    baseline: false,
    harness: { id: harness, kind: harness, version },
    toolArgs: IDE_TOOL_ARGS[harness],
    extensionArgs: [
      "--extension",
      "builtin:codemode",
      "--extension",
      path.posix.join("/runtime", ...path.relative(runtime, entry).split(path.sep)),
      "--extension",
      "/observer/pi-codemode-profile.mjs",
    ],
    settings: { codemode: { mode: "on" } },
  };
}
