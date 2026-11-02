import assert from "node:assert/strict";
import test from "node:test";
import { buildSymbolRecoveryFeedback } from "../../src/suites/explicit-edit-multi-agent/extraction/symbol-feedback.mjs";
import { moduleSymbolRecoveryPrompt } from "../../src/suites/explicit-edit-multi-agent/extraction/prompt.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";

const entities = [
  { scope: "frond", kind: "function-definition", signature: "int present(int value)" },
  { scope: "frond", kind: "function-definition", signature: "int missing(int value)" },
  { scope: "frond", kind: "using", signature: "using std::array;" },
];
const expected = `namespace frond {
using std::array;
int present(int value) { return value + 918273; }
int missing(int value) { return value + 837261; }
}`;
const actual = `namespace frond {
int present(int value) { return value + 7; }
}`;

test("recovery identifies missing public signatures and changed entities without bodies", async () => {
  const feedback = await buildSymbolRecoveryFeedback({ expected, actual, entities });
  assert.deepEqual(
    feedback.map(({ status, entity }) => [status, entity.signature]),
    [
      ["changed", "int present(int value)"],
      ["missing", "int missing(int value)"],
      ["missing", "using std::array;"],
    ],
  );
  const text = moduleSymbolRecoveryPrompt({
    file: "shape.h",
    recovery: { publicFeedback: feedback },
  });
  for (const entity of entities) assert.ok(text.includes(entity.signature));
  for (const secret of ["918273", "837261", "return value", '"status":', '"signature":'])
    assert.ok(!text.includes(secret));
});

test("namespace partitioning does not create spurious changed-entity feedback", async () => {
  const reference =
    "namespace frond { int present(int value) { return value + 1; } int missing(int value) { return value + 2; } }";
  const candidate =
    "namespace frond { int present(int value) { return value + 1; } } namespace frond { int missing(int value) { return value + 3; } }";
  const feedback = await buildSymbolRecoveryFeedback({
    expected: reference,
    actual: candidate,
    entities,
  });
  assert.deepEqual(
    feedback.map(({ status, entity }) => [status, entity.signature]),
    [["changed", "int missing(int value)"]],
  );
});
test("recovery does not report a different namespace as the public entity", async () => {
  const feedback = await buildSymbolRecoveryFeedback({
    expected,
    actual: actual.replace("namespace frond", "namespace other"),
    entities,
  });
  assert.ok(feedback.every(({ status }) => status === "missing"));
});

test("recovery reports excess copies without exposing unassigned entities", async () => {
  const feedback = await buildSymbolRecoveryFeedback({
    expected: "namespace frond { using std::array; }",
    actual: "namespace frond { using std::array; using std::array; int PRIVATE_EXTRA_751; }",
    entities: [entities[2]],
  });
  assert.deepEqual(
    feedback.map(({ status, entity }) => [status, entity.signature]),
    [["extra", entities[2].signature]],
  );
  assert.ok(!JSON.stringify(feedback).includes("PRIVATE_EXTRA_751"));
});

test("extra actual directives are identified without their replacement text", async () => {
  const feedback = await buildSymbolRecoveryFeedback({
    expected: "#include <array>\n#define ORIGINAL(x) x\n",
    actual:
      "#include <array>\n#include <vector>\n#define ORIGINAL(x) x\n#define NEW_MACRO PRIVATE_REPLACEMENT_829\n",
    entities: [],
  });
  assert.deepEqual(
    feedback.map(({ status, entity }) => [status, entity.signature]),
    [
      ["extra", "NEW_MACRO"],
      ["extra", "#include <vector>"],
    ],
  );
  assert.ok(!JSON.stringify(feedback).includes("PRIVATE_REPLACEMENT_829"));
});
test("preprocessor count feedback does not disclose conditions", async () => {
  const feedback = await buildSymbolRecoveryFeedback({
    expected: "#if PRIVATE_CONDITION_918273\nint item;\n#endif\n",
    actual: "int item;\n",
    entities: [],
  });
  assert.deepEqual(
    feedback.map(({ status, entity, expectedCount, actualCount }) => [
      status,
      entity.signature,
      expectedCount,
      actualCount,
    ]),
    [
      ["condition-count", "#if", 1, 0],
      ["condition-count", "#endif", 1, 0],
    ],
  );
  const prompt = moduleSymbolRecoveryPrompt({
    file: "item.h",
    recovery: { publicFeedback: feedback },
  });
  assert.ok(prompt.includes("#if"));
  assert.ok(!prompt.includes("PRIVATE_CONDITION_918273"));
});
test("a retained source entity is identified without exposing its body", async () => {
  const publicEntity = {
    scope: "frond",
    kind: "function-definition",
    signature: "int present(int value)",
  };
  const feedback = await buildSymbolRecoveryFeedback({
    expected: "int main() { return 0; }",
    actual:
      "namespace frond { int present(int value) { return value + 918273; } }\nint main() { return 0; }",
    entities: [publicEntity],
    detectUnexpected: true,
  });
  assert.deepEqual(
    feedback.map(({ status, entity }) => [status, entity.signature]),
    [["extra", publicEntity.signature]],
  );
  assert.ok(!JSON.stringify(feedback).includes("918273"));
});

test("shared recovery identifies unexpected candidate files without other diagnostics", () => {
  const prompt = moduleSymbolRecoveryPrompt({
    kind: "main-recovery",
    recovery: {
      diagnostics: [
        { kind: "extra-file", file: "unexpected.o" },
        { kind: "destination", file: "PRIVATE_918273", line: 918273 },
        { kind: "extra-file", file: "../PRIVATE_837261" },
      ],
    },
  });
  assert.ok(prompt.includes("unexpected.o"));
  assert.ok(!prompt.includes("918273"));
  assert.ok(!prompt.includes("837261"));
});
test("vendor recovery identifies missing copies and disambiguates public members", async () => {
  const expected =
    "STBIRDEF int f(int x);\nSTBIRDEF int f(int x);\ntypedef struct { int a; } Render;\ntypedef struct { int b; } Render;\n";
  const actual = "STBIRDEF int f(int x);\ntypedef struct { int a; } Render;\n";
  const entities = [
    { scope: "", kind: "function-declaration", signature: "STBIRDEF int f(int x)", occurrences: 2 },
    { scope: "", kind: "typedef", signature: "Render", members: ["int a;"] },
    { scope: "", kind: "typedef", signature: "Render", members: ["int b;"] },
  ];
  const feedback = await buildSymbolRecoveryFeedback({
    expected,
    actual,
    entities,
    kind: "vendor-header",
  });
  assert.deepEqual(
    feedback.map(({ status, entity, actualCount, expectedCount }) => [
      status,
      entity.signature,
      entity.members,
      actualCount,
      expectedCount,
    ]),
    [
      ["missing", "STBIRDEF int f(int x)", undefined, 1, 2],
      ["missing", "Render", ["int b;"], 0, 1],
    ],
  );
  const text = moduleSymbolRecoveryPrompt({
    file: "vendor.h",
    recovery: { publicFeedback: feedback },
  });
  assert.ok(text.includes("int b;"));
  assert.ok(text.includes("STBIRDEF int f(int x)"));
});
test("unparseable vendor content reports an unavailable analysis rather than invented defects", async () => {
  const feedback = await buildSymbolRecoveryFeedback({
    expected: "int okay(int x);",
    actual: "int broken( {",
    entities: [{ scope: "", kind: "function-declaration", signature: "int okay(int x)" }],
    kind: "vendor-header",
  });
  assert.deepEqual(feedback, [{ status: "unavailable" }]);
  assert.doesNotThrow(() =>
    moduleSymbolRecoveryPrompt({ file: "vendor.h", recovery: { publicFeedback: feedback } }),
  );
});
test(
  "owner recovery receives diagnostics from its frozen destination",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symbol-feedback-"));
    try {
      const base = prepareHeaderExtraction({
        initial: {
          "main.cpp":
            "#ifndef SHAPE_H\n#define SHAPE_H\nnamespace frond { int shade(int x) { return x + 918273; } }\n#endif\nint main() { return 0; }\n",
        },
        headers: [{ file: "shape.h", guard: "SHAPE_H", includes: [] }],
        modules: ["shape.h"],
      });
      const plan = {
        ...base,
        version: "renderer-module-extraction-plan-v2",
        scope: "experimental-module-pairs",
        agents: 1,
      };
      const spec = [{ scope: "frond", kind: "function-definition", signature: "int shade(int x)" }];
      let received;
      const report = await runExtractionRecovery(plan, path.join(root, "run"), {
        publicAssignments: new Map([[plan.tasks[0].id, spec]]),
        async createDriver() {
          return {
            closed: false,
            count: 0,
            async assertIdle() {
              return { messageCount: this.count };
            },
            async terminate() {
              this.closed = true;
            },
          };
        },
        async execute(driver, task, context) {
          driver.count++;
          if (context.stage === "original") {
            await writeFile(path.join(context.workspace, "main.cpp"), plan.expected["main.cpp"]);
            await writeFile(
              path.join(context.workspace, "shape.h"),
              plan.expected["shape.h"].replace("918273", "7"),
            );
          } else {
            received = moduleSymbolRecoveryPrompt(task);
            assert.ok(received.includes("int shade(int x)"));
            assert.ok(!received.includes("918273"));
            await writeFile(path.join(context.workspace, "shape.h"), plan.expected["shape.h"]);
          }
          return {};
        },
        async measure() {
          return { buildPassed: true, resultMatched: true };
        },
      });
      assert.ok(received);
      assert.equal(report.passed, true);
      const saved = JSON.parse(await readFile(path.join(root, "run", "report.json"), "utf8"));
      assert.equal(saved.status, "complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
