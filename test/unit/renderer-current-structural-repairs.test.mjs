import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  readTree,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  prepareConcurrentExecutor,
  concurrentExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/concurrent-executor.mjs";
import {
  applyCoherentStructure,
  applyCurrentStructure,
} from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

async function fixture(t, initial) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/current-structural-repair-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "tools");
  await writeTree(workspace, initial);
  await prepareConcurrentExecutor(tools);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace,
    read: () => readTree(workspace),
    async run(operation) {
      // Every request opens a new isolated executor with no prior edit history.
      const executor = concurrentExecutor(workspace, tools, { signal: t.signal });
      try {
        return await executor.execute({
          id: operation.id ?? operation.action,
          operations: [operation],
        });
      } finally {
        await executor.close();
      }
    },
  };
}

const initialModule = {
  "api.h": "namespace sample { int picked(int value); int later(int value); }\n",
  "main.cpp":
    '#include "api.h"\nnamespace sample {\nint picked(int value) { return value + 1; }\nint later(int value) { return value + 2; }\nint peer() { return 9; }\n}\n',
};
const target = (name) => ({
  selector: { scope: "sample", declarator: `int${name}(intvalue)`, definition: true },
  context: [],
});
const move = {
  id: "move-picked",
  phase: "structure",
  action: "implementation",
  file: "part.cpp",
  includes: [{ file: "api.h", quoted: true }],
  targets: [target("picked")],
};

test("a fresh executor retries a completed implementation move without its original history", async (t) => {
  const current = await fixture(t, initialModule);
  const expected = applyCoherentStructure(initialModule, move);
  const first = await current.run(move);
  assert.equal(first.status, "edited");
  assert.deepEqual(await current.read(), expected);
  const repeated = await current.run(move);
  assert.notEqual(repeated.lifetime, first.lifetime);
  assert.equal(repeated.delivered, 1);
  assert.equal(repeated.status, "edited");
  assert.deepEqual(repeated.written, []);
  assert.deepEqual(await current.read(), expected);
  assert.throws(() => applyCoherentStructure(expected, move));
});

const semanticMove = {
  ...move,
  targets: [
    {
      ...target("picked"),
      selector: {
        ...target("picked").selector,
        kind: "function",
        name: "picked",
        signature: "int (int)",
      },
    },
  ],
};

for (const resurrected of [false, true])
  test(`a fresh implementation repair preserves renamed parameters (${resurrected ? "resurrected source" : "completed move"})`, async (t) => {
    const moved = applyCoherentStructure(initialModule, semanticMove);
    const expected = {
      ...moved,
      "part.cpp":
        moved["part.cpp"].replaceAll("value", "argument") +
        "\nnamespace sample { int picked(float other) { return (int)other; } }\n",
    };
    const before = resurrected ? { ...expected, "main.cpp": initialModule["main.cpp"] } : expected;
    const current = await fixture(t, before);
    const result = await current.run(semanticMove);
    assert.equal(result.status, "edited");
    assert.deepEqual(result.written, resurrected ? ["main.cpp"] : []);
    assert.deepEqual(await current.read(), expected);
    const wrongSignature = structuredClone(semanticMove);
    wrongSignature.targets[0].selector.signature = "long (int)";
    await assert.rejects(current.run(wrongSignature), (error) => error.constructor === Error);
    assert.deepEqual(await current.read(), expected);
    assert.throws(() => applyCoherentStructure(expected, semanticMove));
  });

test("a fresh implementation repair preserves renamed parameters in an operator", async (t) => {
  const initial = {
    "api.h": "#pragma once\nstruct Box { int value; };\nbool operator==(const Box&, const Box&);\n",
    "main.cpp":
      '#include "api.h"\nbool operator ==(const Box& First, const Box& Second) { return First.value == Second.value; }\nint peer() { return 1; }\n',
  };
  const operation = {
    ...semanticMove,
    targets: [
      {
        selector: {
          kind: "function",
          scope: "::",
          name: "operator==",
          signature: "bool (const Box &, const Box &)",
          definition: true,
          declarator: "booloperator==(constBox&First,constBox&Second)",
        },
        context: [],
      },
    ],
  };
  const moved = applyCoherentStructure(initial, operation);
  const expected = {
    ...moved,
    "part.cpp": moved["part.cpp"].replaceAll("First", "left").replaceAll("Second", "right"),
  };
  const current = await fixture(t, expected);
  const receipt = await current.run(operation);
  assert.equal(receipt.status, "edited");
  assert.deepEqual(receipt.written, []);
  assert.deepEqual(await current.read(), expected);
});

test("a repeated implementation move removes a stale monolith copy and keeps the current destination", async (t) => {
  const current = await fixture(t, initialModule);
  await current.run(move);
  const expected = await current.read();
  await writeFile(path.join(current.workspace, "main.cpp"), initialModule["main.cpp"]);
  const repaired = await current.run(move);
  assert.equal(repaired.status, "edited");
  assert.deepEqual(repaired.written, ["main.cpp"]);
  assert.deepEqual(await current.read(), expected);
});

test("one current implementation request can contain moved and not-yet-moved declarations", async (t) => {
  const current = await fixture(t, initialModule);
  await current.run(move);
  const both = { ...move, id: "move-both", targets: [target("picked"), target("later")] };
  assert.equal((await current.run(both)).status, "edited");
  const actual = await current.read();
  assert.equal(
    evaluateCoherentContract(
      actual,
      prepareCoherentContract(applyCoherentStructure(initialModule, both)),
    ).status,
    "pass",
  );
  assert.equal(actual["main.cpp"].includes("return 9;"), true);
  const repeat = await current.run(both);
  assert.deepEqual(repeat.written, []);
  assert.deepEqual(await current.read(), actual);
});

test("an already-moved wrong body remains a full-barrier failure", async (t) => {
  const expected = applyCoherentStructure(initialModule, move);
  const wrong = {
    ...expected,
    "part.cpp": expected["part.cpp"].replace("return value + 1", "return value + 7"),
  };
  const current = await fixture(t, wrong);
  const result = await current.run(move);
  assert.deepEqual(result.written, []);
  assert.deepEqual(await current.read(), wrong);
  assert.equal(
    evaluateCoherentContract(await current.read(), prepareCoherentContract(expected)).status,
    "fail",
  );
});

test("current implementation moves reject missing and ambiguous destination owners", () => {
  const expected = applyCoherentStructure(initialModule, move);
  const missing = { ...expected };
  delete missing["part.cpp"];
  assert.throws(() => applyCurrentStructure(missing, move));
  const ambiguous = {
    ...expected,
    "part.cpp":
      expected["part.cpp"] + "namespace sample { int picked(int value) { return value + 1; } }\n",
  };
  assert.throws(() => applyCurrentStructure(ambiguous, move));
  assert.throws(() => applyCurrentStructure(expected, { ...move, file: "../part.cpp" }));
});

const vendorFile = "support/stb_image/stb_image_resize.h";
const guard = "STBIR_INCLUDE_STB_IMAGE_RESIZE_H",
  macro = "STB_IMAGE_RESIZE_IMPLEMENTATION";
const declaration = (name) =>
  `#ifndef ${guard}\n#define ${guard}\nint ${name}(int value);\n#endif\n`;
const implementation = (name) =>
  `#ifdef ${macro}\nint ${name}(int value) { return value + 1; }\n#endif\n`;
const vendorInitial = {
  "main.cpp":
    declaration("resize") +
    implementation("discarded") +
    `#define ${macro}\n` +
    declaration("discarded") +
    implementation("resize") +
    "int peer() { return 3; }\n",
};
const vendorHeader = {
  id: "vendor-header",
  phase: "structure",
  action: "vendor-header",
  file: vendorFile,
  guard,
  macro,
  declarationsCopy: 1,
  implementationCopy: 2,
};
const vendorActivation = {
  id: "vendor-implementation",
  phase: "structure",
  action: "vendor-implementation",
  file: "support/stb.cpp",
  macro,
};
const vendorExtracted = () => applyCoherentStructure(vendorInitial, vendorHeader);
const vendorExpected = () => applyCoherentStructure(vendorExtracted(), vendorActivation);

test("fresh executors retry both completed vendor moves without changing source", async (t) => {
  const current = await fixture(t, vendorInitial);
  const headerReceipt = await current.run(vendorHeader);
  const activationReceipt = await current.run(vendorActivation);
  const expected = vendorExpected();
  assert.deepEqual(await current.read(), expected);
  for (const operation of [vendorHeader, vendorActivation]) {
    const repeat = await current.run(operation);
    assert.notEqual(
      repeat.lifetime,
      operation === vendorHeader ? headerReceipt.lifetime : activationReceipt.lifetime,
    );
    assert.equal(repeat.delivered, 1);
    assert.equal(repeat.status, "edited");
    assert.deepEqual(repeat.written, []);
    assert.deepEqual(await current.read(), expected);
  }
  assert.throws(() => applyCoherentStructure(expected, vendorHeader));
  assert.throws(() => applyCoherentStructure(expected, vendorActivation));
});

test("a vendor repair removes resurrected source copies without overwriting peer destination bytes", async (t) => {
  const expected = vendorExpected();
  const current = await fixture(t, { ...expected, "main.cpp": vendorInitial["main.cpp"] });
  const repaired = await current.run(vendorHeader);
  assert.equal(repaired.status, "edited");
  assert.deepEqual(repaired.written, ["main.cpp"]);
  assert.deepEqual(await current.read(), expected);
});

test("vendor repairs finish either side of an interrupted multi-file activation", async (t) => {
  for (const [index, partial] of [
    {
      ...vendorExtracted(),
      [vendorFile]: vendorExpected()[vendorFile],
      "main.cpp": vendorInitial["main.cpp"],
    },
    { "main.cpp": vendorExpected()["main.cpp"], [vendorFile]: vendorExpected()[vendorFile] },
    { ...vendorExpected(), "main.cpp": vendorExtracted()["main.cpp"] },
  ].entries()) {
    await t.test(String(index), async (child) => {
      const current = await fixture(child, partial);
      if (index === 0) await current.run(vendorHeader);
      await current.run(vendorActivation);
      assert.deepEqual(await current.read(), vendorExpected());
    });
  }
});

test("vendor destination bodies remain private barrier obligations", async (t) => {
  const expected = vendorExpected();
  const wrong = {
    ...expected,
    [vendorFile]: expected[vendorFile].replace("return value + 1", "return value + 8"),
  };
  const current = await fixture(t, wrong);
  await current.run(vendorHeader);
  await current.run(vendorActivation);
  assert.deepEqual(await current.read(), wrong);
  assert.equal(
    evaluateCoherentContract(await current.read(), prepareCoherentContract(expected)).status,
    "fail",
  );
  assert.throws(() => applyCurrentStructure(expected, { ...vendorHeader, implementationCopy: 1 }));
  assert.throws(() => applyCurrentStructure({ ...expected, [vendorFile]: "" }, vendorHeader));
  assert.throws(() =>
    applyCurrentStructure({ ...expected, "support/stb.cpp": "" }, vendorActivation),
  );
});

test("current cleanup tolerates an already removed root prototype and a preamble already moved to its module", () => {
  const prototype = {
    action: "remove-generated-declaration",
    selector: { scope: "::", declarator: "intpicked()", definition: false },
  };
  const before = { "main.cpp": "int picked();\nint picked() { return 1; }\n" };
  const after = applyCoherentStructure(before, prototype);
  assert.deepEqual(applyCurrentStructure(after, prototype), after);
  assert.throws(() => applyCoherentStructure(after, prototype));
  const preamble = "#ifdef FEATURE\n#include <vector>\n#endif\n";
  const cleanup = {
    action: "cleanup-empty-namespaces",
    preambleSelectors: [
      { condition: "#ifdef FEATURE", includes: [{ file: "vector", quoted: false }] },
    ],
  };
  const source = {
    "main.cpp": preamble + "int main() { return 0; }\n",
    "part.cpp": preamble + "int peer() { return 2; }\n",
  };
  const cleaned = applyCoherentStructure(source, cleanup);
  assert.deepEqual(applyCurrentStructure(cleaned, cleanup), cleaned);
  assert.throws(() =>
    applyCurrentStructure(cleaned, {
      ...cleanup,
      preambleSelectors: [cleanup.preambleSelectors[0], cleanup.preambleSelectors[0]],
    }),
  );
  assert.throws(() =>
    applyCurrentStructure({ ...cleaned, "part.cpp": "int peer() { return 2; }\n" }, cleanup),
  );
});
