import assert from "node:assert/strict";
import test from "node:test";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";
import { prepareExtractionStructure } from "../../src/suites/explicit-edit-multi-agent/extraction/structure.mjs";
import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";

function textFixture() {
  const input = fixtureInput();
  return prepareHeaderExtraction(input);
}
function fixtureInput() {
  return {
    initial: {
      "main.cpp":
        "// λ\n#ifndef A_H\n#define A_H\nnamespace first { inline int same() { return 3; } }\n#endif\n" +
        "#ifndef B_H\n#define B_H\nnamespace second { inline int same() { return 3; } }\n#endif\n" +
        "namespace retained { inline int same() { return 3; } }\nint main() { return first::same() + second::same(); }\n",
      "asset.txt": "retained asset\n",
    },
    headers: [
      { file: "a.h", guard: "A_H", includes: [] },
      { file: "b.h", guard: "B_H", includes: [] },
    ],
    modules: ["a.h", "b.h"],
  };
}

const failedFiles = (result) =>
  result.files.filter((file) => !file.targetMatched || !file.sourceMatched).map(({ file }) => file);

test("the expected complete transfer passes without exposing reference bodies", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const actual = await assess(plan.expected);
  assert.equal(actual.version, "renderer-module-extraction-structure-v1");
  assert.equal(actual.status, "pass");
  assert.deepEqual(actual.differenceIds, []);
  assert.deepEqual(
    actual.files,
    plan.tasks.map(({ id, file }) => ({ id, file, targetMatched: true, sourceMatched: true })),
  );
  assert.equal(actual.mainMatched, true);
  assert.equal(actual.inventoryMatched, true);
  assert.equal(actual.unrelatedMatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), actual);
  assert.equal(JSON.stringify(actual.diagnostics).includes("return first::same()"), false);
});

test("cosmetic destination and residual-source layout does not lose structural credit", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const tree = { ...plan.expected };
  tree["a.h"] = tree["a.h"].replace(
    "namespace first { inline int same() { return 3; } }",
    "namespace first\n{\n inline int same( )\n { return 3 ; }\n}\n",
  );
  tree["main.cpp"] = tree["main.cpp"].replace("int main() {", "int main( )\n{\n");
  const actual = await assess(tree);
  assert.equal(actual.status, "pass");
  assert.deepEqual(actual.differenceIds, []);
});

test("an extracted destination may reopen a namespace without losing structural credit", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const source = plan.expected["a.h"];
  const split = source.replace(
    "namespace first { inline",
    "namespace first {} namespace first { inline",
  );
  assert.notEqual(split, source);
  const actual = await assess({ ...plan.expected, "a.h": split });
  assert.equal(actual.status, "pass");
  assert.deepEqual(actual.differenceIds, []);
});
test("missing files and changed literals, inactive conditions and malformed code fail the affected target", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  for (const replacement of [
    undefined,
    plan.expected["a.h"].replace("return 3", "return 4"),
    plan.expected["a.h"] + "#if 0\nint hidden = 7;\n#endif\n",
    plan.expected["a.h"] + "}\n",
  ]) {
    const tree = { ...plan.expected };
    if (replacement === undefined) delete tree["a.h"];
    else tree["a.h"] = replacement;
    const actual = await assess(tree);
    assert.equal(actual.files[0].targetMatched, false);
    assert.equal(actual.files[1].targetMatched, true);
    assert.deepEqual(failedFiles(actual), ["a.h"]);
    assert.ok(actual.differenceIds.includes(plan.tasks[0].id));
    assert.equal(actual.status, "fail");
  }
});

test("copying all correct destinations without removing their bodies fails every transfer", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const actual = await assess({ ...plan.expected, "main.cpp": plan.initial["main.cpp"] });
  assert.ok(actual.files.every(({ targetMatched }) => targetMatched));
  assert.ok(actual.files.every(({ sourceMatched }) => !sourceMatched));
  assert.deepEqual(
    actual.differenceIds,
    plan.tasks.map(({ id }) => id),
  );
  assert.equal(actual.mainMatched, false);
});

test("one completed transfer retains credit while the other source envelope remains", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const task = plan.tasks[0];
  const fragment = task.fragments[0];
  const main =
    plan.initial["main.cpp"].slice(0, fragment.start) +
    task.replacement +
    plan.initial["main.cpp"].slice(fragment.end);
  const actual = await assess({ ...plan.expected, "main.cpp": main });
  assert.equal(actual.files[0].sourceMatched, true);
  assert.equal(actual.files[1].sourceMatched, false);
  assert.deepEqual(actual.differenceIds, [plan.tasks[1].id]);
});

test("missing and repeated replacement includes fail the corresponding source obligation", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  for (const main of [
    plan.expected["main.cpp"].replace('#include "a.h"\n', ""),
    '#include "a.h"\n' + plan.expected["main.cpp"],
  ]) {
    const actual = await assess({ ...plan.expected, "main.cpp": main });
    assert.equal(actual.files[0].sourceMatched, false);
    assert.equal(actual.files[1].sourceMatched, true);
    assert.deepEqual(actual.differenceIds, [plan.tasks[0].id]);
  }
});

test("remaining partial guard scaffolding is attributed without matching common punctuation", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const main = "#ifndef A_H\n#define A_H\n#endif\n" + plan.expected["main.cpp"];
  const actual = await assess({ ...plan.expected, "main.cpp": main });
  assert.equal(actual.files[0].sourceMatched, false);
  assert.equal(actual.files[1].sourceMatched, true);
  assert.deepEqual(actual.differenceIds, [plan.tasks[0].id]);
});

test("changed or added unassigned main code has a separate stable preservation identity", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  for (const main of [
    plan.expected["main.cpp"].replace("return first::same() + second::same()", "return 0"),
    plan.expected["main.cpp"] + "int unassigned = 9;\n",
    undefined,
  ]) {
    const tree = { ...plan.expected, "main.cpp": main };
    if (main === undefined) delete tree["main.cpp"];
    const actual = await assess(tree);
    assert.equal(actual.mainMatched, false);
    assert.deepEqual(failedFiles(actual), main === undefined ? ["a.h", "b.h"] : []);
    assert.ok(actual.differenceIds.includes("preservation:main.cpp"));
    assert.equal(actual.status, "fail");
  }
});

test("identical definitions in a retained namespace do not look like failed transfers", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const actual = await assess(plan.expected);
  assert.ok(actual.files.every(({ sourceMatched }) => sourceMatched));
  assert.equal(actual.mainMatched, true);
});

test("binary assets and invalid source bytes remain explicit preservation failures", async () => {
  const plan = textFixture();
  const assess = await prepareExtractionStructure(plan);
  const asset = await assess({ ...plan.expected, "asset.txt": Buffer.from([0, 255]) });
  assert.equal(asset.unrelatedMatched, false);
  assert.ok(asset.differenceIds.includes("preservation:asset.txt"));
  const target = await assess({ ...plan.expected, "a.h": Buffer.from([0xff]) });
  assert.equal(target.files[0].targetMatched, false);
  assert.ok(target.differenceIds.includes(plan.tasks[0].id));
  const extra = await assess({ ...plan.expected, "extra.bin": Buffer.from([0, 255]) });
  assert.equal(extra.inventoryMatched, false);
  assert.ok(extra.differenceIds.includes("inventory:extra.bin"));
});

test("canonical function-definition reordering stays structural-equivalent for integration checks", async () => {
  const input = fixtureInput();
  input.initial["main.cpp"] += "int zz() { return 1; }\nint aa() { return zz(); }\n";
  const plan = prepareHeaderExtraction(input);
  const assess = await prepareExtractionStructure(plan);
  const main = plan.expected["main.cpp"].replace(
    "int zz() { return 1; }\nint aa() { return zz(); }",
    "int aa() { return zz(); }\nint zz() { return 1; }",
  );
  assert.notEqual(main, plan.expected["main.cpp"]);
  const actual = await assess({ ...plan.expected, "main.cpp": main });
  assert.equal(actual.mainMatched, true);
  assert.deepEqual(actual.differenceIds, []);
});

test("real paired preparation keeps implementation and header transfer obligations separate", async () => {
  const input = pairedExtractionFixture();
  const plan = preparePairedExtraction({ ...input, modules: ["frond_a", "frond_b"], agents: 2 });
  const assess = await prepareExtractionStructure(plan);
  assert.equal((await assess(plan.expected)).status, "pass");
  const copied = await assess({ ...plan.expected, "main.cpp": plan.initial["main.cpp"] });
  assert.ok(copied.files.every(({ targetMatched }) => targetMatched));
  assert.ok(copied.files.every(({ sourceMatched }) => !sourceMatched));
  assert.deepEqual(
    copied.differenceIds,
    plan.tasks.map(({ id }) => id),
  );
});

test("a shared residual cannot falsely fail every module that once contained it", async () => {
  const input = fixtureInput();
  input.initial["main.cpp"] = input.initial["main.cpp"].replaceAll(
    /#define ([AB]_H)\n/g,
    "#define $1\n#include <utility>\n",
  );
  const plan = prepareHeaderExtraction(input);
  const assess = await prepareExtractionStructure(plan);
  const actual = await assess({
    ...plan.expected,
    "main.cpp": "#include <utility>\n" + plan.expected["main.cpp"],
  });
  assert.ok(
    actual.files.every(({ targetMatched, sourceMatched }) => targetMatched && sourceMatched),
  );
  assert.equal(actual.mainMatched, false);
  assert.deepEqual(actual.differenceIds, ["preservation:main.cpp"]);
  assert.equal(actual.status, "fail");
});

test("preparation rejects stale fragment ownership rather than attributing by a guessed name", async () => {
  const plan = textFixture();
  const changed = {
    ...plan,
    tasks: plan.tasks.map((task, index) =>
      index
        ? task
        : {
            ...task,
            fragments: task.fragments.map((fragment) => ({
              ...fragment,
              start: fragment.start + 1,
            })),
          },
    ),
  };
  await assert.rejects(prepareExtractionStructure(changed));
});
