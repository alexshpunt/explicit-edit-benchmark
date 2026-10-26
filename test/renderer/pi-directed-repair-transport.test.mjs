import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { independentPiFactory } from "./pi-independent-reference.mjs";
import { barrierRepairNodes } from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME);

test(
  "native Pi Bash executes fresh declaration problems without original atom IDs",
  { timeout: 120_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/pi-directed-repairs-"));
    const workspace = path.join(root, "workspace"),
      tools = path.join(root, "tools");
    const header = "#pragma once\nstruct Box { int First; int Second; };\n";
    const main = '#include "part.h"\nint value(Box box) { return box.First + box.Second; }\n';
    let driver;
    try {
      await mkdir(workspace);
      await writeFile(path.join(workspace, "part.h"), header);
      await writeFile(path.join(workspace, "main.cpp"), main);
      await prepareConcurrentExecutor(tools);
      const createDriver = independentPiFactory({
        runtime: process.env.RENDERER_PI_RUNTIME,
        tools,
        tasks: new Map(),
        artifacts: path.join(root, "artifacts"),
        signal: t.signal,
      });
      driver = await createDriver(workspace, path.join(root, "state"), 0);
      const histories = [];
      for (const [from, to] of [
        ["First", "left"],
        ["Second", "right"],
      ]) {
        const current = await readFile(path.join(workspace, "part.h"), "utf8");
        const identifiers = cppTokens(current).filter((token) => /^[A-Za-z_]\w*$/.test(token.text));
        const identifier = identifiers.findIndex((token) => token.text === from);
        assert.ok(identifier >= 0);
        const token = identifiers[identifier];
        const prefix = current.slice(0, token.start);
        const id = `repair-round-001-attempt-2-${from}`;
        const operation = {
          phase: "repair",
          action: "rename-binding",
          category: "fields",
          target: {
            file: "part.h",
            identifier,
            name: from,
            role: "field",
            translationUnit: "main.cpp",
            scope: `Box::${from}`,
            line: prefix.split("\n").length,
            column: token.start - current.lastIndexOf("\n", token.start - 1),
          },
          required: { name: to },
          files: ["main.cpp", "part.h"],
        };
        const receipt = await driver.execute(JSON.stringify({ problems: [operation] }), {
          deliveryKind: "barrier-repair",
          atomicId: id,
          atomicIds: [],
          repairTasks: [{ id, operations: [operation] }],
          batchSize: 1,
        });
        assert.equal(receipt.toolCalls, 1);
        assert.equal(receipt.failedToolCalls, 0);
        assert.equal(receipt.scriptedReference.status, "edited");
        assert.deepEqual(
          receipt.scriptedReference.receipts.map((item) => item.id),
          [id],
        );
        histories.push(receipt);
      }
      assert.equal(typeof histories[0].sessionId, "string");
      assert.equal(typeof histories[0].lifetime, "string");
      assert.equal(histories[0].sessionId, histories[1].sessionId);
      assert.equal(histories[0].lifetime, histories[1].lifetime);
      const expected = (text) => text.replaceAll("First", "left").replaceAll("Second", "right");
      assert.equal(await readFile(path.join(workspace, "part.h"), "utf8"), expected(header));
      assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), expected(main));
    } finally {
      await driver?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native Pi Bash repairs a current nested module without replaying its original atom",
  { timeout: 120_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/pi-nested-module-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "tools");
    const header =
      "#ifndef API_H\n#define API_H\nnamespace api { inline int value() { return 42; } }\n#endif\n";
    const peerHeader = header.replace("namespace api", "// Current peer header.\nnamespace api");
    const main =
      "#ifndef ROOT_H\n#define ROOT_H\n#ifndef PARENT_H\n#define PARENT_H\n" +
      header +
      "int main() { return api::value(); }\n#endif\n#endif\n";
    const tree = { "main.cpp": main, "api.h": peerHeader };
    const repairs = barrierRepairNodes({
      category: "structure",
      tree,
      nodes: [
        {
          id: "historical-atom",
          taskId: "historical-parent",
          prompt: "HISTORICAL_PROMPT",
          operations: [
            { phase: "structure", action: "header", file: "api.h", guard: "API_H", includes: [] },
          ],
        },
      ],
      diagnostics: [{ category: "structure", kind: "directive", file: "main.cpp" }],
    });
    const repairTasks = repairs.map(({ id, operations }) => ({
      id: `repair-round-001-attempt-2-${id}`,
      operations,
    }));
    assert.equal(repairTasks.length, 1);
    assert.equal(repairTasks[0].operations.length, 1);
    assert.equal(repairTasks[0].operations[0].action, "remove-source-module");
    assert.equal(JSON.stringify(repairTasks).includes("historical"), false);
    assert.equal(JSON.stringify(repairTasks).includes("HISTORICAL"), false);
    assert.equal(JSON.stringify(repairTasks).includes("return 42"), false);
    let driver;
    let completed = false;
    try {
      await mkdir(workspace);
      for (const [file, source] of Object.entries(tree))
        await writeFile(path.join(workspace, file), source);
      await prepareConcurrentExecutor(tools);
      const createDriver = independentPiFactory({
        runtime: process.env.RENDERER_PI_RUNTIME,
        tools,
        tasks: new Map(),
        artifacts: path.join(root, "artifacts"),
        signal: t.signal,
      });
      driver = await createDriver(workspace, path.join(root, "state"), 0);
      const receipt = await driver.execute(JSON.stringify({ problems: repairTasks }), {
        deliveryKind: "barrier-repair",
        atomicId: repairTasks[0].id,
        atomicIds: [],
        repairTasks,
        batchSize: 50,
      });
      assert.equal(receipt.toolCalls, 1);
      assert.equal(receipt.failedToolCalls, 0);
      assert.equal(receipt.scriptedReference.status, "edited");
      assert.deepEqual(
        receipt.scriptedReference.receipts.map((item) => item.id),
        repairTasks.map((item) => item.id),
      );
      assert.equal(typeof receipt.sessionId, "string");
      assert.equal(typeof receipt.lifetime, "string");
      assert.equal(await readFile(path.join(workspace, "api.h"), "utf8"), peerHeader);
      const after = await readFile(path.join(workspace, "main.cpp"), "utf8");
      assert.ok(after.includes('#include "api.h"'));
      assert.equal(after.includes("#ifndef API_H"), false);
      assert.ok(after.includes("#ifndef ROOT_H"));
      assert.ok(after.includes("#ifndef PARENT_H"));
      assert.ok(after.includes("int main() { return api::value(); }"));
      completed = true;
    } finally {
      await driver?.close();
      if (completed) await rm(root, { recursive: true, force: true });
    }
  },
);
