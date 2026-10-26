import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  readTree,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

for (const alreadyApplied of [true, false])
  await test(`a fresh executor resolves a macro-enabled header definition in its actual translation unit (${alreadyApplied ? "completed" : "pending"})`, async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/macro-context-correction-"));
    const workspace = path.join(root, "workspace"),
      tools = path.join(root, "executor");
    let executor;
    t.after(async () => {
      await executor?.close();
      await rm(root, { recursive: true, force: true });
    });
    const header = (name) =>
      `#ifndef API_H\n#define API_H\nint chosen(int OldValue);\n#endif\n#ifdef ENABLE_IMPL\nint chosen(int ${name}) { return ${name}; }\n#endif\n`;
    const before = {
      "api.h": header(alreadyApplied ? "new_value" : "OldValue"),
      "main.cpp": '#include "api.h"\nint main() { return chosen(1); }\n',
      "support/stb.cpp": '#define ENABLE_IMPL\n#include "../api.h"\n',
    };
    await writeTree(workspace, before);
    await prepareConcurrentExecutor(tools);
    executor = concurrentExecutor(workspace, tools, { signal: t.signal });
    const receipt = await executor.execute({
      id: "definition-parameter",
      operations: [
        {
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "OldValue", to: "new_value" }],
          selectors: [
            {
              kind: "variable",
              scope: "chosen::OldValue",
              owner: { scope: "chosen", signature: "int (int)", definition: true },
            },
          ],
        },
      ],
    });
    assert.equal(receipt.status, "edited");
    // The separately bound prototype parameter is deliberately not requested.
    assert.deepEqual(await readTree(workspace), { ...before, "api.h": header("new_value") });
  });

await test("a delivered batch plans from its private buffer before a peer leaves a partial rename", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/private-batch-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const before = {
    "part.h": "#pragma once\nstruct Box { int First; int Second; int Third; };\n",
    "main.cpp":
      '#include "part.h"\nint value(Box box) { return box.First + box.Second + box.Third; }\n',
  };
  const tasks = ["First", "Second", "Third"].map((name) => ({
    id: name,
    operations: [
      {
        phase: "names",
        category: "fields",
        mapping: [{ from: name, to: name.toLowerCase() }],
        selectors: [{ kind: "record", scope: "Box" }],
      },
    ],
  }));
  let executor;
  try {
    await writeTree(workspace, before);
    await prepareConcurrentExecutor(tools);
    const workerFile = path.join(tools, "reference/full-worker.mjs");
    const source = await readFile(workerFile, "utf8");
    const publication = 'event("publish-end");';
    assert.ok(source.includes(publication));
    // A deterministic ordinary peer write restores only the first declaration
    // after its uses were renamed. No production pause or coordination is added.
    await writeFile(
      workerFile,
      source.replace(
        publication,
        publication +
          `
      if (task.id === "First" && !globalThis.restoredDeclaration) {
        globalThis.restoredDeclaration = true;
        const header = path.join(workspace, "part.h");
        writeFileSync(header, readFileSync(header, "utf8").replace("int first;", "int First;"));
      }
    `,
      ),
    );
    executor = concurrentExecutor(workspace, tools);
    await executor.ready;
    const receipts = await executor.executeBatch(tasks);
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every((receipt) => receipt.status === "edited"));
    assert.equal(receipts.at(-1).planner.snapshotAttempts, 1);
    const intermediate = await readTree(workspace);
    assert.match(intermediate["part.h"], /int First; int second; int third;/);
    assert.match(intermediate["main.cpp"], /box.first \+ box.second \+ box.third/);
    const correction = await executor.execute(tasks[0]);
    assert.equal(correction.lifetime, receipts[0].lifetime);
    assert.equal(correction.status, "edited");
    const expected = Object.fromEntries(
      Object.entries(before).map(([file, text]) => [
        file,
        text
          .replaceAll("First", "first")
          .replaceAll("Second", "second")
          .replaceAll("Third", "third"),
      ]),
    );
    assert.deepEqual(await readTree(workspace), expected);
  } finally {
    await executor?.close();
    await rm(root, { recursive: true, force: true });
  }
});
for (const correctionFirst of [true, false])
  await test(`a source-blocked delivery publishes only its requested retained correction (${correctionFirst ? "correction first" : "new atom first"})`, async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/source-blocked-delivery-"));
    const workspace = path.join(root, "workspace"),
      tools = path.join(root, "executor");
    const before = {
      "part.h": "#pragma once\nstruct Box { int First; int Second; int Third; };\n",
      "main.cpp":
        '#include "part.h"\nint value(Box box) { return box.First + box.Second + box.Third; }\n',
    };
    const task = (name) => ({
      id: name,
      operations: [
        {
          phase: "names",
          category: "fields",
          mapping: [{ from: name, to: name.toLowerCase() }],
          selectors: [{ kind: "record", scope: "Box" }],
        },
      ],
    });
    let first, second;
    try {
      await writeTree(workspace, before);
      await prepareConcurrentExecutor(tools);
      first = concurrentExecutor(workspace, tools);
      second = concurrentExecutor(workspace, tools);
      await Promise.all([first.ready, second.ready]);
      const firstReceipt = await first.execute(task("First"));
      const secondReceipt = await second.execute(task("Third"));
      const header = path.join(workspace, "part.h");
      await writeFile(
        header,
        (await readFile(header, "utf8"))
          .replace("int first;", "int First;")
          .replace("int third;", "int Third;"),
      );
      const ids = correctionFirst ? ["Third", "Second"] : ["Second", "Third"];
      const receipts = await second.executeBatch(ids.map(task));
      assert.deepEqual(
        receipts.map((receipt) => receipt.id),
        ids,
      );
      const correction = receipts.find((receipt) => receipt.id === "Third");
      const blocked = receipts.find((receipt) => receipt.id === "Second");
      assert.equal(correction.status, "edited");
      assert.equal(correction.lifetime, secondReceipt.lifetime);
      assert.equal(blocked.status, "conflict");
      assert.equal(blocked.sourceFailure.task, "Second");
      assert.match(blocked.sourceFailure.message, /Compiler AST failed:/);
      assert.equal(blocked.sourceFailure.exitCode, 1);
      assert.equal(blocked.sourceFailure.signal, null);
      assert.deepEqual(blocked.written, []);
      assert.equal(blocked.attempts, 0);
      const intermediate = await readTree(workspace);
      assert.match(intermediate["part.h"], /int First; int Second; int third;/);
      assert.match(intermediate["main.cpp"], /box.first \+ box.Second \+ box.third/);
      assert.throws(() =>
        execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(workspace, "main.cpp")], {
          stdio: "pipe",
        }),
      );
      const peerCorrection = await first.execute(task("First"));
      assert.equal(peerCorrection.lifetime, firstReceipt.lifetime);
      const fresh = await second.execute(task("Second"));
      assert.equal(fresh.status, "edited");
      assert.equal(fresh.lifetime, secondReceipt.lifetime);
      assert.equal(fresh.sourceFailure, undefined);
      assert.ok(fresh.events.some((event) => event.phase === "plan-start"));
      const expected = Object.fromEntries(
        Object.entries(before).map(([file, source]) => [
          file,
          source
            .replaceAll("First", "first")
            .replaceAll("Second", "second")
            .replaceAll("Third", "third"),
        ]),
      );
      assert.deepEqual(await readTree(workspace), expected);
      execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(workspace, "main.cpp")], {
        stdio: "pipe",
      });
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });

await test("a new executor defers invalid shared source and can later observe an already applied request", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/cold-source-repair-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const initial = {
    "part.h": "#pragma once\nstruct Box { int first; };\n",
    "main.cpp": '#include "part.h"\nint value(Box box) { return box.First; }\n',
  };
  const task = {
    id: "First",
    operations: [
      {
        phase: "names",
        category: "fields",
        mapping: [{ from: "First", to: "first" }],
        selectors: [{ kind: "record", scope: "Box" }],
      },
    ],
  };
  let worker;
  try {
    await writeTree(workspace, initial);
    await prepareConcurrentExecutor(tools);
    worker = concurrentExecutor(workspace, tools);
    const blocked = await worker.execute(task);
    assert.equal(blocked.status, "conflict");
    assert.equal(blocked.sourceFailure.exitCode, 1);
    assert.deepEqual(blocked.written, []);
    assert.deepEqual(await readTree(workspace), initial);
    const repaired = {
      ...initial,
      "main.cpp": initial["main.cpp"].replace("box.First", "box.first"),
    };
    await writeFile(path.join(workspace, "main.cpp"), repaired["main.cpp"]);
    const observed = await worker.execute(task);
    assert.equal(observed.status, "edited");
    assert.deepEqual(observed.written, []);
    assert.deepEqual(await readTree(workspace), repaired);
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("source conflicts never plan from an old owner binding or earn writes after six retries", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/reject-old-binding-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const field = (id, scope) => ({
    id,
    operations: [
      {
        phase: "names",
        category: "fields",
        mapping: [{ from: id, to: id.toLowerCase() }],
        selectors: [{ kind: "record", scope }],
      },
    ],
  });
  let worker;
  try {
    await writeTree(workspace, {
      "part.h": "#pragma once\nstruct Box { int First; int Third; };\n",
      "main.cpp":
        '#include "part.h"\nint value(Box box) { return box.First + box.Third; }\nnamespace alpha { struct Owner { int Legacy; }; }\nnamespace beta { struct Owner { int Legacy; }; }\nint alias(alpha::Owner owner) { return owner.Legacy; }\n',
    });
    await prepareConcurrentExecutor(tools);
    worker = concurrentExecutor(workspace, tools);
    await worker.ready;
    await worker.execute(field("Third", "Box"));
    const changed = await readTree(workspace);
    changed["part.h"] = changed["part.h"].replace("int First;", "int first;");
    changed["main.cpp"] = changed["main.cpp"].replace("alpha::Owner owner", "beta::Owner owner");
    await Promise.all(
      Object.entries(changed).map(([file, source]) =>
        writeFile(path.join(workspace, file), source),
      ),
    );
    for (let attempt = 1; attempt <= 6; attempt++) {
      const blocked = await worker.execute(field("Legacy", "alpha::Owner"));
      assert.equal(blocked.status, "conflict");
      assert.match(blocked.sourceFailure.message, /Compiler AST failed:/);
      assert.deepEqual(blocked.written, []);
      assert.deepEqual(await readTree(workspace), changed);
    }
    await writeFile(
      path.join(workspace, "part.h"),
      changed["part.h"].replace("int first;", "int First;"),
    );
    assert.equal((await worker.execute(field("Legacy", "alpha::Owner"))).status, "edited");
    const current = await readTree(workspace);
    assert.match(current["main.cpp"], /namespace alpha \{ struct Owner \{ int legacy; \}; \}/);
    assert.match(current["main.cpp"], /namespace beta \{ struct Owner \{ int Legacy; \}; \}/);
    assert.match(current["main.cpp"], /int alias\(beta::Owner owner\) \{ return owner.Legacy; \}/);
    execFileSync("clang++", ["-std=c++17", "-fsyntax-only", path.join(workspace, "main.cpp")], {
      stdio: "pipe",
    });
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});
await test(
  "reference workers keep the first request sent immediately at startup",
  { timeout: 30_000 },
  async (t) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/concurrent-startup-"));
    const tools = path.join(root, "executor");
    const workers = [];
    try {
      await prepareConcurrentExecutor(tools);
      const workerFile = path.join(tools, "reference/full-worker.mjs");
      const source = await readFile(workerFile, "utf8");
      const initialization =
        'const analysis = await mkdtemp(path.join(tmpdir(), "current-analysis-"));';
      assert.ok(source.includes(initialization));
      // Slow real startup without replacing any filesystem or stream implementation.
      await writeFile(
        workerFile,
        source.replace(
          initialization,
          `await new Promise((resolve) => setTimeout(resolve, 100)); ${initialization}`,
        ),
      );
      const input = {
        "main.cpp": "int FnRun() { return 1; } int main() { return FnRun() - 1; }\n",
      };
      const workspaces = await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const workspace = path.join(root, `workspace-${index}`);
          await writeTree(workspace, input);
          return workspace;
        }),
      );
      await Promise.all(
        workspaces.map(async (workspace) => {
          const executor = concurrentExecutor(workspace, tools, { signal: t.signal });
          workers.push(executor);
          const receipt = await executor.execute({
            id: "first-request",
            operations: [
              {
                id: "rename",
                phase: "names",
                category: "functions-types",
                mapping: [{ from: "FnRun", to: "run" }],
                selectors: [{ kind: "function", scope: "FnRun" }],
              },
            ],
          });
          assert.equal(receipt.delivered, 1);
          assert.deepEqual(await readTree(workspace), {
            "main.cpp": input["main.cpp"].replaceAll("FnRun", "run"),
          });
        }),
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
await test("global current-owner renames cross real translation units without merging equal private helpers or skipping missing owners", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/concurrent-units-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const before = {
    "frond_api.h":
      "#pragma once\nnamespace frond { struct Box { int value; }; int FnRun(const Box&); int other(const Box&); }\n",
    "frond_a.cpp":
      '#include "frond_api.h"\nnamespace frond { static const int limit = 2; static int helper(int x) { return x + limit; } int FnRun(const Box& b) { return helper(b.value); } }\n',
    "frond_b.cpp":
      '#include "frond_api.h"\nnamespace frond { static const int limit = 3; static int helper(int x) { return x + limit; } int other(const Box& b) { return FnRun(b) + helper(b.value); } }\n',
    "main.cpp":
      '#include "frond_api.h"\nint main() { frond::Box b{1}; return frond::other(b) == 7 ? 0 : 1; }\n',
  };
  let executor;
  try {
    await writeTree(workspace, before);
    const files = Object.keys(before)
      .filter((file) => file.endsWith(".cpp"))
      .map((file) => path.join(workspace, file));
    const program = path.join(root, "program");
    execFileSync("clang++", ["-std=c++17", ...files, "-o", program]);
    execFileSync(program);
    await prepareConcurrentExecutor(tools);
    executor = concurrentExecutor(workspace, tools);
    const receipt = await executor.execute({
      id: "global",
      operations: [
        {
          id: "function",
          phase: "names",
          category: "functions-types",
          mapping: [{ from: "FnRun", to: "run" }],
          selectors: [{ kind: "function", scope: "frond::FnRun" }],
        },
        {
          id: "type",
          phase: "names",
          category: "functions-types",
          mapping: [{ from: "Box", to: "Item" }],
          selectors: [{ kind: "type", scope: "frond::Box" }],
        },
      ],
    });
    const renamed = await readTree(workspace);
    const expected = Object.fromEntries(
      Object.entries(before).map(([file, text]) => [
        file,
        text.replaceAll("FnRun", "run").replaceAll("Box", "Item"),
      ]),
    );
    assert.deepEqual(renamed, expected);
    assert.equal(receipt.committed, treeIdentity(renamed));
    const local = await executor.execute({
      id: "local",
      operations: [
        {
          id: "parameter",
          phase: "names",
          category: "locals-parameters",
          mapping: [{ from: "b", to: "item" }],
          selectors: [
            {
              kind: "function",
              scope: "frond::run",
              signature: "int (const Item &)",
              definition: true,
            },
          ],
        },
      ],
    });
    assert.equal(local.lifetime, receipt.lifetime);
    assert.equal(local.delivered, 2);
    assert.ok(
      !(await readdir(workspace)).some((name) => /^\.renderer-(?:planner-|edit-lock)/.test(name)),
      "An edit receipt must include completion of owned resource cleanup",
    );
    const final = await readTree(workspace);
    assert.equal(
      final["frond_a.cpp"],
      expected["frond_a.cpp"]
        .replace("const Item& b", "const Item& item")
        .replace("helper(b.value)", "helper(item.value)"),
    );
    assert.equal(final["frond_b.cpp"], expected["frond_b.cpp"]);
    execFileSync("clang++", ["-std=c++17", ...files, "-o", program]);
    execFileSync(program);
    await assert.rejects(
      executor.execute({
        id: "absent",
        operations: [
          {
            id: "missing",
            phase: "names",
            category: "functions-types",
            mapping: [{ from: "run", to: "changed" }],
            selectors: [{ kind: "function", scope: "frond::does_not_exist" }],
          },
        ],
      }),
      /Missing current owner/,
    );
    assert.deepEqual(await readTree(workspace), final);
  } finally {
    await executor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("an original delivery replans its stale binding after a peer changes file structure", async (t) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/original-stale-plan-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  const original = "int Old() { return 1; }\n";
  const peer = "int peer() { return 2; }\n";
  let executor;
  t.after(async () => {
    await executor?.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeTree(workspace, { "main.cpp": original });
  await prepareConcurrentExecutor(tools);
  const workerFile = path.join(tools, "reference/full-worker.mjs");
  const source = await readFile(workerFile, "utf8");
  const publication = 'event("publish-start");';
  assert.equal(source.split(publication).length, 2);
  await writeFile(
    workerFile,
    source.replace(
      publication,
      publication +
        `
    if (!globalThis.peerStructurePublished) {
      globalThis.peerStructurePublished = true;
      const file = path.join(workspace, "main.cpp");
      writeFileSync(file, ${JSON.stringify(peer)} + readFileSync(file, "utf8"));
    }
  `,
    ),
  );
  executor = concurrentExecutor(workspace, tools, { signal: t.signal });
  const receipt = await executor.execute({
    id: "original-function-name",
    operations: [
      {
        phase: "names",
        category: "functions-types",
        mapping: [{ from: "Old", to: "renamed" }],
        selectors: [{ kind: "function", scope: "Old" }],
      },
    ],
  });
  assert.equal(receipt.status, "edited");
  assert.equal(receipt.delivered, 1);
  assert.equal(receipt.id, "original-function-name");
  assert.equal(receipt.conflicts, 0);
  assert.deepEqual(await readTree(workspace), {
    "main.cpp": peer + "int renamed() { return 1; }\n",
  });
});
