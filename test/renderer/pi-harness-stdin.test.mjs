import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeAdapter } from "../../scripts/prepare-benchmark.mjs";
import { closeHarness, recoveryAdapter, runHarness } from "../../scripts/harness-runtime.mjs";
import { providerFixture } from "./provider-fixture.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME, "Set RENDERER_PI_RUNTIME to the installed Pi runtime");

function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");
}
for (const harness of ["pi-default", "baseline-agent"]) {
  test(`${harness} delivers large assignments intact and continues each isolated history`, async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/pi-harness-stdin-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const provider = await providerFixture(
      root,
      (body) => {
        if (body.messages.at(-1).role === "tool") return {};
        const user = body.messages.findLast((message) => message.role === "user");
        const owner = /^owner-(\d+)/.exec(messageText(user))?.[1];
        assert.ok(owner);
        return { command: `printf 'edit\\n' >> owner-${owner}.txt` };
      },
      { contextWindow: 1000000 },
    );
    t.after(() => provider.close());
    const adapter = makeAdapter({
      harness,
      command: path.join(
        process.env.RENDERER_PI_RUNTIME,
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      ),
      runtime: [process.env.RENDERER_PI_RUNTIME],
      version: "1.3.0",
      model: "fixture/deterministic",
      thinking: "off",
      modelFile: provider.config.modelsFile,
    });
    const states = [0, 1].map((owner) => path.join(root, `state-${owner}`));
    t.after(() => Promise.all(states.map(closeHarness)));
    const prompts = states.map((_, owner) =>
      [0, 1].map(
        (turn) =>
          `owner-${owner} turn-${turn}\n` +
          Array.from({ length: 50 }, (_, i) => `${i}: ${"quoted '\" — λ ".repeat(400)}`).join(
            "\n",
          ) +
          "\nEND",
      ),
    );
    assert.ok(Buffer.byteLength(prompts[0][0]) > 131072);
    for (const turn of [0, 1]) {
      const results = await Promise.all(
        states.map((state, owner) =>
          runHarness(turn ? recoveryAdapter(adapter, true) : adapter, {
            workspace,
            state,
            artifacts: path.join(root, `native-${owner}-${turn}`),
            prompt: prompts[owner][turn],
            timeoutMs: null,
          }),
        ),
      );
      for (const result of results) assert.equal(result.exitCode, 0);
    }
    assert.deepEqual(provider.errors, []);
    for (const owner of [0, 1]) {
      assert.equal(
        await readFile(path.join(workspace, `owner-${owner}.txt`), "utf8"),
        "edit\nedit\n",
      );
      const resumed = provider.requests.find((request) => {
        const users = request.messages.filter((message) => message.role === "user");
        return users.length === 2 && messageText(users.at(-1)) === prompts[owner][1];
      });
      assert.ok(
        resumed,
        "The second native request must retain exactly this participant's history",
      );
      assert.deepEqual(
        resumed.messages.filter((message) => message.role === "user").map(messageText),
        prompts[owner],
      );
      const sessions = await readdir(path.join(states[owner], "pi/sessions"));
      assert.equal(sessions.filter((name) => name.endsWith(".jsonl")).length, 1);
    }
  });
}
