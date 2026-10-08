import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../../scripts/adapter-registry.mjs";
import { prepareExecution } from "../../scripts/prepare-execution.mjs";

const credential = {
  "openai-codex": {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 7_200_000,
    accountId: "account-id",
  },
};

async function runtime(root, adapter) {
  const definition = ADAPTERS[adapter];
  const bin = path.join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, definition.binary);
  if (definition.credential === "omp") {
    const bun = path.join(root, "node_modules", "@oven", "bun-linux-x64", "bin", "bun");
    await mkdir(path.dirname(bun), { recursive: true });
    await writeFile(bun, "#!/bin/sh\nexit 0\n");
    await chmod(bun, 0o755);
  }
  const script =
    definition.credential === "omp"
      ? '#!/bin/sh\ncommand -v bun >/dev/null\nmkdir -p "$PI_CODING_AGENT_DIR"\nprintf db > "$PI_CODING_AGENT_DIR/agent.db"\n'
      : "#!/bin/sh\nexit 0\n";
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  if (definition.extensionPackage)
    await mkdir(path.join(root, "node_modules", definition.extensionPackage), { recursive: true });
}

for (const provider of ["opencode-go", "opencode"]) {
  test(`Oh My Pi passes ${provider} through the shared OpenCode environment variable`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "execution-route-"));
    await runtime(root, "oh-my-pi-default");
    const args = await prepareExecution({
      plan: {
        adapter: "oh-my-pi-default",
        provider,
        model: `${provider}/deepseek-v4.1-flash`,
        reasoning: "low",
        packages: [{ role: "agent", version: "18.2.6" }],
      },
      credentialStore: { [provider]: { type: "api_key", key: "opencode-secret" } },
      runtime: root,
      directory: path.join(root, "private"),
    });
    assert.equal(args.includes("--auth-file"), false);
    const environment = JSON.parse(await readFile(args[args.indexOf("--env-file") + 1], "utf8"));
    assert.equal(environment.OPENCODE_API_KEY, "opencode-secret");
  });
}

test("Pi receives the trusted GPT-6.1 Sol catalog seed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "execution-route-"));
  await runtime(root, "pi-default");
  const args = await prepareExecution({
    plan: {
      adapter: "pi-default",
      provider: "openai-codex",
      model: "openai-codex/gpt-6.1-sol",
      reasoning: "low",
      packages: [{ role: "agent", version: "0.87.1" }],
    },
    credentialStore: credential,
    runtime: root,
    directory: path.join(root, "private"),
  });
  const models = JSON.parse(await readFile(args[args.indexOf("--model-file") + 1], "utf8"));
  assert.equal(models.providers["openai-codex"].models[0].id, "gpt-6.1-sol");
});

for (const adapter of Object.keys(ADAPTERS)) {
  test(`${adapter} derives its private execution setup from the canonical registry`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "execution-route-"));
    await runtime(root, adapter);
    const packages = [{ role: "agent", version: "1.2.3" }];
    if (ADAPTERS[adapter].extensionPackage) packages.push({ role: "extension", version: "0.5.1" });
    const args = await prepareExecution({
      plan: {
        adapter,
        provider: "openai-codex",
        model: "openai-codex/gpt-5.6-luna",
        reasoning: "low",
        packages,
      },
      credentialStore: credential,
      runtime: root,
      directory: path.join(root, "private"),
    });
    assert.equal(args[args.indexOf("--harness") + 1], adapter);
    assert.equal(args[args.indexOf("--thinking") + 1], "low");
    assert.equal(
      args[args.indexOf("--command") + 1],
      path.join(root, "node_modules", ".bin", ADAPTERS[adapter].binary),
    );
    for (const flag of ["--auth-file", "--provider-file", "--env-file"])
      if (args.includes(flag)) await readFile(args[args.indexOf(flag) + 1]);
  });
}
