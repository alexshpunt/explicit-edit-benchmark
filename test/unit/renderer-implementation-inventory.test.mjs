import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cppStructure } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";
import { implementationInventory } from "../../src/suites/explicit-edit-multi-agent/tasks/implementation-inventory.mjs";
import { implementationRequests } from "../../src/suites/explicit-edit-multi-agent/tasks/implementation-groups.mjs";
import { moveImplementation } from "../../src/suites/explicit-edit-multi-agent/reference/implementation-edit.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("compiler and lexical inventory keep private bindings, inactive alternatives and protected literals through ordinary module moves", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/implementation-inventory-"));
  const header = "#pragma once\nnamespace frond { int entry(); int unrelated(); }\n";
  const implementation = `#include "frond_module.h"
namespace frond {
struct Work { int value; };
static int bias = 1;
static int helper(Work value) { return value.value + bias; }
int entry() { auto literal = R"raw(雪 ; } #endif helper)raw"; return helper(Work{2}) + (literal[0] == 'x'); }
#if defined(FROND_OPTION)
static int hidden() { return 7; }
#else
static int hidden() { return 7; }
#endif
int unrelated() { return hidden(); }
}
`;
  try {
    const analysis = path.join(root, "analysis");
    await writeTree(analysis, { "frond_module.h": header, "frond_module.cpp": implementation });
    const inventory = await implementationInventory(
      path.join(analysis, "frond_module.cpp"),
      implementation,
      "frond_module.cpp",
      ["-std=c++17", "-I", analysis],
    );
    assert.deepEqual(
      inventory.units.map((unit) => unit.selector.name ?? unit.selector.kind),
      ["Work", "bias", "helper", "entry", "conditional", "unrelated"],
    );
    assert.equal(
      inventory.units.find((unit) => unit.selector.name === "entry").headerDeclared,
      true,
    );
    const requests = implementationRequests(inventory.units, {
      external: inventory.external,
      includesByFile: { "frond_module.cpp": inventory.includes },
    });
    assert.equal(requests.length, 2);
    assert.ok(requests[0].targets.some((target) => target.selector.name === "Work"));
    assert.ok(requests[0].targets.some((target) => target.selector.name === "bias"));
    assert.ok(requests[1].targets.some((target) => target.selector.kind === "conditional"));
    assert.doesNotMatch(JSON.stringify(requests), /雪|return|sourcePath|"physical"|"offset"/);
    let tree = {
      "frond_module.h": header,
      "main.cpp":
        implementation +
        "\nint main() { return frond::entry() + frond::unrelated() == 10 ? 0 : 1; }\n",
    };
    for (const [index, request] of requests.entries()) {
      const input = structuredClone(tree);
      tree = moveImplementation(tree, request);
      assert.deepEqual(input["frond_module.h"], tree["frond_module.h"]);
      for (const enabled of [false, true]) {
        const workspace = path.join(root, `step-${index}-${enabled}`);
        await writeTree(workspace, tree);
        const program = path.join(workspace, "program");
        execFileSync("clang++", [
          "-std=c++17",
          ...(enabled ? ["-DFROND_OPTION=1"] : []),
          ...Object.keys(tree)
            .filter((name) => name.endsWith(".cpp"))
            .map((name) => path.join(workspace, name)),
          "-o",
          program,
        ]);
        execFileSync(program);
      }
    }
    assert.match(tree["frond_module.cpp"], /雪 ; } #endif helper/);
    assert.doesNotMatch(tree["main.cpp"], /static int hidden|struct Work/);
    const bad = structuredClone(requests[0]);
    bad.targets[0].selector.declarator = "missing(intarg)";
    const untouched = structuredClone(tree);
    assert.throws(() => moveImplementation(tree, bad), /owner|selector/);
    assert.deepEqual(tree, untouched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("physical units preserve default parameters, lambda initializers, continued directives and reopened namespace context", () => {
  const source = `#define VALUE(x) \\\n  x + 1
namespace frond {
using std::size_t;
int first(int x = 1) { return x; }
int second() { return first(); }
const auto value = [] { return "} ; #endif"; }();
#if 0
int unused() { return value[0]; }
#endif
}
namespace frond { int third() { return second(); } }
`;
  const structure = cppStructure(source);
  const declarations = structure.units.filter((unit) => unit.kind === "declaration");
  assert.equal(declarations.length, 4);
  assert.match(
    source.slice(declarations[0].start, declarations[0].end),
    /first\(int x = 1\).*return x/s,
  );
  assert.match(source.slice(declarations[2].start, declarations[2].end), /\}\(\);$/);
  assert.equal(structure.units.filter((unit) => unit.kind === "conditional").length, 1);
  assert.equal(structure.directives.length, 1);
  assert.throws(() => cppStructure("namespace frond { int broken() {"), /Unclosed|Incomplete/);
});
