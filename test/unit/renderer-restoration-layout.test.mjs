import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  treeIdentity,
  writeTree,
  compactBlankLines,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { referenceLayoutSteps } from "../../src/suites/explicit-edit-multi-agent/generation/reference-route.mjs";
import {
  restoreFunctionLayout,
  removeGeneratedDeclarations,
} from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-layout.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
await test("the public layout reference preserves neutral branding and compact output through every small transition", () => {
  const data = fixture("yocto");
  const masked = maskOrigin(data.mixed, { name: "frond" });
  const compact = compactBlankLines(masked.tree);
  const manifest = {
    initial: treeIdentity(data.clean),
    final: treeIdentity(compact.tree),
    operations: [data.declaration, data.permutation, masked.record, compact.record],
  };
  const steps = [...referenceLayoutSteps(compact.tree, manifest)];
  assert.equal(steps.length, 6);
  assert.deepEqual(
    steps.map((step) => step.action),
    ["swap-definitions", "swap-definitions", ...Array(4).fill("remove-generated-declaration")],
  );
  for (const step of steps) {
    assert.equal(step.phase, "structure");
    assert.doesNotMatch(JSON.stringify(step.tree), /yocto/i);
    assert.equal(step.tree["main.cpp"].trim(), step.tree["main.cpp"].replace(/\n$/, ""));
    assert.doesNotMatch(step.tree["main.cpp"], /\n\n\n/);
  }
  assert.deepEqual(
    steps.at(-1).tree,
    compactBlankLines(maskOrigin(data.clean, { name: "frond" }).tree).tree,
  );
});

function fixture(namespace = "frond") {
  const definitions = [
    "int first(int x) { return x + 1; }",
    "int second(int x) { return first(x) + floor; }",
    "int third(int x) { return second(x) + 2; }",
    "int fourth(int x) { return third(x) + 4; }",
  ];
  const gaps = ["\nconst int floor = 3;\n", "\n", "\n", "\n"];
  const head = `const char* note = "λ { first; second; }";\nnamespace ${namespace} {\n`;
  const declarations = definitions.map((text) => text.slice(0, text.indexOf("{")) + ";\n").join("");
  const tail = `}\nint main() { return ${namespace}::fourth(1) == 11 ? 0 : 1; }\n`;
  const original = {
    "main.cpp": head + declarations + definitions.map((text, i) => text + gaps[i]).join("") + tail,
  };
  const permutation = [0, 2, 3, 1];
  let source = head + declarations;
  const slots = [];
  for (const [index, occupant] of permutation.entries()) {
    const start = Buffer.byteLength(source);
    source += definitions[occupant];
    slots.push({
      start,
      end: Buffer.byteLength(source),
      original: index,
      occupant,
      hash: hash(definitions[occupant]),
    });
    source += gaps[index];
  }
  source += tail;
  const mixed = { "main.cpp": source };
  const clean = { "main.cpp": original["main.cpp"].replace(declarations, "") };
  return {
    original,
    mixed,
    clean,
    permutation: {
      kind: "function-permutation",
      before: treeIdentity(original),
      after: treeIdentity(mixed),
      slots,
    },
    declaration: {
      kind: "function-declarations",
      before: treeIdentity(clean),
      after: treeIdentity(original),
      edits: [{ start: Buffer.byteLength(head), text: declarations }],
    },
  };
}

await test("small layout swaps keep fixed dependencies and literals, then generated declarations disappear one at a time", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/restoration-layout-"));
  try {
    const data = fixture();
    const states = [...restoreFunctionLayout(data.mixed, data.permutation)];
    assert.equal(states.length, 2);
    assert.deepEqual(states.at(-1).tree, data.original);
    assert.deepEqual(
      states.map((step) => step.slots),
      [
        [1, 3],
        [2, 3],
      ],
    );
    const cleanup = [...removeGeneratedDeclarations(data.original, data.declaration)];
    assert.equal(cleanup.length, 4);
    assert.deepEqual(cleanup.at(-1).tree, data.clean);
    const tokens = [
      "int first(int x) ;",
      "int second(int x) ;",
      "int third(int x) ;",
      "int fourth(int x) ;",
    ];
    for (const [index, step] of cleanup.entries()) {
      assert.equal(step.phase, "structure");
      assert.equal(tokens.filter((text) => step.tree["main.cpp"].includes(text)).length, 3 - index);
    }
    for (const [index, tree] of [
      data.mixed,
      ...states.map((step) => step.tree),
      ...cleanup.map((step) => step.tree),
    ].entries()) {
      assert.match(tree["main.cpp"], /"λ \{ first; second; \}"/);
      assert.match(tree["main.cpp"], /const int floor = 3;/);
      const directory = path.join(root, String(index));
      await writeTree(directory, tree);
      const executable = path.join(directory, "program");
      execFileSync("clang++", ["-std=c++17", path.join(directory, "main.cpp"), "-o", executable]);
      execFileSync(executable);
    }
    assert.deepEqual(data.mixed, fixture().mixed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("missing, repeated or changed physical layout targets are rejected rather than silently skipped", () => {
  const data = fixture();
  const duplicate = structuredClone(data.permutation);
  duplicate.slots[3].occupant = 0;
  assert.throws(() => [...restoreFunctionLayout(data.mixed, duplicate)], /permutation|occupant/i);
  const missing = structuredClone(data.permutation);
  missing.slots.splice(1, 1);
  assert.throws(() => [...restoreFunctionLayout(data.mixed, missing)], /permutation|slot/i);
  const changed = { "main.cpp": data.mixed["main.cpp"].replace("+ 4", "+ 5") };
  assert.throws(() => [...restoreFunctionLayout(changed, data.permutation)], /identity|hash/i);
  const bad = structuredClone(data.declaration);
  bad.edits[0].text = "int wrong();\n";
  assert.throws(
    () => [...removeGeneratedDeclarations(data.original, bad)],
    /declaration|identity/i,
  );
  assert.deepEqual(data.original, fixture().original);
});
