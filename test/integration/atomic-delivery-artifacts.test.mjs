import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tempDirectory } from "../helpers/temp.mjs";
import { harnessParticipant } from "../../scripts/harness-participant.mjs";
import { inspectHarnessOutput } from "../../scripts/harness-runtime.mjs";
import { teamDeliveryDirectory } from "../../scripts/normalized-team-protocol.mjs";

await test(
  "one participant retains distinct native artifacts for each atomic delivery and failure",
  { timeout: 5000 },
  async (t) => {
    const root = await tempDirectory("atomic-delivery-artifacts-");
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const artifacts = path.join(root, "artifacts");
    const node = path.join(root, "node");
    await mkdir(workspace);
    await copyFile(process.execPath, node);
    const participant = harnessParticipant(
      {
        kind: "custom",
        command: "/usr/bin/true",
        args: [],
        driver: {
          persistent: true,
          command: node,
          args: [
            "-e",
            `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const { prompt } = JSON.parse(line);
  console.log(JSON.stringify({type:"tool_execution_start", toolName:"bash", args:{command:prompt}}));
  console.log(JSON.stringify({type:"message_end", message:{role:"assistant", stopReason:prompt === "failure" ? "error" : "stop", usage:{input:8, output:2, cacheRead:4, cacheWrite:0, totalTokens:14, cost:{total:0.25}}}}));
  console.log(JSON.stringify({type:"eval/turn-complete", reason:{kind:"completed"}}));
});`,
          ],
        },
        readOnly: [node],
        inspectOutput: (file) => inspectHarnessOutput("pi-default", file),
      },
      { workspace, state, artifacts },
    );
    t.after(async () => {
      await participant.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const [atomicId, prompt] of [
      ["task-001-atom-001", "first"],
      ["task-001-atom-002", "second"],
      [undefined, "coarse"],
      ["task-001-atom-003", "failure"],
    ]) {
      const execute = participant.execute(prompt, { round: "round-001", attempt: 1, atomicId });
      if (prompt === "failure")
        await assert.rejects(execute, (error) => {
          assert.equal(error.category, "driver_exit");
          assert.equal(error.receipt.totalTokens, 14);
          return true;
        });
      else assert.equal((await execute).totalTokens, 14);
      const directory = path.join(artifacts, teamDeliveryDirectory("round-001", 1, atomicId));
      const calls = JSON.parse(await readFile(path.join(directory, "tool-calls.json"), "utf8"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args.command, prompt);
      assert.equal(
        JSON.parse(await readFile(path.join(directory, "execution.json"), "utf8")).totalTokens,
        14,
      );
    }
    const first = path.join(artifacts, "round-001-task-001-atom-001-attempt-1", "tool-calls.json");
    assert.equal(JSON.parse(await readFile(first, "utf8"))[0].args.command, "first");
    await assert.rejects(
      participant.execute("bad", { round: "round-001", attempt: 1, atomicId: "../../escape" }),
    );
  },
);
