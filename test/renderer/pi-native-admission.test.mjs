import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const runtime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = { skip: !runtime || process.platform !== "linux", timeout: 30000 };
const content = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((block) => block.text ?? "").join("");

for (const phase of ["turn", "idle", "compacting"]) {
  const completion = phase === "compacting" ? "turn" : phase;
  test(
    `an unsolicited native continuation cannot reject or replay the next ${phase} delivery`,
    options,
    async (t) => {
      await mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/native-admission-"));
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const backgroundStarted = Promise.withResolvers();
      const releaseBackground = Promise.withResolvers();
      const first = "packet-first";
      const second = "packet-second";
      let secondRequests = 0;
      let compactionSeen = false;
      const provider = await providerFixture(root, async (body, number) => {
        if (
          body.messages.some((message) => message.role === "user" && content(message) === second)
        ) {
          if (secondRequests++ === 0)
            return {
              command:
                "printf 'once\\n' >> /workspace/packet-second.txt; printf packet-second-effect",
            };
          return {};
        }
        if (number === 1)
          return {
            toolCall: {
              name: "bash",
              arguments: {
                command:
                  // Keep real history above the native keep-recent budget, not fake usage.
                  (phase === "compacting" ? `#${"x".repeat(100000)}\n` : "") +
                  "printf 'once\\n' >> /workspace/packet-first.txt; while [ ! -f /workspace/release-background ]; do sleep 0.05; done; printf background-finished",
                background: true,
              },
            },
          };
        if (number === 2) return {};
        if (phase === "compacting" && !compactionSeen) {
          if (number === 3)
            return { status: 400, error: "maximum context length is 100000 tokens" };
          compactionSeen = true;
        }
        backgroundStarted.resolve();
        await releaseBackground.promise;
        return {};
      });
      let driver;
      t.after(async () => {
        releaseBackground.resolve();
        try {
          await driver?.terminate();
        } finally {
          provider.close();
          await rm(root, { recursive: true, force: true });
        }
      });
      driver = await startPiParticipant(
        workspace,
        path.join(root, "participant"),
        {
          ...provider.config,
          runtime,
          harness: "pi-agent-ide-codemode",
        },
        { enforceProcessBoundary: true, signal: t.signal },
      );
      const identity = await driver.assertIdle();
      await driver.execute(first, { completion: "turn", signal: t.signal });
      await writeFile(path.join(workspace, "release-background"), "ready\n");
      await Promise.race([
        backgroundStarted.promise,
        delay(5000, undefined, { signal: t.signal, ref: false }).then(() => {
          throw new Error("Fixture did not receive the background or compaction request");
        }),
      ]);
      if (phase === "compacting")
        assert.ok(driver.events.some((event) => event.type === "compaction_start"));
      const next = driver.execute(second, { completion, signal: t.signal });
      next.catch(() => {});
      // The rejected preflight is a real native RPC response, not a fabricated busy state.
      const deadline = performance.now() + 5000;
      while (
        !driver.events.some(
          (event) =>
            event.type === "response" && event.command === "prompt" && event.success === false,
        )
      ) {
        assert.ok(
          performance.now() < deadline,
          "The held native run did not reject the competing preflight",
        );
        await delay(10);
      }
      // Native work may outlive the 15-second control-RPC acknowledgement deadline.
      if (phase === "idle") await delay(16000);
      releaseBackground.resolve();
      const result = await next;
      assert.equal(result.sessionId, identity.sessionId);
      assert.equal(result.lifetime, identity.lifetime);
      assert.equal(await readFile(path.join(workspace, "packet-first.txt"), "utf8"), "once\n");
      assert.equal(await readFile(path.join(workspace, "packet-second.txt"), "utf8"), "once\n");
      for (const packet of [first, second])
        assert.equal(
          driver.events.filter(
            (event) =>
              event.type === "message_start" &&
              event.message?.role === "user" &&
              content(event.message) === packet,
          ).length,
          1,
        );
      const starts = driver.events.filter((event) => event.type === "agent_start").length;
      if (phase === "compacting") {
        assert.equal(compactionSeen, true);
        assert.ok(driver.events.some((event) => event.type === "compaction_end" && event.result));
        assert.ok(starts >= 3);
      } else assert.equal(starts, 3);
      assert.equal(driver.events.filter((event) => event.type === "agent_settled").length, 3);
      assert.equal((await driver.assertIdle()).sessionId, identity.sessionId);
      assert.deepEqual(provider.errors, []);
      await driver.close();
      assert.equal(driver.closed, true);
    },
  );
}
