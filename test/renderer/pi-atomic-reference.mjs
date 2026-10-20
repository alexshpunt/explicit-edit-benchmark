import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { concurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { providerFixture } from "./provider-fixture.mjs";

const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/** Drive real persistent bash-only Pi actors with a deterministic local provider.
 * Each native bash call invokes the existing isolated current-task reference editor.
 * The provider receives only the dispatched public node; no prepared plans, grader
 * contracts or future tasks enter either Pi or the editing service. This verifies
 * Pi's actual process, tool and session path, not model editing ability. The helper
 * is a scripted fixture only and must never be mounted into a measured model run.
 */
export function scriptedPiFactory({ runtime, tools, tasks, artifacts, signal }) {
  return async (workspace, state, agent) => {
    const directory = path.join(artifacts, `pi-${agent}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const editor = concurrentExecutor(workspace, tools, { signal });
    let current;
    let driver;
    const provider = await providerFixture(
      directory,
      async (body) => {
        assert.ok(current, "No public atomic delivery is active");
        if (body.reference) {
          assert.equal(body.reference, current.token, "Stale scripted tool invocation");
          assert.equal(current.invoked, false, "Duplicate scripted edit invocation");
          current.invoked = true;
          current.receipt = await editor.execute(current.task);
          return { usage: zeroUsage };
        }
        assert.deepEqual(
          body.tools.map((tool) => tool.function.name),
          ["bash"],
        );
        assert.ok(!body.messages.some((message) => message.role === "system" && message.content));
        const last = body.messages.at(-1);
        if (last.role === "tool") {
          assert.ok(current.receipt, "Pi must finish its real bash edit before its final answer");
          return { usage: zeroUsage };
        }
        assert.equal(last.role, "user");
        const prompt =
          typeof last.content === "string"
            ? last.content
            : last.content.map((part) => part.text ?? "").join("");
        assert.equal(prompt, current.prompt, "Scripted provider received a different task");
        const program = [
          "import urllib.request",
          `request = urllib.request.Request(${JSON.stringify(provider.endpoint)}, data=${JSON.stringify(JSON.stringify({ reference: current.token }))}.encode(), headers={'Content-Type': 'application/json'})`,
          "with urllib.request.urlopen(request) as response:",
          "    print(response.read().decode())",
        ].join("\n");
        return {
          command: `python3 - <<'PI_ATOMIC_REFERENCE'\n${program}\nPI_ATOMIC_REFERENCE`,
          usage: zeroUsage,
        };
      },
      { retainRequests: false, contextWindow: 10000000 },
    );
    try {
      driver = await startBaseline(
        workspace,
        state,
        { ...provider.config, runtime },
        {
          eventsFile: path.join(directory, "events.jsonl"),
          signal,
        },
      );
    } catch (error) {
      provider.close();
      await editor.close();
      throw error;
    }
    return {
      get closed() {
        return driver.closed;
      },
      async execute(prompt, metadata) {
        assert.equal(current, undefined, "Overlapping scripted Pi delivery");
        const task = tasks.get(metadata.atomicId);
        assert.ok(task && prompt.startsWith(task.prompt), "Missing current public atomic node");
        current = { task, prompt, token: randomUUID(), invoked: false, receipt: undefined };
        try {
          const result = await driver.execute(prompt, metadata);
          assert.ok(current.invoked && current.receipt, "No actual Pi bash edit was observed");
          assert.equal(result.toolCalls, 1);
          assert.equal(result.failedToolCalls, 0);
          return { ...result, scriptedReference: current.receipt };
        } catch (error) {
          if (provider.errors.length)
            error.message += `; scripted fixture: ${provider.errors.map((item) => item.message).join("; ")}`;
          throw error;
        } finally {
          current = undefined;
        }
      },
      async close() {
        await driver.close();
        provider.close();
        await editor.close();
      },
    };
  };
}
