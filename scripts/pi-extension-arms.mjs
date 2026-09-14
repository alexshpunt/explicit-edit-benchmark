import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dependencyRoot } from "./prepare-benchmark.mjs";

/** One Pi release is fixed across the extension comparison. */
export const PI_EXTENSION_VERSION = "0.85.1";

/**
 * Published extension arms. Entries are paths inside the exact npm package, never files copied
 * into this repository. Tools record the complete active model-facing surface observed in clean Pi.
 */
export const PI_EXTENSION_ARMS = {
  "pi-hashline-edit-pro": {
    package: "pi-hashline-edit-pro",
    version: "4.2.11",
    entries: ["index.ts"],
    tools: ["read", "bash", "write", "replace", "insert", "undo_last_change"],
    rules: ["four-character session anchors", "stale-content rejection"],
    stateFiles: {
      "config/pi-hashline-edit-pro/config.json": '{"autoRead":false,"anchorGrepEnabled":false}\n',
    },
  },
  "pi-codex-conversion": {
    package: "@howaboua/pi-codex-conversion",
    version: "3.0.34",
    entries: ["dist/index.js"],
    tools: ["exec_command", "write_stdin", "apply_patch", "view_image"],
    rules: ["Codex patch grammar", "structured mode"],
  },
  "pi-lector": {
    package: "@danypops/pi-lector",
    version: "0.17.2",
    entries: ["extension/src/index.ts"],
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "find_symbols",
      "localize_context",
      "go_to_definition",
      "go_to_implementation",
      "find_references",
      "hover",
      "document_symbols",
      "diagnostics",
      "code_action_preview",
      "code_action_apply",
      "diagnostic_delta",
      "call_hierarchy",
      "type_hierarchy",
      "impact_analysis",
      "reference_based_rename",
      "rename",
      "symbol_annotations",
      "reachable_from",
      "workspace_map",
      "workspace_cache",
      "git",
      "search_code",
      "find_files",
      "line_edit",
      "apply_patch",
      "mutation_history",
      "package_source",
      "repo_cache",
      "external_search",
      "find_symbols_across_projects",
      "search_code_across_projects",
    ],
    rules: ["daemon-backed edits", "hash-guarded replacements"],
  },
  "personal-pi-extensions-opencode": {
    package: "@trim21/personal-pi-extensions",
    version: "0.1.556",
    entries: ["src/opencode/files.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["OpenCode fuzzy matching", "file tools module only"],
  },
  "pi-openai-codex-compat": {
    package: "pi-openai-codex-compat",
    version: "0.0.9",
    entries: ["extensions/index.ts"],
    tools: ["apply_patch"],
    rules: ["Codex patch grammar", "native Codex transport replacement"],
    unsupported: "requires Pi >=0.84 <0.85, but the comparison fixes Pi at 0.85.1",
  },
  "pi-better-edit": {
    package: "pi-better-edit",
    version: "1.7.0",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write", "read_skill", "undo_last_edit"],
    rules: ["three-character stable anchors", "session-served state validation"],
  },
  "d3ara1n-pi-hashline-edit": {
    package: "@d3ara1n/pi-hashline-edit",
    version: "0.5.0",
    entries: ["src/index.ts"],
    tools: ["read", "bash", "edit", "write", "grep", "replace"],
    rules: ["hashline anchors", "stale-anchor relocation"],
    stateFiles: {
      "pi/settings.json": '{"hashlineEdit":{"enabled":true,"hashLen":4,"shiftRadius":15}}\n',
    },
  },
  "pi-semantic-edit": {
    package: "pi-semantic-edit",
    version: "0.4.0",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["ten-pass fuzzy matching", "ambiguity rejection"],
  },
  "pi-hashline-edit": {
    package: "pi-hashline-edit",
    version: "0.8.3",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["content hashline anchors", "three-way stale-anchor recovery"],
    stateFiles: { "pi/hashline.json": '{"hashLength":2,"grep":false,"replaceText":false}\n' },
  },
  "pi-lean-edit": {
    package: "pi-lean-edit",
    version: "0.3.6",
    entries: ["index.ts"],
    tools: ["read", "edit", "write"],
    rules: ["snapshot verification", "process-local served state"],
    env: { PI_LEAN_EDIT_METRICS_PATH: "/state/pi/pi-lean-edit/metrics.json" },
    unsupported: "requires Pi ^0.84.2, but the comparison fixes Pi at 0.85.1",
  },
  "pi-better-read-edit": {
    package: "@pi-kaush/pi-better-read-edit",
    version: "0.2.2",
    entries: ["src/index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["coordinated tagged reads and edits"],
    stateFiles: { "pi/settings.json": '{"betterReadEdit":{"avoidModels":[]}}\n' },
  },
  "pi-codex-minimal-tools": {
    package: "@vanillagreen/pi-codex-minimal-tools",
    version: "2.0.1",
    entries: ["src/index.ts"],
    tools: ["read", "bash", "apply_patch"],
    rules: ["Codex patch grammar", "strict patch mode"],
    stateFiles: {
      "pi/settings.json":
        JSON.stringify({
          kendex: {
            extensionManager: {
              config: {
                "@vanillagreen/pi-codex-minimal-tools": {
                  enabled: true,
                  autoEnable: true,
                  nativeProviderTools: false,
                  imageGeneration: false,
                  directImageApiFallback: false,
                  viewImage: false,
                  applyPatchEnabled: true,
                  strictPatchMode: true,
                },
              },
            },
          },
        }) + "\n",
    },
  },
  "pi-codex-edit": {
    package: "@maxiaochao/pi-codex-edit",
    version: "0.1.5",
    entries: ["extensions/codex-edit.ts"],
    tools: ["read", "bash", "write", "apply_patch"],
    rules: ["model-aware Codex patch grammar", "native write retained"],
  },
  "pi-apply-patch": {
    package: "pi-apply-patch",
    version: "0.1.1",
    entries: ["src/index.ts"],
    tools: ["read", "bash", "apply_patch"],
    rules: ["Codex patch grammar", "native edit and write disabled"],
    stateFiles: { "pi/pi-apply-patch.json": '{"mode":"on"}\n' },
  },
  "pi-codex-tools": {
    package: "pi-codex-tools",
    version: "0.2.4",
    entries: ["index.ts"],
    tools: ["read", "bash", "apply_patch"],
    rules: ["raw grammar tool", "secure-filesystem preflight"],
    env: { PI_TELEMETRY: "0" },
  },
  "pi-hash-edit": {
    package: "@leo-alvarenga/pi-hash-edit",
    version: "0.2.1",
    entries: ["src/hash-edit-tools.ts"],
    tools: ["read", "bash", "edit", "write", "hash_read", "hash_edit"],
    rules: ["four-character SHA anchors", "stale-anchor rejection"],
  },
  "pi-str-replace-editor": {
    package: "@kennyfrc/pi-str-replace-editor",
    version: "0.1.1",
    entries: ["src/index.ts"],
    tools: ["bash", "str_replace_editor"],
    rules: ["DeepSeek editor dialect", "forced on for every model"],
    stateFiles: {
      "home/.pi/agent/pi-str-replace-editor.json":
        '{"mode":"on","deepseekPatterns":["deepseek"],"extraDisabledTools":[]}\n',
    },
  },
  "pi-mono-multi-edit": {
    package: "pi-mono-multi-edit",
    version: "2.0.0",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write", "multi_file_edit", "apply_patch"],
    rules: ["batch preflight", "best-effort cross-file rollback"],
  },
  "pi-edit-safe": {
    package: "@tian.zuo/pi-edit-safe",
    version: "0.1.1",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["strict full-span matching", "atomic sequential multi-edit"],
  },
  "jerryan-pi-hashline-edit": {
    package: "@jerryan/pi-hashline-edit",
    version: "0.11.5",
    entries: ["extensions/core.ts", "extensions/insert.ts", "extensions/undo.ts"],
    tools: ["read", "bash", "edit", "write", "insert", "undo"],
    rules: ["trimmed hashline schema", "core editing modules only"],
  },
  "pi-hledit": {
    package: "pi-hledit",
    version: "1.1.7",
    entries: ["index.ts"],
    tools: ["hledit"],
    rules: ["external hledit CLI", "atomic batch edits"],
    unsupported: "requires Pi ^0.79.9, but the comparison fixes Pi at 0.85.1",
  },
  "pi-wayfinder": {
    package: "@deevus/pi-wayfinder",
    version: "0.3.2",
    entries: ["src/index.ts"],
    tools: [
      "read",
      "bash",
      "write",
      "read_file",
      "edit_file",
      "get_file_skeleton",
      "get_function",
      "replace_symbol",
      "find_symbol_references",
      "rename_symbol",
      "grep",
      "find",
      "ls",
    ],
    rules: ["structure-aware reads", "replacement mode"],
    runtimeArgs: ["--wayfinder-mode", "replacement"],
  },
  "anchor-edit": {
    package: "anchor-edit",
    version: "0.0.3",
    entries: ["dist/pi-extension.js"],
    tools: ["read", "bash", "edit", "write", "read_anchored", "edit_anchored", "write_to_file"],
    rules: ["stateful single-token anchors", "Myers reconciliation"],
  },
  "pi-hash-anchored-edit": {
    package: "pi-hash-anchored-edit",
    version: "0.1.4",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["four-character optimistic anchors", "dry-run capable edits"],
  },
  "pi-hashline-context-edit": {
    package: "pi-hashline-context-edit",
    version: "0.11.0",
    entries: ["index.ts"],
    tools: ["read", "bash", "edit", "write"],
    rules: ["context-sensitive hashes", "three-way stale edit merge"],
  },
};

/** Exact packages installed into a private runtime before one arm runs. */
export function extensionInstallation(id) {
  const arm = PI_EXTENSION_ARMS[id];
  if (!arm) throw Error(`Unknown Pi extension arm: ${id}`);
  if (arm.unsupported) throw Error(`${id} is unsupported: ${arm.unsupported}`);
  return [
    `@earendil-works/pi-coding-agent@${PI_EXTENSION_VERSION}`,
    `${arm.package}@${arm.version}`,
  ];
}

/** Resolve only the exact files declared by one pinned catalog arm. */
export function resolvePiExtensionPackage(packageDirectory, arm) {
  const root = path.resolve(packageDirectory);
  const manifestPath = path.join(root, "package.json");
  if (!existsSync(manifestPath)) throw Error(`Pi extension package has no package.json: ${root}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== arm.package)
    throw Error(`Pi extension package name ${manifest.name ?? "(missing)"} is not ${arm.package}`);
  if (manifest.version !== arm.version)
    throw Error(
      `Pi extension package version ${manifest.version ?? "(missing)"} is not ${arm.version}`,
    );
  const entries = arm.entries.map((entry) => {
    const absolute = path.resolve(root, entry);
    if (!absolute.startsWith(root + path.sep))
      throw Error(`Pi extension entry must stay inside the package: ${entry}`);
    if (!existsSync(absolute)) throw Error(`Pi extension entry is missing: ${absolute}`);
    return absolute;
  });
  return { entries, runtime: dependencyRoot(root) };
}

function packageLabel(packageName) {
  return packageName.replace(/^@/u, "");
}

/** Build one clean Pi adapter around an exact installed extension package. */
export function createPiExtensionAdapter({
  id,
  arm,
  command,
  piVersion,
  packageDirectory,
  authFile,
  model,
  thinking,
}) {
  if (!id || !arm || !command || !piVersion || !packageDirectory || !model || !thinking)
    throw Error("A Pi extension arm requires id, package, command, Pi version, model and thinking");
  const installed = resolvePiExtensionPackage(packageDirectory, arm);
  const modelFamily = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : null;
  const args = [
    "--model",
    model,
    "--thinking",
    thinking,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir",
    "/state/pi/sessions",
    "--mode",
    "json",
    "-p",
    ...installed.entries.flatMap((entry) => ["--extension", entry]),
    ...(arm.runtimeArgs ?? []),
    "--",
    "{prompt}",
  ];
  return {
    kind: "pi-default",
    command,
    args,
    version: piVersion,
    model,
    thinking,
    transport: "harness-native",
    ready: false,
    readOnly: [installed.runtime],
    seedFiles: authFile ? { "pi/auth.json": path.resolve(authFile) } : {},
    stateFiles: arm.stateFiles ?? {},
    env: {
      PI_CODING_AGENT_DIR: "/state/pi",
      XDG_CONFIG_HOME: "/state/config",
      ...arm.env,
    },
    agentFamily: "pi",
    agentVersion: piVersion,
    modelFamily,
    modelVersion: modelFamily,
    provider,
    harnessFamily: id,
    harnessVersion: arm.version,
    adapterVersion: "1",
    configurationLabels: [`harness/${id}`, `extension/${packageLabel(arm.package)}`].sort(),
    configurationId: `${id}/npm`,
    configuration: {
      tools: arm.tools,
      extensions: [`${arm.package}@${arm.version}`],
      rules: arm.rules,
      runtimeFlags: ["clean-pi-resources", `thinking=${thinking}`],
      environment: Object.keys(arm.env ?? {}).sort(),
    },
  };
}

/** Write the one-profile private config consumed by benchmark:submit. */
export async function preparePiExtensionConfig({ id, runtimeRoot, authFile, output }) {
  const arm = PI_EXTENSION_ARMS[id];
  if (!arm) throw Error(`Unknown Pi extension arm: ${id}`);
  if (arm.unsupported) throw Error(`${id} is unsupported: ${arm.unsupported}`);
  const modules = path.join(path.resolve(runtimeRoot), "node_modules");
  const piManifest = path.join(modules, "@earendil-works", "pi-coding-agent", "package.json");
  if (!existsSync(piManifest)) throw Error(`Pi runtime package is missing: ${piManifest}`);
  const installedPiVersion = JSON.parse(readFileSync(piManifest, "utf8")).version;
  if (installedPiVersion !== PI_EXTENSION_VERSION)
    throw Error(
      `Pi runtime version ${installedPiVersion ?? "(missing)"} is not ${PI_EXTENSION_VERSION}`,
    );
  const command = path.join(modules, ".bin", "pi");
  if (!existsSync(command)) throw Error(`Pi runtime command is missing: ${command}`);
  const packageDirectory = path.join(modules, ...arm.package.split("/"));
  const adapter = createPiExtensionAdapter({
    id,
    arm,
    command,
    piVersion: installedPiVersion,
    packageDirectory,
    authFile,
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
  });
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify({ harnesses: { [id]: adapter } }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return adapter;
}
