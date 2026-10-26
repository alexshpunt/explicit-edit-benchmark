import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  concurrentExecutor,
  prepareConcurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import { publishEdits } from "../../src/suites/explicit-edit-multi-agent/reference/ordinary-edit.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import {
  REFERENCE_EXECUTION_POLICY,
  referenceConcurrency,
  referenceFirstPass,
  validateReferenceExecution,
} from "../../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";

await mkdir(".tmp", { recursive: true });

test(
  "fifteen independent isolated compilers overlap on one shared source",
  { timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/independent-reference-"));
    const workspace = path.join(root, "workspace");
    const tools = path.join(root, "tools");
    const workers = [];
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
      for (let i = 0; i < 15; i++)
        workers.push(concurrentExecutor(workspace, tools, { signal: t.signal }));
      await Promise.all(workers.map((worker) => worker.ready));
      const receipts = await Promise.all(
        workers.map((worker, i) =>
          worker.execute({
            id: `edit-${i}`,
            operations: [
              {
                id: `name-${i}`,
                phase: "names",
                category: "functions-types",
                mapping: [{ from: `Fn${i}`, to: `run${i}` }],
                selectors: [{ kind: "function", scope: `Fn${i}` }],
              },
            ],
          }),
        ),
      );
      const observed = referenceConcurrency(receipts.map((receipt) => ({ receipts: [receipt] })));
      console.log(
        JSON.stringify({
          observed,
          edits: receipts.map(({ id, status, conflicts, written }) => ({
            id,
            status,
            conflicts,
            written,
          })),
        }),
      );
      assert.equal(observed.executors, 15);
      assert.equal(observed.maxWorking, 15);
      assert.ok(observed.maxPlanning > 1, JSON.stringify(observed));
      // All fifteen original requests must survive their first deliveries.
      // The separate paused-publisher test checks the file-level critical section.
      assert.ok(receipts.every((receipt) => receipt.status === "edited"));
      const expected = original.replace(/Fn(\d+)/g, "run$1");
      assert.equal(await readFile(path.join(workspace, "main.cpp"), "utf8"), expected);
      assert.deepEqual(await readdir(workspace), ["main.cpp"]);
      await Promise.all(workers.map((worker) => worker.close()));
      assert.deepEqual((await readdir(root)).sort(), ["tools", "workspace"]);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a current actor can remove a prototype restored after its earlier no-op", async () => {
  const root = await mkdtemp(path.resolve(".tmp/current-cleanup-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  let worker;
  const definition = "namespace frond { int helper(int value) { return value; } }\n";
  const header = "namespace frond { int helper(int value); }\n";
  const task = {
    id: "cleanup",
    operations: [
      {
        phase: "structure",
        action: "remove-generated-declaration",
        file: "main.cpp",
        selector: { scope: "frond", declarator: "inthelper(intvalue)", definition: false },
      },
    ],
  };
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "main.cpp"), definition);
    await writeFile(path.join(workspace, "public.h"), header);
    await prepareConcurrentExecutor(tools);
    worker = concurrentExecutor(workspace, tools);
    await worker.ready;
    const first = await worker.execute(task);
    assert.deepEqual(first.written, []);
    await writeFile(
      path.join(workspace, "main.cpp"),
      "namespace frond { int helper(int value); }\n" + definition,
    );
    const correction = await worker.execute(task);
    assert.equal(correction.lifetime, first.lifetime);
    assert.deepEqual(correction.written, ["main.cpp"]);
    assert.equal(await readFile(path.join(workspace, "public.h"), "utf8"), header);
    const source = await readFile(path.join(workspace, "main.cpp"), "utf8");
    assert.ok(source.includes(definition));
    assert.ok(!source.includes("int helper(int value);"));
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a cleanup correction replans its own prototype after a peer removes the adjacent prototype", async () => {
  const root = await mkdtemp(path.resolve(".tmp/replan-cleanup-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  let worker;
  const own = "int helper(int value);",
    peer = "int neighbor(int value);";
  const definition = "int helper(int value) { return value; }";
  const source = (declarations) => `namespace frond { ${declarations} ${definition} }\n`;
  const task = {
    id: "cleanup",
    operations: [
      {
        phase: "structure",
        action: "remove-generated-declaration",
        file: "main.cpp",
        selector: { scope: "frond", declarator: "inthelper(intvalue)", definition: false },
      },
    ],
  };
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "main.cpp"), source(own + " " + peer));
    await prepareConcurrentExecutor(tools);
    worker = concurrentExecutor(workspace, tools);
    await worker.ready;
    await worker.execute(task);
    await writeFile(path.join(workspace, "main.cpp"), `namespace frond { ${own} }\n`);
    await writeFile(path.join(workspace, "moved.cpp"), definition);
    const correction = await worker.execute(task);
    assert.equal(correction.status, "edited");
    assert.ok(
      correction.events.some((event) => event.phase === "plan-start"),
      "Cleanup corrections must select from the current source",
    );
    const actual = await readFile(path.join(workspace, "main.cpp"), "utf8");
    assert.ok(!actual.includes(own));
    assert.ok(!actual.includes(peer));
    assert.ok(!actual.includes(definition));
    assert.equal(await readFile(path.join(workspace, "moved.cpp"), "utf8"), definition);
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a reference move uses only public selectors, not preparation-only placement anchors", async () => {
  const root = await mkdtemp(path.resolve(".tmp/public-reference-move-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  let worker;
  try {
    await mkdir(workspace);
    await writeFile(
      path.join(workspace, "main.cpp"),
      '#include "part.h"\nnamespace sample { int helper(int value) { return value + 1; } }\n',
    );
    await writeFile(
      path.join(workspace, "part.h"),
      "#pragma once\nnamespace sample { int public_api(int value); }\n",
    );
    await prepareConcurrentExecutor(tools);
    worker = concurrentExecutor(workspace, tools);
    const receipt = await worker.execute({
      id: "move",
      operations: [
        {
          phase: "structure",
          action: "implementation",
          file: "part.cpp",
          includes: [{ file: "part.h", quoted: true }],
          targets: [
            {
              selector: {
                kind: "function",
                scope: "sample",
                declarator: "inthelper(intvalue)",
                definition: true,
              },
              context: [],
              before: { scope: "sample", declarator: "intmissing()" },
            },
          ],
        },
      ],
    });
    assert.equal(receipt.status, "edited");
    assert.ok(
      (await readFile(path.join(workspace, "part.cpp"), "utf8")).includes(
        "int helper(int value) { return value + 1; }",
      ),
    );
    assert.ok(!(await readFile(path.join(workspace, "main.cpp"), "utf8")).includes("int helper("));
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("ordinary publication exposes intermediate multi-file state and does not protect against a racing writer", async () => {
  const root = await mkdtemp(path.resolve(".tmp/ordinary-publication-"));
  const before = { "main.cpp": "int First;\n", "part.h": "int Second;\n" };
  try {
    for (const [file, text] of Object.entries(before)) await writeFile(path.join(root, file), text);
    let intermediate = false;
    publishEdits(
      root,
      before,
      { "main.cpp": "int Renamed;\n", "part.h": "int Updated;\n" },
      {
        onEvent(phase, file) {
          if (phase === "write-start" && file === "main.cpp")
            writeFileSync(path.join(root, file), "int Peer;\n");
          if (phase === "write-end" && file === "main.cpp") {
            intermediate = readFileSync(path.join(root, "part.h"), "utf8") === before["part.h"];
          }
        },
      },
    );
    assert.ok(intermediate);
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), "int Renamed;\n");
    assert.notEqual(
      await readFile(path.join(root, "main.cpp"), "utf8"),
      "int Peer;\n",
      "No lock or conditional commit protects the peer write",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "atomic publishers preserve both requested changes on the same file",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/uncoordinated-processes-"));
    const module = new URL(
      "../../src/suites/explicit-edit-multi-agent/reference/ordinary-edit.mjs",
      import.meta.url,
    ).href;
    const original = "int first() { return 1; } int second() { return 2; }\n";
    const children = [];
    const launch = (name, paused) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import {publishEdits} from ${JSON.stringify(module)};
import {execFileSync} from 'node:child_process';
const before={'main.cpp':${JSON.stringify(original)}};
const after={'main.cpp':before['main.cpp'].replace(${JSON.stringify(name)}, ${JSON.stringify(name + "_changed")})};
publishEdits(${JSON.stringify(root)}, before, after, {onEvent(phase) {
  if (${paused} && phase==='write-start') {
    console.log('publisher-paused');
    execFileSync('python3', ['-c', 'import sys; sys.stdin.buffer.read(1)'], {stdio:['inherit','ignore','pipe']});
  }
}});
`,
        ],
        { signal: t.signal },
      );
      children.push(child);
      let output = "",
        errors = "";
      const ready = Promise.withResolvers();
      child.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.includes("publisher-paused")) ready.resolve();
      });
      child.stderr.on("data", (bytes) => {
        errors += bytes;
      });
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(Error(errors || `Publisher exited ${code}`)),
        );
      });
      return { child, ready: ready.promise, done };
    };
    try {
      await writeFile(path.join(root, "main.cpp"), original);
      const first = launch("first", true);
      await Promise.race([
        first.ready,
        first.done.then(() => {
          throw Error("Publisher never paused");
        }),
      ]);
      const second = launch("second", false);
      first.child.stdin.end("resume");
      await Promise.all([first.done, second.done]);
      const actual = { "main.cpp": await readFile(path.join(root, "main.cpp"), "utf8") };
      assert.ok(actual["main.cpp"].includes("first_changed"));
      assert.ok(actual["main.cpp"].includes("second_changed"));
      const expected = {
        "main.cpp": original.replace("first", "first_changed").replace("second", "second_changed"),
      };
      assert.equal(
        evaluateCoherentContract(actual, prepareCoherentContract(expected)).status,
        "pass",
      );
    } finally {
      for (const child of children) {
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("the unchanged full grader rejects a peer edit lost to an ordinary racing publication", async () => {
  const root = await mkdtemp(path.resolve(".tmp/lost-reference-edit-"));
  const original = "int first() { return 1; } int second() { return 2; }\n";
  const own = original.replace("first", "renamed");
  const peer = original.replace("second", "retained");
  const expected = { "main.cpp": own.replace("second", "retained") };
  try {
    await writeFile(path.join(root, "main.cpp"), original);
    publishEdits(
      root,
      { "main.cpp": original },
      { "main.cpp": own },
      {
        onEvent(phase) {
          if (phase === "write-start") writeFileSync(path.join(root, "main.cpp"), peer);
        },
      },
    );
    const actual = { "main.cpp": await readFile(path.join(root, "main.cpp"), "utf8") };
    assert.equal(
      evaluateCoherentContract(expected, prepareCoherentContract(expected)).status,
      "pass",
    );
    assert.equal(
      evaluateCoherentContract(actual, prepareCoherentContract(expected)).status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "racing ordinary replacements leave one complete file version, not mixed tails",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.resolve(".tmp/complete-file-race-"));
    const original = "int original() { return 0; }\n";
    const versions = Array.from(
      { length: 15 },
      (_, i) =>
        "//" + String(i % 10).repeat((i + 1) * 131072) + `\nint result${i}() { return ${i}; }\n`,
    );
    const module = new URL(
      "../../src/suites/explicit-edit-multi-agent/reference/ordinary-edit.mjs",
      import.meta.url,
    ).href;
    const code = `import {publishEdits} from ${JSON.stringify(module)};
import {readSync} from 'node:fs';
const i=Number(process.argv[2]);
const after='//'+String(i%10).repeat((i+1)*131072)+'\\nint result'+i+'() { return '+i+'; }\\n';
publishEdits(process.argv[1], {'main.cpp': ${JSON.stringify(original)}}, {'main.cpp': after}, {onEvent(phase){
if(phase==='publish-ready'){console.log('ready');readSync(0,Buffer.alloc(1),0,1,null);}
}});`;
    const children = [];
    try {
      for (let round = 0; round < 3; round++) {
        await writeFile(path.join(root, "main.cpp"), original);
        const executions = versions.map((_, i) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", code, root, String(i)],
            { signal: t.signal, stdio: ["pipe", "pipe", "pipe"] },
          );
          children.push(child);
          const ready = Promise.withResolvers();
          child.stdout.once("data", () => ready.resolve());
          const closed = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (exitCode) => {
              if (exitCode !== 0) {
                const error = Error(`File writer exited ${exitCode}`);
                ready.reject(error);
                reject(error);
              } else resolve();
            });
          });
          return { child, ready: ready.promise, closed };
        });
        await Promise.all(executions.map((execution) => execution.ready));
        for (const { child } of executions) child.stdin.end("x");
        await Promise.all(executions.map((execution) => execution.closed));
        const actual = await readFile(path.join(root, "main.cpp"), "utf8");
        assert.ok(
          versions.includes(actual),
          "Concurrent publication mixed different complete versions",
        );
        assert.deepEqual(await readdir(root), ["main.cpp"]);
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("an unambiguous local deletion preserves peer changes without a whole-file merge process", async () => {
  const root = await mkdtemp(path.resolve(".tmp/local-removal-"));
  const before = {
    "main.cpp": "namespace sample { int temporary(int value); int kept() { return 1; } }\n",
  };
  const after = { "main.cpp": before["main.cpp"].replace("int temporary(int value);", "") };
  const current = before["main.cpp"].replace("return 1", "return 2");
  try {
    await writeFile(path.join(root, "main.cpp"), current);
    const originalPath = process.env.PATH;
    let result;
    try {
      process.env.PATH = root;
      result = publishEdits(root, before, after);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    assert.deepEqual(result.conflicts, []);
    assert.equal(
      await readFile(path.join(root, "main.cpp"), "utf8"),
      current.replace("int temporary(int value);", ""),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a formerly ambiguous replacement cannot select the sole unrelated surviving spelling", async () => {
  const root = await mkdtemp(path.resolve(".tmp/ambiguous-local-change-"));
  const first = "int first(int old) { return 1; } ";
  const current = "int second(int old) { return 2; }\n";
  const before = { "main.cpp": first + current };
  const after = { "main.cpp": before["main.cpp"].replace("int old", "int renamed") };
  try {
    await writeFile(path.join(root, "main.cpp"), current);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = root;
      assert.deepEqual(publishEdits(root, before, after), {
        written: [],
        conflicts: ["main.cpp"],
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent suffix additions retain peer additions without duplicating an earlier own addition", async () => {
  const root = await mkdtemp(path.resolve(".tmp/local-append-"));
  const base = "namespace sample { int first() { return 1; } }\n";
  const own = "namespace sample { int own() { return 2; } }\n";
  const peer = "namespace sample { int peer() { return 3; } }\n";
  try {
    await writeFile(path.join(root, "main.cpp"), base + peer);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = publishEdits(root, { "main.cpp": base }, { "main.cpp": base + own });
      assert.deepEqual(result.conflicts, []);
      assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), base + peer + own);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("retained identifier sites preserve adjacent peer renames and recognize already-applied uses", async () => {
  const root = await mkdtemp(path.resolve(".tmp/adjacent-names-"));
  const before = {
    "main.cpp":
      "struct Box { int First; int Second; }; int use(Box box) { return box.First + box.Second; }\n",
  };
  const after = { "main.cpp": before["main.cpp"].replaceAll("First", "first") };
  try {
    const current = before["main.cpp"]
      .replaceAll("Second", "second")
      .replace("box.First", "box.first");
    await writeFile(path.join(root, "main.cpp"), current);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = root;
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(publishEdits(root, before, after).conflicts, []);
        assert.equal(
          await readFile(path.join(root, "main.cpp"), "utf8"),
          current.replace("int First", "int first"),
        );
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const { name, before, after, current } of [
  {
    name: "a peer punctuation change cannot rebind a retained field rename to a global",
    before:
      "int First = 1; int first = 2; struct Box { int First; }; int use(Box box) { return box.First; }\n",
    after:
      "int First = 1; int first = 2; struct Box { int first; }; int use(Box box) { return box.first; }\n",
    current:
      "int First = 1; int first = 2; struct Box { int First; }; int use(Box box) { return box, First; }\n",
  },
  {
    name: "a changed preprocessor condition invalidates retained identifier sites",
    before: "#if 1\nint First;\n#else\nint First;\n#endif\nint use() { return First; }\n",
    after: "#if 1\nint first;\n#else\nint First;\n#endif\nint use() { return first; }\n",
    current: "#if 0\nint First;\n#else\nint First;\n#endif\nint use() { return First; }\n",
  },
  {
    name: "a retained single-site rename cannot alter a fragment of an unknown identifier",
    before: "int First;\n",
    after: "int first;\n",
    current: "int OtherFirst;\n",
  },
  {
    name: "a retained function rename cannot target a new function-pointer variable",
    before: "int old();\n",
    after: "int renamed();\n",
    current: "int (*old)();\n",
  },
]) {
  test(name, async () => {
    const root = await mkdtemp(path.resolve(".tmp/changed-rename-context-"));
    try {
      await writeFile(path.join(root, "main.cpp"), current);
      const result = publishEdits(root, { "main.cpp": before }, { "main.cpp": after });
      assert.deepEqual(result.conflicts, ["main.cpp"]);
      assert.deepEqual(result.written, []);
      assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), current);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
test("unknown text at a retained rename site cannot be treated as an already-applied spelling", async () => {
  const root = await mkdtemp(path.resolve(".tmp/unknown-rename-site-"));
  const before = {
    "main.cpp": "struct Box { int First; }; int use(Box box) { return box.First; }\n",
  };
  const after = { "main.cpp": before["main.cpp"].replaceAll("First", "first") };
  const current = before["main.cpp"].replace("int First", "int unrelated");
  try {
    await writeFile(path.join(root, "main.cpp"), current);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = root;
      assert.deepEqual(publishEdits(root, before, after), {
        written: [],
        conflicts: ["main.cpp"],
      });
      assert.equal(await readFile(path.join(root, "main.cpp"), "utf8"), current);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an ordinary local merge preserves a disjoint peer rename on the same C++ line", async () => {
  const root = await mkdtemp(path.resolve(".tmp/ordinary-merge-"));
  try {
    const before = {
      "main.cpp": "int first(int old) { return old; } int second(int peer) { return peer; }\n",
    };
    const after = { "main.cpp": before["main.cpp"].replaceAll("old", "current") };
    await writeFile(path.join(root, "main.cpp"), before["main.cpp"].replaceAll("peer", "kept"));
    const result = publishEdits(root, before, after);
    assert.deepEqual(result.conflicts, []);
    assert.equal(
      await readFile(path.join(root, "main.cpp"), "utf8"),
      after["main.cpp"].replaceAll("peer", "kept"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buffered atom intervals count distinct active executors, including nested work", () => {
  const receipt = (lifetime, start, end) => ({
    lifetime,
    events: [
      { phase: "execute-start", at: start },
      { phase: "execute-end", at: end },
    ],
  });
  const observed = referenceConcurrency([
    { receipts: [receipt("first", 0, 20), receipt("first", 1, 5), receipt("second", 10, 15)] },
  ]);
  assert.equal(observed.maxWorking, 2);
  assert.equal(observed.workIntervals, 3);
});
test("protected, serialized and identity-only historical proofs cannot authorize measured runs", () => {
  const proof = {
    acceptedRounds: 1,
    acceptedAtomicEdits: 1,
    repairs: 0,
    referenceFirstPass: referenceFirstPass({
      acceptedRounds: 1,
      totalRounds: 1,
      repairs: 0,
      atomicBarriers: [{ round: "round-001", attempt: 1, status: "accepted" }],
      checks: [
        { contractId: "initial", status: "pass" },
        { contractId: "round-001", status: "pass" },
      ],
      executions: [{ attempt: 1, status: "settled", atomicIds: ["atom-1"] }],
    }),
    referenceExecution: REFERENCE_EXECUTION_POLICY,
    referenceConcurrency: {
      executors: 15,
      maxWorking: 15,
      maxPlanning: 15,
      maxPublishing: 2,
      workIntervals: 15,
      planningIntervals: 15,
      publicationIntervals: 15,
    },
  };
  validateReferenceExecution(proof, 15);
  assert.throws(() => validateReferenceExecution({ agents: 15, status: "pass" }, 15));
  for (const field of ["maxWorking", "maxPlanning", "maxPublishing"])
    assert.throws(() =>
      validateReferenceExecution(
        { ...proof, referenceConcurrency: { ...proof.referenceConcurrency, [field]: 1 } },
        15,
      ),
    );
});
