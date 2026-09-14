import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PI_EXTENSION_ARMS,
  PI_EXTENSION_VERSION,
  extensionInstallation,
  extensionInstallFlags,
  preparePiExtensionConfig,
  createPiExtensionAdapter,
  resolvePiExtensionPackage,
} from "../../scripts/pi-extension-arms.mjs";
import { recoveryAdapter } from "../../scripts/harness-runtime.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

const requested = [
  "pi-hashline-edit-pro",
  "pi-codex-conversion",
  "pi-lector",
  "personal-pi-extensions-opencode",
  "pi-openai-codex-compat",
  "pi-better-edit",
  "d3ara1n-pi-hashline-edit",
  "pi-semantic-edit",
  "pi-hashline-edit",
  "pi-lean-edit",
  "pi-better-read-edit",
  "pi-codex-minimal-tools",
  "pi-codex-edit",
  "pi-apply-patch",
  "pi-codex-tools",
  "pi-hash-edit",
  "pi-str-replace-editor",
  "pi-mono-multi-edit",
  "pi-edit-safe",
  "jerryan-pi-hashline-edit",
  "pi-hledit",
  "pi-wayfinder",
  "anchor-edit",
  "pi-hash-anchored-edit",
  "pi-hashline-context-edit",
];

await test("the requested extension catalog pins one shared Pi and 25 exact package releases", () => {
  assert.equal(PI_EXTENSION_VERSION, "0.85.1");
  assert.deepEqual(Object.keys(PI_EXTENSION_ARMS), requested);
  for (const [id, arm] of Object.entries(PI_EXTENSION_ARMS)) {
    assert.match(arm.package, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u, id);
    assert.match(arm.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, id);
    assert.ok(arm.entries.length > 0, id);
    assert.ok(arm.tools.length > 0, id);
  }
});

await test("an arm installs exact Pi and extension releases", () => {
  assert.deepEqual(extensionInstallation("pi-semantic-edit"), [
    "@earendil-works/pi-coding-agent@0.85.1",
    "pi-semantic-edit@0.4.0",
  ]);
  assert.throws(() => extensionInstallation("unknown-extension"), /Unknown Pi extension arm/u);
  assert.deepEqual(extensionInstallFlags("pi-semantic-edit"), []);
  for (const id of ["pi-openai-codex-compat", "pi-lean-edit", "pi-hledit"])
    assert.deepEqual(extensionInstallFlags(id), ["--legacy-peer-deps"], id);
});

await test("an installed extension must match the catalog name, version, and entries", async () => {
  const root = await tempDirectory("pi-extension-package");
  const packageDirectory = path.join(root, "node_modules", "example-extension");
  await mkdir(path.join(packageDirectory, "src"), { recursive: true });
  await writeFile(path.join(packageDirectory, "src/index.ts"), "export default () => {};\n");
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "example-extension", version: "1.2.3" }),
  );

  const resolved = resolvePiExtensionPackage(packageDirectory, {
    package: "example-extension",
    version: "1.2.3",
    entries: ["src/index.ts"],
  });
  assert.deepEqual(resolved.entries, [path.join(packageDirectory, "src/index.ts")]);
  assert.equal(resolved.runtime, path.join(root, "node_modules"));

  assert.throws(
    () =>
      resolvePiExtensionPackage(packageDirectory, {
        package: "another-extension",
        version: "1.2.3",
        entries: ["src/index.ts"],
      }),
    /package name/u,
  );
  assert.throws(
    () =>
      resolvePiExtensionPackage(packageDirectory, {
        package: "example-extension",
        version: "9.9.9",
        entries: ["src/index.ts"],
      }),
    /package version/u,
  );
  assert.throws(
    () =>
      resolvePiExtensionPackage(packageDirectory, {
        package: "example-extension",
        version: "1.2.3",
        entries: ["../outside.ts"],
      }),
    /inside the package/u,
  );
});

await test("a Pi extension arm disables discovered resources and publishes exact identity", async () => {
  const root = await tempDirectory("pi-extension-adapter");
  const packageDirectory = path.join(root, "node_modules", "example-extension");
  await mkdir(path.join(packageDirectory, "src"), { recursive: true });
  await writeFile(path.join(packageDirectory, "src/index.ts"), "export default () => {};\n");
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "example-extension", version: "1.2.3" }),
  );
  const arm = {
    package: "example-extension",
    version: "1.2.3",
    entries: ["src/index.ts"],
    tools: ["read", "replace"],
    rules: ["four-character line anchors"],
  };
  const adapter = createPiExtensionAdapter({
    id: "example-extension",
    arm,
    command: "/usr/bin/pi",
    piVersion: PI_EXTENSION_VERSION,
    packageDirectory,
    authFile: "/private/auth.json",
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
  });

  assert.equal(adapter.kind, "pi-default");
  assert.equal(adapter.agentFamily, "pi");
  assert.equal(adapter.agentVersion, PI_EXTENSION_VERSION);
  assert.equal(adapter.harnessFamily, "example-extension");
  assert.equal(adapter.harnessVersion, "1.2.3");
  assert.deepEqual(adapter.configuration.extensions, ["example-extension@1.2.3"]);
  assert.deepEqual(adapter.configuration.tools, ["read", "replace"]);
  assert.equal(adapter.seedFiles["pi/auth.json"], "/private/auth.json");
  for (const flag of [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ])
    assert.ok(adapter.args.includes(flag), flag);
  assert.deepEqual(
    adapter.args.filter((value) => value.endsWith("src/index.ts")),
    [path.join(packageDirectory, "src/index.ts")],
  );
  assert.ok(adapter.readOnly.includes(path.join(root, "node_modules")));
  assert.ok(recoveryAdapter(adapter, true).args.includes("--continue"));
});

await test("a scoped npm package produces public-safe configuration labels", async () => {
  const root = await tempDirectory("pi-extension-scoped-label");
  const packageDirectory = path.join(root, "node_modules", "@scope", "extension");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "index.ts"), "export default () => {};\n");
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@scope/extension", version: "1.2.3" }),
  );
  const adapter = createPiExtensionAdapter({
    id: "scope-extension",
    arm: {
      package: "@scope/extension",
      version: "1.2.3",
      entries: ["index.ts"],
      tools: ["edit"],
      rules: [],
    },
    command: "/usr/bin/pi",
    piVersion: PI_EXTENSION_VERSION,
    packageDirectory,
    model: "openai-codex/gpt-5.6-luna",
    thinking: "low",
  });

  assert.deepEqual(adapter.configurationLabels, [
    "extension/scope/extension",
    "harness/scope-extension",
  ]);
});

await test("preparing one arm writes a private runnable config for that arm only", async () => {
  const root = await tempDirectory("pi-extension-runtime");
  const modules = path.join(root, "node_modules");
  const piPackage = path.join(modules, "@earendil-works", "pi-coding-agent");
  const extensionPackage = path.join(modules, "pi-semantic-edit");
  await mkdir(path.join(modules, ".bin"), { recursive: true });
  await mkdir(piPackage, { recursive: true });
  await mkdir(extensionPackage, { recursive: true });
  await writeFile(
    path.join(piPackage, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: PI_EXTENSION_VERSION }),
  );
  await writeFile(path.join(modules, ".bin", "pi"), "#!/bin/sh\n");
  await writeFile(path.join(extensionPackage, "index.ts"), "export default () => {};\n");
  await writeFile(
    path.join(extensionPackage, "package.json"),
    JSON.stringify({ name: "pi-semantic-edit", version: "0.4.0" }),
  );
  const output = path.join(root, "config.json");

  await preparePiExtensionConfig({
    id: "pi-semantic-edit",
    runtimeRoot: root,
    authFile: "/private/auth.json",
    output,
  });

  const config = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(Object.keys(config.harnesses), ["pi-semantic-edit"]);
  assert.equal(config.harnesses["pi-semantic-edit"].harnessVersion, "0.4.0");
  assert.equal(config.harnesses["pi-semantic-edit"].agentVersion, PI_EXTENSION_VERSION);
  assert.equal(config.harnesses["pi-semantic-edit"].model, "openai-codex/gpt-5.6-luna");
  assert.equal(config.harnesses["pi-semantic-edit"].thinking, "low");
});
