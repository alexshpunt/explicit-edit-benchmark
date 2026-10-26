import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { startBaseline } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { publicReferenceTask } from "../../src/suites/explicit-edit-multi-agent/reference/current-task.mjs";

import { ATOMIC_DISPATCH_POLICY } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

/** Resolve only the current public delivery, keeping fresh repairs out of atom history. */
export function publicEditingTasks(metadata, tasks) {
  const repair = metadata.deliveryKind === "barrier-repair";
  assert.ok(metadata.deliveryKind === undefined || repair);
  let selected;
  if (repair) {
    assert.ok(Array.isArray(metadata.atomicIds) && metadata.atomicIds.length === 0);
    assert.ok(Array.isArray(metadata.repairTasks) && metadata.repairTasks.length > 0);
    selected = metadata.repairTasks;
    assert.equal(metadata.atomicId, selected[0].id, "Repair artifact differs from first problem");
    assert.ok(
      selected.every(
        (task) =>
          typeof task.id === "string" &&
          /^repair-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(task.id) &&
          Array.isArray(task.operations) &&
          task.operations.length > 0 &&
          task.operations.every((operation) => operation.phase === "repair"),
      ),
    );
  } else {
    assert.equal(Object.hasOwn(metadata, "repairTasks"), false);
    const ids = metadata.atomicIds ?? [metadata.atomicId];
    assert.ok(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length);
    selected = ids.map((id) => tasks.get(id));
    assert.ok(selected.every(Boolean));
  }
  const limit = metadata.batchSize ?? ATOMIC_DISPATCH_POLICY.defaultBatchSize;
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && selected.length <= limit);
  assert.equal(new Set(selected.map((task) => task.id)).size, selected.length);
  return selected.map(publicReferenceTask);
}
const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/** Native Pi's Bash child performs every edit inside the measured filesystem
 * sandbox. The deterministic provider supplies only the current public tasks
 * and editing program, never an HTTP callback that writes on the controller.
 * Each participant has its own files/history; there is no cross-agent service.
 */
export function independentPiFactory({ runtime, tools, tasks, artifacts, signal }) {
  return async (workspace, state, agent) => {
    const directory = path.join(artifacts, `pi-${agent}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lifetime = randomUUID();
    let current;
    const provider = await providerFixture(
      directory,
      async (body) => {
        assert.ok(current, "No public reference delivery is active");
        const last = body.messages.at(-1);
        if (last.role === "tool") {
          current.toolReturned = true;
          return { usage };
        }
        assert.equal(last.role, "user");
        assert.deepEqual(
          body.tools.map((tool) => tool.function.name),
          ["bash"],
        );
        const input = JSON.stringify(current.tasks) + "\n";
        const program = [
          "import base64, json, os, subprocess, zlib",
          "os.makedirs('/state/home/reference-tmp', mode=0o700, exist_ok=True)",
          `env = dict(os.environ, REFERENCE_EXECUTOR_ID=${JSON.stringify(lifetime)}, TMPDIR='/state/home/reference-tmp')`,
          `result = subprocess.run(['/usr/bin/node', '--expose-gc', '/state/home/reference-editor/reference/full-worker.mjs', '/workspace', '/state/home/reference-history'], input=zlib.decompress(base64.b64decode(${JSON.stringify(deflateSync(Buffer.from(input)).toString("base64"))})), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)`,
          "records = [json.loads(line) for line in result.stdout.decode().splitlines() if line.strip()]",
          "records = [receipt for item in records if item.get('type') != 'ready' for receipt in item.get('receipts', [item])]",
          "if any(item.get('status') == 'fail' for item in records): print('Native compiler failure:', [item.get('error') for item in records if item.get('status') == 'fail'])",
          "failures = {item['sourceFailure']['task']: item['sourceFailure'] for item in records if item.get('sourceFailure')}",
          "if failures: print('Native source planning blocked:', json.dumps(failures))",
          "print(result.stderr.decode())",
          `with open('/state/home/${current.record}.json', 'x') as evidence: json.dump(records, evidence)`,
          "print('Native reference edits finished:', len(records), [item['status'] for item in records])",
          "raise SystemExit(result.returncode or int(any(item.get('status') == 'fail' for item in records)))",
        ].join("\n");
        return {
          command: `python3 - <<'PI_INDEPENDENT_REFERENCE'\n${program}\nPI_INDEPENDENT_REFERENCE`,
          usage,
        };
      },
      { retainRequests: false, contextWindow: 10000000 },
    );
    let driver;
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
      await cp(tools, path.join(state, "home/reference-editor"), { recursive: true });
    } catch (error) {
      provider.close();
      await driver?.close();
      throw error;
    }
    return {
      get closed() {
        return driver.closed;
      },
      async execute(prompt, metadata) {
        assert.equal(current, undefined, "Overlapping reference delivery to one Pi");
        const selected = publicEditingTasks(metadata, tasks);
        current = { tasks: selected, record: randomUUID(), toolReturned: false };
        try {
          const receipt = await driver.execute(prompt, metadata);
          assert.ok(current.toolReturned, "No native Bash result was observed");
          current.receipts = JSON.parse(
            await readFile(path.join(state, `home/${current.record}.json`), "utf8"),
          );
          const failed = current.receipts.find((item) => item.status === "fail");
          if (failed)
            throw Object.assign(Error(failed.error), {
              category: "infrastructure",
              execution: receipt,
            });
          assert.equal(
            current.receipts?.length,
            selected.length,
            "Incomplete native editing receipt",
          );
          assert.equal(receipt.toolCalls, 1);
          assert.equal(receipt.failedToolCalls, 0);
          return {
            ...receipt,
            scriptedReference: {
              status: current.receipts.some((item) => item.status === "conflict")
                ? "conflict"
                : "edited",
              receipts: current.receipts,
            },
          };
        } finally {
          current = undefined;
        }
      },
      async close() {
        await driver.close();
        provider.close();
      },
    };
  };
}
