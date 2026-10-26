import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRepairSignature } from "../../src/suites/explicit-edit-multi-agent/cpp/repair-identity.mjs";
import { diagnoseRepairRequirements } from "../../src/suites/explicit-edit-multi-agent/grading/repair-requirements.mjs";

const node = (id, operation) => ({ id, taskId: id, operations: [operation] });
const rename = (from, to, selectors, extra = {}) => ({
  phase: "names",
  category: "locals-parameters",
  mapping: [{ from, to }],
  selectors,
  ...extra,
});
const owner = (scope = "api::inspect", signature = "int (int)", definition = true) => ({
  scope,
  signature,
  definition,
});
const variable = (scope, own) => ({ kind: "variable", scope, ...(own ? { owner: own } : {}) });
function binding(tree, file, name, extra = {}, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = tree[file].indexOf(name, start + 1);
  assert.ok(start >= 0);
  return {
    file,
    name,
    role: "variable",
    scope: `api::${name}`,
    declaringScope: "api",
    offset: Buffer.byteLength(tree[file].slice(0, start)),
    line: 1,
    column: start + 1,
    translationUnit: file.endsWith(".cpp")
      ? file
      : Object.keys(tree).find((name) => name.endsWith(".cpp")),
    definition: true,
    id: "PRIVATE_USR",
    files: [file],
    ...extra,
  };
}
const move = (name, signature, file = "part.cpp") => ({
  phase: "structure",
  action: "implementation",
  file,
  includes: [{ file: "api.h", quoted: true }],
  preamble: '#include "api.h"\n',
  targets: [
    {
      selector: {
        kind: signature ? "function" : "variable",
        scope: "api",
        name,
        ...(signature ? { signature, definition: true } : {}),
        declarator: `OLD_${name}`,
      },
      context: [],
    },
  ],
});

test("directed repairs leave an already renamed and moved global alone and target the actual bad parameter", () => {
  const tree = {
    "part.cpp": "// é\nint positions = 1;\nint inspect(int Wrong) { return Wrong; }\n",
  };
  const fn = owner();
  const nodes = [
    node("old-move", move("OldPositions")),
    node("global-name", rename("OldPositions", "positions", [variable("api::OldPositions")])),
    node("parameter", rename("Wrong", "value", [variable("api::inspect::Wrong", fn)])),
  ];
  const bindings = [
    binding(tree, "part.cpp", "positions"),
    binding(tree, "part.cpp", "Wrong", {
      scope: "api::inspect::Wrong",
      declaringScope: "api::inspect",
      owner: fn,
    }),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.equal(result[0].action, "rename-binding");
  assert.equal(result[0].target.name, "Wrong");
  assert.equal(result[0].target.identifier, 5);
  assert.deepEqual(result[0].required, { name: "value" });
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(result).includes("old-move"), false);
  assert.equal(JSON.stringify(result).includes("OLD_"), false);
});

test("prototype and definition owners and overload signatures keep their separate public goals", () => {
  const tree = {
    "api.h": "#pragma once\nnamespace api { int inspect(int Wrong); }\n",
    "part.cpp":
      '#include "api.h"\nnamespace api {\nint inspect(int Wrong) { return Wrong; }\nfloat inspect(float Wrong) { return Wrong; }\n}\n',
  };
  const nodes = [
    node(
      "proto",
      rename("Wrong", "declared", [
        variable("api::inspect::Wrong", owner(undefined, undefined, false)),
      ]),
    ),
    node("body", rename("Wrong", "value", [variable("api::inspect::Wrong", owner())])),
  ];
  const bindings = [
    binding(tree, "api.h", "Wrong", {
      scope: "api::inspect::Wrong",
      owner: owner(undefined, undefined, false),
    }),
    binding(tree, "part.cpp", "Wrong", { scope: "api::inspect::Wrong", owner: owner() }),
    binding(
      tree,
      "part.cpp",
      "Wrong",
      { scope: "api::inspect::Wrong", owner: owner("api::inspect", "float (float)") },
      2,
    ),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.deepEqual(
    result.map((item) => [item.target.file, item.required.name]),
    [
      ["api.h", "declared"],
      ["part.cpp", "value"],
    ],
  );
});

test("lambda locals and parameters follow their public outer owner without merging overloads or prototypes", () => {
  const tree = {
    "api.h": "namespace api { int inspect(int StrValue); }\n",
    "part.cpp":
      "namespace api {\nint inspect(int seed) { auto first = [](int ParamOld) { int StrValue = ParamOld; return StrValue; }; auto second = [](int num) { int str_v = num; return str_v; }; return first(seed) + second(seed); }\nfloat inspect(float seed) { auto peer = [] { int StrValue = 1; return StrValue; }; return peer() + seed; }\n}\n",
  };
  const fn = owner();
  const nodes = ["StrValue", "str_v", "ParamOld"].map((name, index) =>
    node(
      `old-${index}`,
      rename(name, name === "ParamOld" ? "value" : "str", [variable(`api::inspect::${name}`, fn)]),
    ),
  );
  const physical = (name) => ({
    scope: `api::inspect::operator()::${name}`,
    declaringScope: "api::inspect::operator()",
    owner: fn,
  });
  const bindings = [
    binding(tree, "part.cpp", "StrValue", physical("StrValue")),
    binding(tree, "part.cpp", "str_v", physical("str_v")),
    binding(tree, "part.cpp", "ParamOld", physical("ParamOld")),
    binding(
      tree,
      "part.cpp",
      "StrValue",
      { ...physical("StrValue"), owner: owner("api::inspect", "float (float)") },
      2,
    ),
    binding(tree, "api.h", "StrValue", {
      scope: "api::inspect::StrValue",
      owner: owner(undefined, undefined, false),
    }),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((item) => [item.target.name, item.required.name]).sort(), [
    ["ParamOld", "value"],
    ["StrValue", "str"],
    ["str_v", "str"],
  ]);
  assert.ok(
    result.every(
      (item) => item.target.file === "part.cpp" && item.target.scope.includes("operator()"),
    ),
  );
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});
test("public implicit callable contexts and compiler lambda scopes use the same named owner without losing local record boundaries", () => {
  const tree = {
    "part.cpp":
      "namespace api { int inspect(int seed) { struct Callback { int call(int Old) { return Old; } }; auto lambda = [](int Old) { return Old; }; return lambda(seed); } }\n",
  };
  const fn = owner();
  const nodes = [
    node("old-callable", rename("Old", "value", [variable("api::inspect::__invoke::Old", fn)])),
  ];
  const bindings = [
    binding(tree, "part.cpp", "Callback", {
      role: "type",
      scope: "api::inspect::Callback",
      owner: fn,
    }),
    binding(tree, "part.cpp", "Old", {
      scope: "api::inspect::Callback::call::Old",
      declaringScope: "api::inspect::Callback::call",
      owner: fn,
    }),
    binding(
      tree,
      "part.cpp",
      "Old",
      {
        scope: "api::inspect::operator()::Old",
        declaringScope: "api::inspect::operator()",
        owner: fn,
      },
      2,
    ),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.equal(result[0].target.scope, "api::inspect::operator()::Old");
  assert.equal(result[0].required.name, "value");
});
test("current owner names and signatures follow public nominal renames", () => {
  const tree = { "part.cpp": "Shape inspect(Shape Wrong) { return Wrong; }\n" };
  const nodes = [
    node(
      "type",
      rename("OldShape", "Shape", [{ kind: "type", scope: "api::OldShape" }], {
        category: "functions-types",
      }),
    ),
    node(
      "function",
      rename(
        "OldInspect",
        "inspect",
        [
          {
            kind: "function",
            scope: "api::OldInspect",
            owner: owner("api::OldInspect", "OldShape (OldShape)"),
          },
        ],
        { category: "functions-types" },
      ),
    ),
    node(
      "parameter",
      rename("Wrong", "value", [
        variable("api::OldInspect::Wrong", owner("api::OldInspect", "OldShape (OldShape)")),
      ]),
    ),
  ];
  const bindings = [
    {
      file: "api.h",
      name: "Shape",
      scope: "api::Shape",
      declaringScope: "api",
      role: "type",
      definition: true,
    },
    binding(tree, "part.cpp", "Wrong", {
      scope: "api::inspect::Wrong",
      owner: owner("api::inspect", "api::Shape (api::Shape)"),
    }),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].required, { name: "value" });
});

test("record aliases preserve field goals and helper names stay within their public file", () => {
  const tree = { "a.cpp": "int OldField; int Helper;", "b.cpp": "int Helper;" };
  const nodes = [
    node(
      "type",
      rename("OldRecord", "Record", [{ kind: "type", scope: "api::OldRecord" }], {
        category: "functions-types",
      }),
    ),
    node(
      "field",
      rename("OldField", "value", [{ kind: "record", scope: "api::OldRecord" }], {
        category: "fields",
      }),
    ),
    node(
      "helper",
      rename("Helper", "helper", [variable("api::Helper")], { category: "helpers", file: "a.cpp" }),
    ),
  ];
  const bindings = [
    binding(tree, "a.cpp", "OldField", {
      role: "field",
      scope: "api::Record::OldField",
      declaringScope: "api::Record",
    }),
    binding(tree, "a.cpp", "Helper"),
    binding(tree, "b.cpp", "Helper"),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.deepEqual(
    result.map((item) => [item.target.file, item.required.name]),
    [
      ["a.cpp", "value"],
      ["a.cpp", "helper"],
    ],
  );
});

test("public rename chains reach their current goal and conflicting or cyclic goals fail closed", () => {
  const tree = { "main.cpp": "int First; int Last;" };
  const nodes = [
    node("first", rename("First", "Middle", [variable("api::First")])),
    node("second", rename("Middle", "Last", [variable("api::Middle")])),
  ];
  const bindings = [binding(tree, "main.cpp", "First"), binding(tree, "main.cpp", "Last")];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].required, { name: "Last" });
  assert.deepEqual(
    diagnoseRepairRequirements({
      nodes: [...nodes, node("conflict", rename("First", "Other", [variable("api::First")]))],
      bindings,
      tree,
    }),
    [],
  );
  assert.deepEqual(
    diagnoseRepairRequirements({
      nodes: [nodes[0], node("cycle", rename("Middle", "First", [variable("api::Middle")]))],
      bindings,
      tree,
    }),
    [],
  );
});

test("layout problems use final public names and do not replay an already satisfied destination", () => {
  const tree = { "main.cpp": "int positions = 1;", "part.cpp": "int positions = 1;" };
  const nodes = [
    node("move", move("OldPositions")),
    node("name", rename("OldPositions", "positions", [variable("api::OldPositions")])),
  ];
  const bindings = [binding(tree, "main.cpp", "positions"), binding(tree, "part.cpp", "positions")];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.equal(result[0].action, "move-declaration");
  assert.equal(result[0].target.file, "main.cpp");
  assert.equal(result[0].required.file, "part.cpp");
  assert.equal(result[0].required.qualifiedName, "api::positions");
  assert.deepEqual(result[0].files, ["main.cpp", "part.cpp"]);
  assert.deepEqual(result[0].setup.includes, [{ file: "api.h", quoted: true }]);
  assert.deepEqual(diagnoseRepairRequirements({ nodes, bindings: bindings.slice(1), tree }), []);
});

test("temporary declaration absence applies only to its public C++ owner and canonical overload", () => {
  const tree = {
    "main.cpp": "int inspect(int);\nfloat inspect(float);\n",
    "api.h": "int inspect(int);\n",
  };
  const nodes = [
    node("cleanup", {
      phase: "structure",
      action: "remove-generated-declaration",
      file: "main.cpp",
      selector: {
        kind: "function",
        scope: "api",
        name: "inspect",
        signature: "int (int)",
        definition: false,
        declarator: "OLD",
      },
    }),
  ];
  const bindings = [
    binding(tree, "main.cpp", "inspect", {
      role: "function",
      scope: "api::inspect",
      owner: owner(undefined, undefined, false),
      definition: false,
    }),
    binding(
      tree,
      "main.cpp",
      "inspect",
      {
        role: "function",
        scope: "api::inspect",
        owner: owner("api::inspect", "float (float)", false),
        definition: false,
      },
      1,
    ),
    binding(tree, "api.h", "inspect", {
      role: "function",
      scope: "api::inspect",
      owner: owner(undefined, undefined, false),
      definition: false,
    }),
  ];
  const result = diagnoseRepairRequirements({ nodes, bindings, tree });
  assert.equal(result.length, 1);
  assert.equal(result[0].action, "remove-declaration");
  assert.equal(result[0].target.file, "main.cpp");
  assert.equal(result[0].required.signature, "int(int)");
});

test("invalid compiler locations and unsafe file paths never become editing instructions", () => {
  const tree = { "main.cpp": "// é\nint Old;" };
  const nodes = [node("name", rename("Old", "value", [variable("api::Old")]))];
  const valid = binding(tree, "main.cpp", "Old");
  assert.deepEqual(
    diagnoseRepairRequirements({
      nodes,
      bindings: [
        { ...valid, offset: 4 },
        { ...valid, file: "../secret" },
      ],
      tree,
    }),
    [],
  );
});

test("signature identities normalize public type aliases and qualification without merging namespaces", () => {
  const bindings = [
    { role: "type", scope: "api::OldShape", name: "OldShape" },
    { role: "type", scope: "api::VectorItem", name: "VectorItem" },
    { role: "type", scope: "alpha::Item", name: "Item" },
    { role: "type", scope: "beta::Item", name: "Item" },
  ];
  const aliases = [{ from: "api::OldShape", to: "api::Shape" }];
  assert.equal(
    canonicalRepairSignature("OldShape (const std::vector<VectorItem> &)", {
      scope: "api::inspect",
      bindings,
      aliases,
    }),
    "api::Shape(const vector<api::VectorItem>&)",
  );
  assert.notEqual(
    canonicalRepairSignature("alpha::Item (int)", { bindings }),
    canonicalRepairSignature("beta::Item (int)", { bindings }),
  );
  assert.equal(canonicalRepairSignature("Item (int)", { scope: "other::inspect", bindings }), "");
  assert.notEqual(
    canonicalRepairSignature("unsigned long(int)"),
    canonicalRepairSignature("unsignedlong(int)"),
  );
});
