import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareConcurrentExecutor } from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { referenceConcurrency } from "../../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";
import { independentPiFactory } from "./pi-independent-reference.mjs";

assert.ok(process.env.RENDERER_PI_RUNTIME, "Set RENDERER_PI_RUNTIME to the installed Pi runtime");

test(
  "native Pi Bash children publish requested retained corrections and defer source-blocked new atoms",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/pi-retained-context-"));
    const workspace = path.join(root, "workspace"),
      tools = path.join(root, "tools");
    const drivers = [];
    const header = "#pragma once\nstruct Box { int First; int Second; int Third; };\n";
    const main =
      '#include "part.h"\nint value(Box box) { return box.First + box.Second + box.Third; }\n';
    const tasks = new Map(
      ["First", "Second", "Third"].map((name) => [
        name,
        {
          id: name,
          operations: [
            {
              phase: "names",
              category: "fields",
              mapping: [{ from: name, to: name.toLowerCase() }],
              selectors: [{ kind: "record", scope: "Box" }],
            },
          ],
        },
      ]),
    );
    try {
      await mkdir(workspace);
      await writeFile(path.join(workspace, "part.h"), header);
      await writeFile(path.join(workspace, "main.cpp"), main);
      await prepareConcurrentExecutor(tools);
      const createDriver = independentPiFactory({
        runtime: process.env.RENDERER_PI_RUNTIME,
        tools,
        tasks,
        artifacts: path.join(root, "artifacts"),
        signal: t.signal,
      });
      for (let agent = 0; agent < 2; agent++)
        drivers.push(await createDriver(workspace, path.join(root, `state-${agent}`), agent));
      const deliver = (agent, ...ids) =>
        drivers[agent].execute(`Rename only the selected fields: ${ids.join(", ")}.`, {
          atomicId: ids[0],
          atomicIds: ids,
        });
      const first = await deliver(0, "First");
      const warm = await deliver(1, "Third");
      const file = path.join(workspace, "part.h");
      await writeFile(
        file,
        (await readFile(file, "utf8"))
          .replace("int first;", "int First;")
          .replace("int third;", "int Third;"),
      );
      const mixed = await deliver(1, "Second", "Third");
      assert.equal(mixed.sessionId, warm.sessionId);
      assert.equal(mixed.toolCalls, 1);
      assert.equal(mixed.failedToolCalls, 0);
      assert.equal(mixed.scriptedReference.status, "conflict");
      const events = (await readFile(path.join(root, "artifacts/pi-1/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        events
          .filter((event) => event.type === "tool_execution_end")
          .some((event) => {
            const output = JSON.stringify(event.result);
            return (
              output.includes("Native source planning blocked:") &&
              output.includes("Compiler AST failed:")
            );
          }),
        "The actual Bash tool result must expose the source diagnostic, not only saved controller receipts",
      );
      assert.deepEqual(
        mixed.scriptedReference.receipts.map((receipt) => receipt.id),
        ["Second", "Third"],
      );
      const [blocked, corrected] = mixed.scriptedReference.receipts;
      assert.equal(blocked.status, "conflict");
      assert.match(blocked.sourceFailure.message, /Compiler AST failed:/);
      assert.equal(blocked.sourceFailure.exitCode, 1);
      assert.deepEqual(blocked.written, []);
      assert.equal(corrected.status, "edited");
      assert.match(await readFile(file, "utf8"), /int First; int Second; int third;/);
      assert.match(
        await readFile(path.join(workspace, "main.cpp"), "utf8"),
        /box.first \+ box.Second \+ box.third/,
      );
      assert.throws(() =>
        execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(workspace, "main.cpp")], {
          stdio: "pipe",
        }),
      );
      const correction = await deliver(0, "First");
      assert.equal(correction.sessionId, first.sessionId);
      const next = await deliver(1, "Second");
      assert.equal(next.sessionId, warm.sessionId);
      assert.equal(next.scriptedReference.status, "edited");
      assert.ok(
        next.scriptedReference.receipts[0].events.some((event) => event.phase === "plan-start"),
      );
      const renamed = (source) =>
        source
          .replaceAll("First", "first")
          .replaceAll("Second", "second")
          .replaceAll("Third", "third");
      assert.equal(await readFile(file, "utf8"), renamed(header));
      assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), renamed(main));
      execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(workspace, "main.cpp")], {
        stdio: "pipe",
      });
    } finally {
      await Promise.all(drivers.map((driver) => driver.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "fifteen native Pi Bash children edit shared files without a controller editing callback",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/pi-independent-reference-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "tools");
    const drivers = [];
    try {
      await mkdir(workspace);
      const original =
        "#include <vector>\n#include <string>\n" +
        Array.from({ length: 15 }, (_, i) => `int Fn${i}(int value) { return value + ${i}; }`).join(
          "\n",
        ) +
        "\n";
      await writeFile(path.join(workspace, "main.cpp"), original);
      await prepareConcurrentExecutor(tools);
      const tasks = new Map(
        Array.from({ length: 15 }, (_, i) => [
          `edit-${i}`,
          {
            id: `edit-${i}`,
            operations: [
              {
                phase: "names",
                category: "functions-types",
                mapping: [{ from: `Fn${i}`, to: `run${i}` }],
                selectors: [{ kind: "function", scope: `Fn${i}` }],
              },
            ],
          },
        ]),
      );
      const createDriver = independentPiFactory({
        runtime: process.env.RENDERER_PI_RUNTIME,
        tools,
        tasks,
        artifacts: path.join(root, "artifacts"),
        signal: t.signal,
      });
      for (let i = 0; i < 15; i++)
        drivers.push(await createDriver(workspace, path.join(root, `state-${i}`), i));
      const deliver = (i) =>
        drivers[i].execute(`Rename Fn${i} to run${i}, including its bound uses.`, {
          atomicId: `edit-${i}`,
          atomicIds: [`edit-${i}`],
        });
      const receipts = await Promise.all(drivers.map((_, i) => deliver(i)));
      assert.equal(new Set(receipts.map((receipt) => receipt.sessionId)).size, 15);
      const observed = referenceConcurrency(receipts.map((receipt) => ({ receipt })));
      assert.equal(observed.executors, 15);
      assert.ok(observed.maxWorking > 1);
      assert.ok(observed.maxPlanning > 1);
      for (let attempt = 0; attempt < 5; attempt++) {
        const source = await readFile(path.join(workspace, "main.cpp"), "utf8");
        const missing = drivers.map((_, i) => i).filter((i) => source.includes(`Fn${i}(`));
        if (!missing.length) break;
        await Promise.all(missing.map(deliver));
      }
      assert.equal(
        await readFile(path.join(workspace, "main.cpp"), "utf8"),
        original.replace(/Fn(\d+)/g, "run$1"),
      );
    } finally {
      await Promise.all(drivers.map((driver) => driver.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
