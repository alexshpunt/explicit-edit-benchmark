import assert from "node:assert/strict";
import test from "node:test";
import { restorationNameRequests } from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-requests.mjs";
import { applyRequest } from "../../src/suites/explicit-edit-multi-agent/reference/scripted-worker.mjs";

function manifest() {
  const entry = (role, name, newName, scope, offset, owner) => ({
    role,
    name,
    newName,
    scope,
    offset,
    family: `${scope}:${role}:${name}:${offset}`,
    ...(owner ? { owner } : {}),
  });
  return {
    operations: [
      {
        kind: "rename",
        category: "functions-types",
        selection: [
          entry("function", "read", "routineRead", "yocto", 1),
          entry("type", "One", "TyOne", "yocto", 2),
          entry("type", "Two", "TyTwo", "yocto", 3),
        ],
        excluded: [],
        edits: [],
      },
      {
        kind: "rename",
        category: "fields",
        selection: [
          entry("field", "x", "componentValue", "yocto::TyOne", 4),
          entry("field", "y", "componentValue", "yocto::TyTwo", 5),
        ],
        excluded: [],
        edits: [],
      },
      {
        kind: "rename",
        category: "locals-parameters",
        selection: [
          entry("parameter", "width", "paramWidth", "yocto::routineRead@10", 11, {
            kind: "function",
            scope: "yocto::routineRead",
            signature: "int (int)",
          }),
          entry("parameter", "width", "paramWidth", "yocto::routineRead@30", 31, {
            kind: "function",
            scope: "yocto::routineRead",
            signature: "int (float)",
          }),
        ],
        excluded: [],
        edits: [],
      },
      { kind: "origin-markers", name: "frond" },
    ],
  };
}

await test("reused spellings stay in separate owner requests identified by current overload signatures or field owners", () => {
  const input = manifest();
  const requests = restorationNameRequests(input);
  assert.equal(requests.length, 7);
  const locals = requests.filter((request) => request.category === "locals-parameters");
  assert.equal(locals.length, 2);
  assert.deepEqual(
    locals.map((request) => request.selectors),
    [
      [{ kind: "function", scope: "frond::routineRead", signature: "int (int)" }],
      [{ kind: "function", scope: "frond::routineRead", signature: "int (float)" }],
    ],
  );
  assert.ok(
    locals.every(
      (request) => request.mapping[0].from === "paramWidth" && request.mapping[0].to === "width",
    ),
  );
  assert.notEqual(locals[0].target, locals[1].target);
  for (const request of locals) {
    assert.match(request.prompt, /only within the selected owners/);
    assert.throws(
      () => applyRequest({ "main.cpp": "int paramWidth;\n" }, request.prompt),
      /Unsupported request/,
      "A scoped request must not reach the spelling-wide executor",
    );
  }
  for (const request of locals) assert.ok(request.prompt.includes(request.selectors[0].signature));
  const fields = requests.filter((request) => request.category === "fields");
  assert.deepEqual(
    fields.map((request) => request.selectors),
    [[{ kind: "record", scope: "frond::TyOne" }], [{ kind: "record", scope: "frond::TyTwo" }]],
  );
  assert.deepEqual(
    fields.map((request) => request.mapping[0].to),
    ["x", "y"],
  );
  assert.doesNotMatch(
    JSON.stringify(requests.map((request) => request.prompt)),
    /yocto|@\d+|offset|afterStart/i,
  );
  assert.deepEqual(requests, restorationNameRequests(structuredClone(input)));
});

await test("operator owners retain their exact signatures without admitting source paths or code", () => {
  const input = manifest();
  for (const site of input.operations[2].selection) {
    site.scope = site.scope.replace("routineRead", "operator[]");
    site.owner.scope = site.owner.scope.replace("routineRead", "operator[]");
  }
  const requests = restorationNameRequests(input).filter(
    (request) => request.category === "locals-parameters",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.selectors[0].scope),
    ["frond::operator[]", "frond::operator[]"],
  );
  const unsafe = manifest();
  unsafe.operations[2].selection[0].scope = "yocto::operator[];@10";
  unsafe.operations[2].selection[0].owner.scope = "yocto::operator[];";
  assert.throws(() => restorationNameRequests(unsafe), /owner|selector/);
});
await test("ambiguous owners cannot fall back to a spelling-wide edit or a private byte offset", () => {
  const missing = manifest();
  delete missing.operations[2].selection[0].owner;
  assert.throws(() => restorationNameRequests(missing), /owner|selector/i);
  const unknown = manifest();
  unknown.operations[2].selection[0].owner.signature = "";
  assert.throws(() => restorationNameRequests(unknown), /owner|selector/i);
  const privatePath = manifest();
  privatePath.operations[2].selection[0].owner.signature =
    "auto (lambda at /private/project/main.cpp:1:2)";
  assert.throws(() => restorationNameRequests(privatePath), /owner|selector|location/i);
  const wrongScope = manifest();
  wrongScope.operations[2].selection[0].owner.scope = "yocto::anotherFunction";
  assert.throws(() => restorationNameRequests(wrongScope), /owner|selector/i);
  const repeatedSignature = manifest();
  repeatedSignature.operations[2].selection[1].owner.signature = "int (int)";
  assert.throws(() => restorationNameRequests(repeatedSignature), /owner|selector/i);
});
