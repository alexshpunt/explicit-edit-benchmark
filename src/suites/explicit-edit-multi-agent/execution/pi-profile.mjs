import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveIdePackage } from "../../../../scripts/prepare-benchmark.mjs";

/** Additive tool selections of the IDE harnesses: Codemode and tool_search join
 * Pi's default tools, and the variant without Bash also removes Bash. Pi Agent IDE
 * keeps some tools (diff, undo, ast_search, lsp_search) deferred behind tool_search
 * and turns tool_search on in a normal Pi install; the benchmark names it
 * explicitly because it owns the tool selection.
 */
const IDE_TOOL_ARGS = Object.freeze({
  "pi-agent-ide-codemode": ["--tools", "+codemode,+tool_search"],
  "pi-agent-ide-codemode-no-bash": ["--tools", "+codemode,+tool_search,-bash"],
});

/** Published Pi extensions that run as a harness with their own defaults: the
 * extension chooses its tools. The package's declared Pi entry is loaded. A variant
 * without Bash removes Pi's built-in Bash and keeps the rest of the extension's loadout.
 */
const EXTENSION_HARNESSES = Object.freeze({
  "pi-hashline-edit-pro": { package: "pi-hashline-edit-pro", toolArgs: [] },
  "pi-hashline-edit-pro-no-bash": {
    package: "pi-hashline-edit-pro",
    toolArgs: ["--tools", "-bash"],
  },
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
    "toolchain",
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
  assert.ok(
    config.toolchain === undefined || config.toolchain === "hidden",
    "The toolchain is either available or hidden",
  );
  const harness = config.harness === undefined ? "baseline-agent" : config.harness;
  assert.ok(
    harness === "baseline-agent" ||
      Object.hasOwn(IDE_TOOL_ARGS, harness) ||
      Object.hasOwn(EXTENSION_HARNESSES, harness),
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
  if (Object.hasOwn(EXTENSION_HARNESSES, harness)) {
    const name = EXTENSION_HARNESSES[harness].package;
    const directory = await realpath(path.join(runtime, "node_modules", name));
    const extension = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    assert.equal(extension.name, name);
    const entries = extension.pi?.extensions;
    assert.ok(
      Array.isArray(entries) && entries.length > 0,
      `${name} declares no Pi extension entry`,
    );
    const resolved = [];
    for (const entry of entries) {
      const file = await realpath(path.resolve(directory, entry));
      const relative = path.relative(directory, file);
      assert.ok(
        relative && !relative.startsWith("..") && !path.isAbsolute(relative),
        "Extension entries must stay inside the package",
      );
      resolved.push(path.posix.join("/runtime", ...path.relative(runtime, file).split(path.sep)));
    }
    return {
      ...base,
      baseline: false,
      harness: { id: harness, kind: harness, version: extension.version },
      toolArgs: EXTENSION_HARNESSES[harness].toolArgs,
      extensionArgs: [
        ...resolved.flatMap((entry) => ["--extension", entry]),
        "--extension",
        "/observer/pi-codemode-profile.mjs",
      ],
      settings: null,
    };
  }
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
      "builtin:tool-search",
      "--extension",
      path.posix.join("/runtime", ...path.relative(runtime, entry).split(path.sep)),
      "--extension",
      "/observer/pi-codemode-profile.mjs",
    ],
    // The IDE registers its own Bash; only a `-bash` default-tools entry hides it.
    settings:
      harness === "pi-agent-ide-codemode-no-bash"
        ? { codemode: { mode: "on" }, defaultTools: ["+codemode", "+tool_search", "-bash"] }
        : { codemode: { mode: "on" }, defaultTools: ["+codemode", "+tool_search"] },
  };
}
