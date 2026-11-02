import assert from "node:assert/strict";
import test from "node:test";
import { pairedExtractionFixture } from "../helpers/module-extraction-generation.mjs";
import { preparePairedExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/paired-plan.mjs";
import { extractCurrentFile } from "../../src/suites/explicit-edit-multi-agent/extraction/edit.mjs";
import { prepareExtractionStructure } from "../../src/suites/explicit-edit-multi-agent/extraction/structure.mjs";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";

test("preparation refuses macro-sensitive project headers before relocating includes", () => {
  const input = pairedExtractionFixture({
    main: '#define operation_a renamed_operation\n#include "yocto_a.h"\n#include "yocto_b.h"\nint main() { return 0; }\n',
  });
  assert.throws(() => preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 1 }));
});
test("temporary header macro scopes move with their complete header", () => {
  const prefix = "#ifdef DEVICE_MODE\n#define inline inline\n#endif\n";
  const suffix = "#ifdef DEVICE_MODE\n#undef inline\n#endif\n";
  const input = pairedExtractionFixture({
    headerA:
      '#ifndef A_H\n#define A_H\n#include "yocto_math.h"\n' +
      prefix +
      "namespace yocto { int operation_a(); }\n" +
      suffix +
      "#endif\n",
  });
  const plan = preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 1 });
  assert.ok(!plan.expected["main.cpp"].includes("#define inline"));
  assert.ok(!plan.expected["main.cpp"].includes("#undef inline"));
  assert.ok(plan.expected["frond_a.h"].includes(prefix));
  assert.ok(plan.expected["frond_a.h"].includes(suffix));
  let actual = { ...plan.initial };
  for (const task of [...plan.tasks].reverse()) actual = extractCurrentFile(actual, task);
  assert.deepEqual(actual, plan.expected);
});
function repeatedMacroFixture() {
  const prefix = "#ifdef DEVICE_MODE\n#define inline inline\n#endif\n";
  const suffix = "#ifdef DEVICE_MODE\n#undef inline\n#endif\n";
  const header = (guard, name) =>
    `#ifndef ${guard}\n#define ${guard}\n${guard === "A_H" ? '#include "yocto_math.h"\n' : ""}${prefix}namespace yocto { int ${name}(); }\n${suffix}#endif\n`;
  return {
    prefix,
    suffix,
    plan: preparePairedExtraction({
      ...pairedExtractionFixture({
        headerA: header("A_H", "operation_a"),
        headerB: header("B_H", "operation_b"),
      }),
      modules: ["frond_a", "frond_b"],
      agents: 2,
    }),
  };
}

test("repeated header conditionals follow live owned units in either queue order", () => {
  const { plan } = repeatedMacroFixture();
  for (const tasks of [plan.tasks, [...plan.tasks].reverse()]) {
    let actual = { ...plan.initial };
    for (const original of tasks) {
      const task = structuredClone(original);
      for (const fragment of task.fragments) {
        fragment.start = 0;
        fragment.end = 0;
      }
      actual = extractCurrentFile(actual, task);
    }
    assert.deepEqual(actual, plan.expected);
  }
});

test("missing header conditionals cannot borrow a remaining peer block", () => {
  const { plan, prefix, suffix } = repeatedMacroFixture();
  const task = plan.tasks.find((task) => task.file === "frond_a.h");
  const source = plan.initial["main.cpp"];
  for (const [missing, peer] of [
    [prefix, suffix],
    [suffix, prefix],
  ]) {
    const own = source.indexOf(missing);
    const other = source.lastIndexOf(peer);
    assert.ok(own >= 0 && other > own);
    const current = source.slice(0, other) + source.slice(other + peer.length);
    const damaged = current.slice(0, own) + current.slice(own + missing.length);
    assert.throws(() => extractCurrentFile({ ...plan.initial, "main.cpp": damaged }, task));
  }
});
test("macro lifetime conditions retain character literal values", () => {
  const headerA =
    '#ifndef A_H\n#define A_H\n#include "yocto_math.h"\n' +
    "#if 'a' == 'a'\n#define VALUE 1\n#endif\nnamespace yocto { int operation_a(); }\n" +
    "#if 'a' == 'b'\n#undef VALUE\n#endif\n#endif\n";
  assert.throws(() =>
    preparePairedExtraction({
      ...pairedExtractionFixture({ headerA }),
      modules: ["frond_a"],
      agents: 1,
    }),
  );
});

test("project header includes retain preceding external import context", () => {
  const input = pairedExtractionFixture({
    main: '#include <cassert>\n#include "yocto_a.h"\n#include "yocto_b.h"\nint main() { return 0; }\n',
  });
  const plan = preparePairedExtraction({ ...input, modules: ["frond_a", "frond_b"], agents: 2 });
  const main = plan.expected["main.cpp"];
  for (const file of ["frond_a.h", "frond_b.h", "frond_math.h"])
    assert.ok(main.indexOf("#include <cassert>") < main.indexOf(`#include "${file}"`));
  for (const tasks of [plan.tasks, [...plan.tasks].reverse()]) {
    let actual = { ...plan.initial };
    for (const task of tasks) actual = extractCurrentFile(actual, task);
    assert.deepEqual(actual, plan.expected);
  }
});

test("grouped repeated units reject foreign code between their selected copies", () => {
  const headerA =
    '#ifndef A_H\n#define A_H\n#include "yocto_math.h"\nnamespace yocto { struct OwnStart {};\nint repeated();\nint repeated();\nstruct OwnEnd {}; int operation_a(); }\n#endif\n';
  const headerB =
    "#ifndef B_H\n#define B_H\nnamespace yocto { int repeated(); int operation_b(); }\n#endif\n";
  const plan = preparePairedExtraction({
    ...pairedExtractionFixture({ headerA, headerB }),
    modules: ["frond_a", "frond_b"],
    agents: 2,
  });
  const task = plan.tasks.find((task) => task.file === "frond_a.h");
  const current = plan.initial["main.cpp"].replace(
    "int repeated();\nint repeated();",
    "int repeated();\nint peer_only();\nint repeated();",
  );
  assert.notEqual(current, plan.initial["main.cpp"]);
  assert.throws(() => extractCurrentFile({ ...plan.initial, "main.cpp": current }, task));
});
function fixture() {
  return preparePairedExtraction({
    ...pairedExtractionFixture(),
    modules: ["frond_a", "frond_b"],
    agents: 2,
  });
}

test("fresh paired input removes project guard scaffolding and requires pragma-once destinations", () => {
  const input = pairedExtractionFixture();
  const saved = structuredClone(input);
  const plan = preparePairedExtraction({ ...input, modules: ["frond_a"], agents: 1 });
  assert.equal(plan.headerProtection, "pragma-once");
  assert.equal(plan.version, "renderer-module-extraction-plan-v3");
  assert.deepEqual(input, saved);
  for (const { guard } of input.headers)
    assert.ok(!cppTokens(plan.initial["main.cpp"]).some(({ text }) => text === guard));
  assert.ok(!plan.initial["main.cpp"].includes("#pragma once"));
  for (const task of plan.tasks.filter(({ kind }) => kind === "header")) {
    assert.equal(task.guard, null);
    assert.match(task.destination, /^#pragma once\n/);
    assert.equal((task.destination.match(/^#pragma once$/gm) ?? []).length, 1);
  }
  for (const task of plan.tasks)
    for (const fragment of task.fragments)
      assert.equal(plan.initial["main.cpp"].slice(fragment.start, fragment.end), fragment.text);
  const reloaded = preparePairedExtraction({
    initial: plan.initial,
    headers: plan.headers,
    generation: plan.generation,
    modules: plan.modules,
    agents: plan.agents,
  });
  assert.deepEqual(reloaded, plan);
});

test("current-source extraction retains physical import order for either file queue order", () => {
  const plan = fixture();
  for (const tasks of [plan.tasks, [...plan.tasks].reverse()]) {
    let actual = { ...plan.initial };
    for (const task of tasks) actual = extractCurrentFile(actual, task);
    assert.deepEqual(actual, plan.expected);
  }
  const main = plan.expected["main.cpp"];
  assert.ok(main.indexOf('#include "frond_math.h"') < main.indexOf('#include "frond_a.h"'));
  assert.ok(main.indexOf('#include "frond_a.h"') < main.indexOf('#include "frond_b.h"'));
});

test("structural verification rejects absent, duplicate, inactive, late pragmas and retained guards", async () => {
  const plan = fixture();
  const assess = await prepareExtractionStructure(plan);
  assert.equal((await assess(plan.expected)).status, "pass");
  const task = plan.tasks.find(({ file }) => file === "frond_a.h");
  const complete = plan.expected[task.file];
  const body = complete.replace(/^#pragma once\n/, "");
  for (const text of [
    `// leading comment\n${complete}`,
    body,
    `#pragma once\n${complete}`,
    `${body}\n#pragma once\n`,
    `#if 0\n#pragma once\n#endif\n${body}`,
    `#pragma once\n#ifndef A_H\n#define A_H\n${body}\n#endif\n`,
  ]) {
    const result = await assess({ ...plan.expected, [task.file]: text });
    assert.equal(result.status, "fail");
    assert.deepEqual(result.differenceIds, [task.id]);
    const file = result.files.find(({ id }) => id === task.id);
    assert.equal(file.targetMatched, false);
    assert.equal(file.sourceMatched, true);
    assert.equal(result.mainMatched, true);
  }
});
