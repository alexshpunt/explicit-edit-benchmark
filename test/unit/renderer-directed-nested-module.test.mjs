import assert from "node:assert/strict";
import test from "node:test";
import { barrierRepairNodes } from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";
import { editCurrentProblems } from "../../src/suites/explicit-edit-multi-agent/reference/problem-edit.mjs";
import { headerSpan } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";

const header =
  "#ifndef API_H\n#define API_H\nnamespace api { inline int value() { return 42; } }\n#endif\n";
const nodes = [
  {
    id: "historical-atom",
    taskId: "historical-parent",
    prompt: "HISTORICAL_PROMPT",
    operations: [
      { phase: "structure", action: "header", file: "api.h", guard: "API_H", includes: [] },
    ],
  },
];
const problems = (tree) =>
  barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    diagnostics: [{ category: "structure", kind: "directive", file: "main.cpp" }],
  }).flatMap((node) => node.operations);

for (const depth of [1, 2]) {
  test(`a fresh module repair removes a resurrected header under ${depth} outer guards`, async () => {
    const guards = Array.from({ length: depth }, (_, i) => `OUTER_${i}_H`);
    const open = guards.map((guard) => `#ifndef ${guard}\n#define ${guard}\n`).join("");
    const close = "#endif\n".repeat(depth);
    const peerHeader = header.replace(
      "namespace api",
      "// Preserve the peer's current header.\nnamespace api",
    );
    const tree = {
      "main.cpp": open + header + "int main() { return api::value(); }\n" + close,
      "api.h": peerHeader,
    };
    const work = problems(tree);
    const removals = work.filter((op) => op.action === "remove-source-module");
    assert.equal(removals.length, 1);
    assert.equal(removals[0].phase, "repair");
    assert.equal(removals[0].target.file, "main.cpp");
    assert.equal(removals[0].required.file, "api.h");
    assert.equal(removals[0].required.guard, "API_H");
    assert.equal(JSON.stringify(work).includes("HISTORICAL"), false);
    assert.equal(JSON.stringify(work).includes("historical"), false);
    assert.equal(JSON.stringify(work).includes("return 42"), false);
    const { after } = await editCurrentProblems(tree, removals, undefined, "fresh-module-problem");
    assert.equal(after["api.h"], peerHeader);
    assert.ok(after["main.cpp"].includes('#include "api.h"'));
    assert.equal(after["main.cpp"].includes("#ifndef API_H"), false);
    for (const guard of guards) assert.ok(after["main.cpp"].includes(`#ifndef ${guard}`));
    assert.ok(after["main.cpp"].includes("int main() { return api::value(); }"));
    assert.equal(
      problems(after).some((op) => op.action === "remove-source-module"),
      false,
    );
    const twice = await editCurrentProblems(
      after,
      removals,
      undefined,
      "fresh-module-problem-again",
    );
    assert.deepEqual(twice.after, after);
  });
}

for (const decoy of [
  "/*\n#ifndef API_H\n#define API_H\n#endif\n*/\n",
  'const char* text = R"guard(\n#ifndef API_H\n#define API_H\n#endif\n)guard";\n',
]) {
  test("a guard spelling in protected source is not a current module block", () => {
    const tree = { "main.cpp": decoy + "int main() { return 0; }\n", "api.h": header };
    assert.equal(
      problems(tree).some((op) => op.action === "remove-source-module"),
      false,
    );
  });
}

test("ambiguous current module guards remain explicit inspection work", () => {
  const work = problems({ "main.cpp": header + header, "api.h": header });
  assert.equal(
    work.some((op) => op.action === "remove-source-module"),
    false,
  );
  assert.ok(work.some((op) => op.action === "inspect" && op.target.file === "main.cpp"));
});

test("the shared header selector preserves offsets and ignores continued macro decoys", () => {
  const decoy = "#define DECOY \\\n#ifndef API_H \\\n#define API_H \\\n#endif\n";
  const prefix = "/* π 🧭 */\n" + decoy + 'const char* text = R"x(\n#ifndef API_H\n#endif\n)x";\n';
  const source = (prefix + "#ifndef OUTER_H\n#define OUTER_H\n" + header + "#endif\n").replaceAll(
    "\n",
    "\r\n",
  );
  const span = headerSpan(source, "API_H");
  assert.equal(source.slice(span.start, span.end), header.replaceAll("\n", "\r\n"));
  assert.equal(headerSpan(decoy, "API_H", { allowMissing: true }), undefined);
});

test("two explicitly selected vendor copies remain repairable rather than ambiguous project guards", async () => {
  const file = "support/stb_image/stb_image_resize.h";
  const declarations = "#ifndef VENDOR_H\n#define VENDOR_H\nint vendor_value();\n#endif\n";
  const implementation = "#ifdef IMPLEMENTATION\nint vendor_value() { return 7; }\n#endif\n";
  const peerHeader = declarations + "// Current peer vendor header.\n" + implementation;
  const activation = '#define IMPLEMENTATION\n#include "stb_image/stb_image_resize.h"\n';
  const tree = {
    "main.cpp":
      declarations +
      implementation +
      "#define IMPLEMENTATION\n" +
      declarations +
      implementation +
      "int main() { return vendor_value(); }\n",
    [file]: peerHeader,
    "support/stb.cpp": activation,
  };
  const work = barrierRepairNodes({
    category: "structure",
    tree,
    nodes: [
      {
        id: "historical-vendor",
        operations: [
          {
            phase: "structure",
            action: "vendor-header",
            file,
            guard: "VENDOR_H",
            macro: "IMPLEMENTATION",
            declarationsCopy: 1,
            implementationCopy: 2,
            includes: [],
          },
        ],
      },
    ],
    diagnostics: [{ category: "structure", kind: "directive", file: "main.cpp" }],
  }).flatMap((node) => node.operations);
  const removals = work.filter((op) => op.action === "remove-source-module");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].required.declarationsCopy, 1);
  assert.equal(removals[0].required.implementationCopy, 2);
  const { after } = await editCurrentProblems(tree, removals, undefined, "fresh-vendor-problem");
  assert.equal(after[file], peerHeader);
  assert.equal(after["support/stb.cpp"], activation);
  assert.equal(after["main.cpp"].includes("#ifndef VENDOR_H"), false);
  assert.equal(after["main.cpp"].includes("#ifdef IMPLEMENTATION"), false);
  assert.equal(after["main.cpp"].includes("#define IMPLEMENTATION"), false);
  assert.ok(after["main.cpp"].includes("int main() { return vendor_value(); }"));
});
test("missing, duplicate, incomplete and invalid guards never select arbitrary source", () => {
  assert.equal(headerSpan("", "API_H", { allowMissing: true }), undefined);
  assert.throws(() => headerSpan("", "API_H"), /Missing or ambiguous header guard/);
  assert.throws(() => headerSpan(header + header, "API_H", { allowMissing: true }), /ambiguous/);
  assert.throws(
    () => headerSpan("#ifndef API_H\n#define API_H\n", "API_H", { allowMissing: true }),
    /Incomplete/,
  );
  assert.throws(() => headerSpan(header, "API.*", { allowMissing: true }), /Invalid/);
});
