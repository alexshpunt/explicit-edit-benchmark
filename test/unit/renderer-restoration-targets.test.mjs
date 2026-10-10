import assert from "node:assert/strict";
import test from "node:test";
import { restorationTargets } from "../../src/suites/explicit-edit-multi-agent/tasks/restoration-targets.mjs";

const entry = (name, newName, role, scope, family, offset) => ({
  name,
  newName,
  role,
  scope,
  family,
  offset,
});
function fixture() {
  return {
    operations: [
      {
        operation: {
          kind: "append",
          source: "yocto_shape.cpp",
          target: "main.cpp",
          renames: { split_middle: "shape_split_middle" },
        },
      },
      {
        operation: { kind: "include", source: "yocto_math.h", target: "main.cpp" },
      },
      {
        kind: "rename",
        category: "functions-types",
        selection: [
          entry("measure", "CallMeasure", "function", "yocto", "function:measure", 10),
          entry("measure", "CallMeasure", "function", "yocto", "function:measure", 30),
          entry("Item", "TypeItem", "type", "yocto", "type:Item", 5),
        ],
        excluded: [{ name: "begin", offset: 20, reason: "language/library protocol" }],
      },
      {
        kind: "rename",
        category: "fields",
        selection: [
          entry("width", "WidthMember", "field", "yocto::TypeItem", "field:width", 6),
          entry("height", "FieldHeight", "field", "yocto::TypeItem", "field:height", 7),
        ],
        excluded: [],
      },
      {
        kind: "rename",
        category: "locals-parameters",
        selection: [
          entry("width", "ParamWidth", "parameter", "yocto::CallMeasure@10", "param:a", 11),
          entry("local", "LocalValue", "local", "yocto::CallMeasure@10", "local:a", 12),
          entry(
            "capture",
            "ValueCapture",
            "local",
            "yocto::CallMeasure@10::lambda@13",
            "local:b",
            14,
          ),
          entry("width", "ParamWidth", "parameter", "yocto::CallMeasure@30", "param:a", 31),
          entry("other", "OtherArg", "parameter", "yocto::CallMeasure@30", "param:b", 32),
          entry("bias", "BiasVar", "variable", "yocto::CallMeasure@10", "global:bias", 15),
          entry("bias", "BiasVar", "variable", "yocto", "global:bias", 40),
        ],
        excluded: [{ name: "macro_local", offset: 50, reason: "macro-sensitive identifier" }],
      },
      { kind: "function-declarations" },
      { kind: "function-permutation" },
      { kind: "origin-markers", name: "frond" },
      { kind: "compact" },
    ],
  };
}

await test("full restoration targets cover every renamed family and keep coupled owner bindings together", () => {
  const manifest = fixture();
  const saved = structuredClone(manifest);
  const result = restorationTargets(manifest);
  assert.deepEqual(manifest, saved);
  assert.deepEqual(result, restorationTargets(structuredClone(manifest)));
  assert.deepEqual(result.sources, ["frond_math.h", "frond_shape.cpp", "main.cpp"]);
  assert.deepEqual(result.layout, ["function-declarations", "function-permutation"]);
  assert.deepEqual(result.helpers, [
    { file: "frond_shape.cpp", from: "shape_split_middle", to: "split_middle" },
  ]);
  assert.equal(result.naming.length, 5);
  assert.deepEqual(
    result.naming.map((group) => group.category),
    ["locals-parameters", "locals-parameters", "fields", "functions-types", "functions-types"],
  );
  const locals = result.naming.find((group) => group.owners.length === 2);
  assert.deepEqual(locals.owners, ["frond::CallMeasure@10", "frond::CallMeasure@30"]);
  assert.deepEqual(locals.families.map((family) => family.to).sort(), [
    "capture",
    "local",
    "other",
    "width",
  ]);
  const global = result.naming.find((group) => group.families[0].to === "bias");
  assert.equal(global.families.length, 1);
  assert.equal(global.families[0].sites.length, 2);
  assert.equal(result.counts.selectionSites, 12);
  assert.equal(result.counts.families, 9);
  assert.equal(result.excluded.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /yocto/i);
});

await test("physical template references join distinct owner families but never unrelated same-spelling bindings", () => {
  const manifest = fixture();
  const record = manifest.operations.find((item) => item.category === "locals-parameters");
  record.selection[3].family = "param:second";
  record.edits = [{ old: "width", new: "ParamWidth", families: ["param:a", "param:second"] }];
  const result = restorationTargets(manifest);
  const group = result.naming.find((item) => item.owners.length === 2);
  assert.ok(group);
  assert.equal(group.families.filter((item) => item.to === "width").length, 2);
  record.edits[0].families.push("missing-binding");
  assert.throws(() => restorationTargets(manifest), /Unknown physical binding family/);
});
await test("missing, conflicting and unsupported restoration targets cannot be silently skipped", () => {
  const invalid = fixture();
  invalid.operations[2].selection[1].newName = "DifferentMeasure";
  assert.throws(() => restorationTargets(invalid), /Conflicting family/);
  const missing = fixture();
  missing.operations.splice(3, 1);
  assert.throws(() => restorationTargets(missing), /Missing naming category/);
  const unsupported = fixture();
  unsupported.operations.push({ kind: "mystery-transform" });
  assert.throws(() => restorationTargets(unsupported), /Unsupported restoration operation/);
  const renamed = fixture();
  renamed.operations[2].selection[0].role = "macro";
  assert.throws(() => restorationTargets(renamed), /Unsupported naming role/);
  const badPath = fixture();
  badPath.operations[0].operation.source = "../yocto_shape.cpp";
  assert.throws(() => restorationTargets(badPath), /Unsafe source path/);
});
