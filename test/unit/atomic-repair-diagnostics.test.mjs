import assert from "node:assert/strict";
import test from "node:test";
import {
  taskDiagnostics,
  compilerDiagnostics,
  attributeDiagnostics,
} from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";

import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";
const owner = (file, selector) => ({ kind: "owner", file, scope: "", selector });

test("task feedback contains every failed own observation but no private expected tokens", () => {
  const checked = {
    obligations: [
      { id: "pass", status: "pass", kind: "owner", file: "shape.cpp" },
      {
        id: "extra",
        status: "fail",
        kind: "unexpected",
        file: "shape.h",
        selector: "int evalUvRoutine()",
        actual: 1,
        tokens: ["private-answer"],
      },
      {
        id: "missing",
        status: "fail",
        kind: "owner",
        file: "shape.cpp",
        selector: "int evalUvRoutine()",
        expected: 1,
        actual: 0,
      },
    ],
  };
  const feedback = taskDiagnostics(checked);
  assert.equal(feedback.length, 2);
  assert.equal(feedback[0].file, "shape.h");
  assert.equal(feedback[1].actual, 0);
  assert.ok(feedback.every((item) => !Object.hasOwn(item, "tokens") && !Object.hasOwn(item, "id")));
});

test("binding diagnostics report wrong own identifiers without reporting masked peer work", () => {
  const expected = { "shape.cpp": "int f(int fixed, int peer) { return fixed + peer; }\n" };
  const record = prepareCoherentContract(expected).obligations.find(
    (entry) => entry.kind === "owner",
  );
  const masks = record.tokens.flatMap((token, index) =>
    ["fixed", "peer"].includes(token)
      ? [
          {
            index,
            from: token === "fixed" ? "old" : "prior",
            to: token,
            role: token === "fixed" ? "current" : "peer",
          },
        ]
      : [],
  );
  const checked = evaluateAtomicBindingGate(
    { "shape.cpp": "int f(int wrong, int other) { return wrong + other; }\n" },
    { records: [{ ...record, masks }] },
  );
  assert.equal(checked.status, "fail");
  const detail = taskDiagnostics(checked);
  assert.ok(detail[0].identifiers.length);
  assert.ok(
    detail[0].identifiers.every((entry) => entry.expected === "fixed" && entry.actual === "wrong"),
  );
  assert.ok(!JSON.stringify(detail).includes("other"));
});
test("compiler errors and notes are read from candidate stderr, not host command text", () => {
  const tree = {
    "shape.cpp": "int wrong() { return missing; }\n",
    "peer.cpp": "int peer() { return 1; }\n",
  };
  const diagnostics = compilerDiagnostics(
    "/workspace/shape.cpp:1:22: error: use of undeclared identifier 'missing'\n" +
      "/workspace/peer.cpp:1:5: note: candidate is here\n" +
      "Command failed: bwrap --ro-bind /private/evidence /workspace\n",
    tree,
  );
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].file, "shape.cpp");
  assert.equal(diagnostics[0].line, 1);
  assert.equal(diagnostics[0].selector, "intwrong()");
  assert.ok(diagnostics.every((item) => !JSON.stringify(item).includes("/private")));
});

test("compiler byte columns cannot attribute a Unicode-adjacent error to a peer owner", () => {
  const source = 'int first() { return "Ж"[0]; } int second() { return missing; }';
  const column = Buffer.byteLength(source.slice(0, source.indexOf("missing"))) + 1;
  const diagnostics = compilerDiagnostics(
    `/workspace/shape.cpp:1:${column}: error: undeclared identifier`,
    { "shape.cpp": source },
  );
  assert.equal(diagnostics[0].selector, "intsecond()");
});
test("compiler locations inside a guarded header resolve the physical declaration", () => {
  const tree = {
    "shape.h": "#ifndef SHAPE_H\n#define SHAPE_H\ninline int wrong() { return missing; }\n#endif\n",
  };
  const diagnostics = compilerDiagnostics(
    "/workspace/shape.h:3:29: error: undeclared identifier 'missing'",
    tree,
  );
  assert.equal(diagnostics[0].selector, "inlineintwrong()");
  assert.equal(diagnostics[0].scope, "");
});
test("a barrier error returns only to its uniquely responsible task; foreign notes stay separate", () => {
  const scopes = new Map([
    ["mine", [owner("shape.cpp", "intwrong()")]],
    ["peer", [owner("peer.cpp", "intpeer()")]],
  ]);
  const errors = [
    {
      category: "build",
      file: "shape.cpp",
      selector: "intwrong()",
      scope: "",
      severity: "error",
      message: "missing",
    },
    {
      category: "build",
      file: "peer.cpp",
      selector: "intpeer()",
      scope: "",
      severity: "note",
      message: "candidate",
    },
  ];
  const result = attributeDiagnostics(errors, scopes);
  assert.equal(result.assigned.get("mine").length, 1);
  assert.equal(result.assigned.get("peer").length, 1);
  assert.equal(result.assigned.get("mine")[0].message, "missing");
  assert.equal(result.unassigned.length, 0);
});

test("shared ownership, unknown locations and never-delivered tasks are not guessed or broadcast", () => {
  const record = owner("shape.cpp", "intwrong()");
  const scopes = new Map([
    ["first", [record]],
    ["second", [record]],
  ]);
  const errors = [
    { category: "build", ...record, severity: "error", message: "shared" },
    { category: "build", file: "main.cpp", severity: "error", message: "unknown" },
  ];
  const result = attributeDiagnostics(errors, scopes);
  assert.equal(result.assigned.size, 0);
  assert.deepEqual(result.unassigned, errors);
});
