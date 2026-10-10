import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  implementationGroups,
  implementationRequests,
} from "../../src/suites/explicit-edit-multi-agent/tasks/implementation-groups.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

const file = "frond_module.cpp";
function unit(id, kind, order, references = [], headerDeclared = false, ownerFile = file) {
  return {
    id,
    file: ownerFile,
    order,
    headerDeclared,
    references,
    selector: {
      kind,
      scope: "frond",
      name: id,
      ...(kind === "function" ? { signature: id === "helper" ? "int (Work)" : "int ()" } : {}),
    },
  };
}
function fixture() {
  return [
    unit("Work", "type", 0),
    unit("bias", "variable", 1),
    unit("helper", "function", 2, ["Work", "bias"]),
    unit("alpha", "function", 3, ["helper", "Work"], true),
    unit("beta", "function", 4, ["helper", "Work"], true),
    unit("gamma", "function", 5, ["delta"], true),
    unit("delta", "function", 0, [], true, "frond_other.cpp"),
  ];
}

await test("implementation groups keep shared private helpers, types and data together without pulling public callees into the same file", async () => {
  const units = fixture();
  const before = structuredClone(units);
  const groups = implementationGroups(units);
  assert.deepEqual(units, before);
  assert.deepEqual(groups, implementationGroups([...units].reverse()));
  assert.deepEqual(
    groups.map((group) => group.units.map((item) => item.id)),
    [["Work", "bias", "helper", "alpha", "beta"], ["gamma"], ["delta"]],
  );
  assert.deepEqual(
    groups.flatMap((group) => group.units.map((item) => item.id)).sort(),
    units.map((item) => item.id).sort(),
  );
  assert.equal(groups[0].file, file);
  assert.equal(groups[2].file, "frond_other.cpp");
  const source = {
    Work: "struct Work { int value; };",
    bias: "static int bias = 1;",
    helper: "static int helper(Work work) { return work.value + bias; }",
    alpha: "int alpha() { return helper(Work{2}); }",
    beta: "int beta() { return helper(Work{3}); }",
    gamma: "int gamma() { return delta(); }",
    delta: "int delta() { return 9; }",
  };
  const header = "namespace frond { int alpha(); int beta(); int gamma(); int delta(); }";
  const main =
    '#include "frond_module.h"\nint main() { return frond::alpha() + frond::beta() + frond::gamma() == 16 ? 0 : 1; }';
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/implementation-groups-"));
  try {
    const remaining = new Set(units.map((item) => item.id));
    const moved = {};
    for (const [index, group] of groups.entries()) {
      for (const item of group.units) remaining.delete(item.id);
      const text = group.units.map((item) => source[item.id]).join("\n");
      moved[group.file] =
        (moved[group.file] ?? '#include "frond_module.h"\n') + `namespace frond {\n${text}\n}\n`;
      const tree = {
        "frond_module.h": header,
        "main.cpp":
          main +
          `\nnamespace frond {\n${units
            .filter((item) => remaining.has(item.id))
            .map((item) => source[item.id])
            .join("\n")}\n}\n`,
        ...moved,
      };
      const workspace = path.join(root, `state-${index}`);
      await writeTree(workspace, tree);
      const program = path.join(root, `program-${index}`);
      execFileSync("clang++", [
        "-std=c++17",
        ...Object.keys(tree)
          .filter((name) => name.endsWith(".cpp"))
          .map((name) => path.join(workspace, name)),
        "-o",
        program,
      ]);
      execFileSync(program);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("public implementation requests use owner signatures and insertion anchors, not private IDs or source bodies", () => {
  const units = [
    unit("start", "function", 0, ["end"], true),
    unit("middle", "function", 1, [], true),
    unit("end", "function", 2),
  ];
  const includesByFile = { [file]: [{ file: "frond_module.h", quoted: true }] };
  const requests = implementationRequests(units, { includesByFile });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].phase, "structure");
  assert.equal(requests[0].group, `implementation:${file}`);
  assert.deepEqual(requests[1].dependsOn, [requests[0].id]);
  assert.deepEqual(requests[1].targets[0], {
    selector: units[1].selector,
    after: units[0].selector,
    before: units[2].selector,
  });
  assert.match(requests[1].prompt, /middle/);
  assert.match(requests[1].prompt, /int \(\)/);
  assert.doesNotMatch(
    JSON.stringify(requests),
    /headerDeclared|references|"order"|offset|sourceHash/,
  );
  const privateIds = units.map((item, index) => ({
    ...item,
    id: `private-${index}`,
    references: item.references.map(
      (id) => `private-${units.findIndex((target) => target.id === id)}`,
    ),
  }));
  assert.doesNotMatch(
    JSON.stringify(implementationRequests(privateIds, { includesByFile })),
    /private-/,
  );
  assert.throws(() => implementationRequests(units, { includesByFile: {} }), /include/i);
  assert.throws(
    () =>
      implementationRequests(units, {
        includesByFile: { [file]: [{ file: "folder/..", quoted: true }] },
      }),
    /include/i,
  );
  assert.throws(
    () =>
      implementationRequests(units, {
        includesByFile: { [file]: [{ file: "../secret.h", quoted: true }] },
      }),
    /include/i,
  );
  assert.throws(
    () =>
      implementationRequests(
        [{ ...units[1], selector: { ...units[1].selector, scope: "yocto" } }],
        { includesByFile },
      ),
    /origin/i,
  );
});

await test("private cycles and conditional blocks remain indivisible, while unrelated public functions remain separate", () => {
  const units = [
    unit("first", "function", 0, ["second"]),
    unit("second", "function", 1, ["first"]),
    unit("entry", "function", 2, ["first"], true),
    {
      ...unit("features", "conditional", 3),
      selector: { kind: "conditional", scope: "frond", condition: "defined(FROND_FEATURE)" },
    },
    unit("plain", "function", 4, [], true),
  ];
  assert.deepEqual(
    implementationGroups(units).map((group) => group.units.map((item) => item.id)),
    [["first", "second", "entry"], ["features"], ["plain"]],
  );
});

await test("same-spelling overloads use distinct binding IDs, and an inactive alternative travels with its private conditional block", async () => {
  const first = {
    ...unit("first-helper", "function", 0),
    selector: { kind: "function", scope: "frond", name: "helper", signature: "int (int)" },
  };
  const second = {
    ...unit("second-helper", "function", 1),
    selector: { kind: "function", scope: "frond", name: "helper", signature: "int (float)" },
  };
  assert.deepEqual(
    implementationGroups([
      first,
      second,
      unit("alpha", "function", 2, [first.id], true),
      unit("beta", "function", 3, [second.id], true),
    ]).map((group) => group.units.map((item) => item.id)),
    [
      [first.id, "alpha"],
      [second.id, "beta"],
    ],
  );
  const conditional = {
    ...unit("private-conditional", "conditional", 0),
    selector: { kind: "conditional", scope: "frond", condition: "defined(FROND_FEATURE)" },
  };
  const groups = implementationGroups([
    conditional,
    unit("entry", "function", 1, [conditional.id], true),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].units.length, 2);
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/conditional-group-"));
  try {
    const body =
      "#ifdef FROND_FEATURE\nstatic int hidden() { return 3; }\n#else\nstatic int hidden() { return 4; }\n#endif\nint entry() { return hidden(); }";
    const workspace = path.join(root, "workspace");
    await writeTree(workspace, {
      "frond_module.h": "namespace frond { int entry(); }",
      "frond_module.cpp": `#include "frond_module.h"\nnamespace frond {\n${body}\n}\n`,
      "main.cpp":
        '#include "frond_module.h"\n#ifdef FROND_FEATURE\nconstexpr int expected = 3;\n#else\nconstexpr int expected = 4;\n#endif\nint main() { return frond::entry() == expected ? 0 : 1; }',
    });
    for (const enabled of [false, true]) {
      const program = path.join(root, enabled ? "enabled" : "disabled");
      execFileSync("clang++", [
        "-std=c++17",
        ...(enabled ? ["-DFROND_FEATURE"] : []),
        path.join(workspace, "main.cpp"),
        path.join(workspace, "frond_module.cpp"),
        "-o",
        program,
      ]);
      execFileSync(program);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("unresolved dependencies, wrong private ownership and ambiguous selectors cannot be skipped", () => {
  assert.throws(
    () => implementationGroups([unit("entry", "function", 0, ["missing"], true)]),
    /unresolved/i,
  );
  assert.equal(
    implementationGroups([unit("entry", "function", 0, ["external"], true)], {
      external: ["external"],
    }).length,
    1,
  );
  assert.throws(
    () =>
      implementationGroups([
        unit("entry", "function", 0, ["hidden"], true),
        unit("hidden", "function", 0, [], false, "frond_other.cpp"),
      ]),
    /private.*file|file.*private/i,
  );
  assert.throws(() => implementationGroups([...fixture(), fixture()[0]]), /duplicate/i);
  assert.throws(
    () =>
      implementationGroups([
        unit("a", "function", 0),
        { ...unit("b", "function", 1), selector: unit("a", "function", 0).selector },
      ]),
    /selector/i,
  );
  assert.throws(
    () => implementationGroups([{ ...unit("a", "function", 0), file: "../private.cpp" }]),
    /file/i,
  );
  assert.throws(
    () =>
      implementationGroups([
        { ...unit("a", "function", 0), selector: { kind: "function", name: "a", scope: "frond" } },
      ]),
    /signature/i,
  );
  assert.throws(
    () => implementationGroups([{ ...unit("a", "function", 0), references: null }]),
    /references/i,
  );
});
