import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  scopedNamingPlan,
  applyScopedNamePlan,
} from "../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs";
import {
  readTree,
  writeTree,
  treeIdentity,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  fullExecutor,
  prepareFullExecutor,
} from "../../src/suites/explicit-edit-multi-agent/reference/full-executor.mjs";

await test("the full isolated worker applies only delivered owners, reparses the next batch and retains edits after a rejected owner", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/full-current-worker-"));
  const workspace = path.join(root, "workspace"),
    tools = path.join(root, "executor");
  const tree = {
    "main.cpp": `namespace frond {
struct Parent { int member; };
struct Other { int member; };
}
int main() { frond::Parent a{2}; frond::Other b{3}; return a.member + b.member == 5 ? 0 : 1; }
`,
  };
  let executor;
  try {
    await writeTree(workspace, tree);
    await prepareFullExecutor(tools);
    const files = (await readdir(tools, { recursive: true })).filter((file) =>
      file.endsWith(".mjs"),
    );
    assert.ok(files.includes("cpp/scoped-names.mjs"));
    assert.ok(
      !files.some((file) =>
        /reference-route|restoration-requests|operations|prepare-name/.test(path.basename(file)),
      ),
    );
    executor = fullExecutor(workspace, tools);
    const parent = {
      id: "parent",
      phase: "names",
      category: "functions-types",
      mapping: [{ from: "Parent", to: "Item" }],
      selectors: [{ kind: "type", scope: "frond::Parent" }],
    };
    const receipt = await executor.deliver(parent);
    const first = await readTree(workspace);
    assert.equal(receipt.identity, treeIdentity(first));
    assert.match(first["main.cpp"], /struct Item \{ int member; \}/);
    assert.match(first["main.cpp"], /struct Other \{ int member; \}/);
    executor.close();
    executor = fullExecutor(workspace, tools);
    const field = {
      id: "field",
      phase: "names",
      category: "fields",
      mapping: [{ from: "member", to: "width" }],
      selectors: [{ kind: "record", scope: "frond::Item" }],
    };
    await executor.deliver(field);
    const final = await readTree(workspace);
    assert.match(final["main.cpp"], /a.width \+ b.member/);
    await assert.rejects(
      executor.deliver({
        ...field,
        id: "missing",
        selectors: [{ kind: "record", scope: "frond::Missing" }],
      }),
      /owner|binding/,
    );
    assert.deepEqual(await readTree(workspace), final);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(workspace, "main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    executor?.close();
    await rm(root, { recursive: true, force: true });
  }
});
await test("file-local helper restoration includes constants but leaves same-spelling header and local bindings alone", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-file-helpers-"));
  const tree = {
    "main.cpp": '#include "frond_math.h"\nint main() { return frond::run() == 10 ? 0 : 1; }\n',
    "frond_math.h":
      "#pragma once\nnamespace other { constexpr int shape_limit = 4; }\nnamespace frond { int run(); }\n",
    "frond_shape.cpp": `#include "frond_math.h"
namespace frond {
static const int shape_limit = 3;
static int shape_helper(int arg) { return arg + shape_limit; }
int run() { int shape_limit = 1; return shape_helper(2) + shape_limit + other::shape_limit; }
}
`,
  };
  const requests = [
    {
      id: "constant",
      category: "helpers",
      file: "frond_shape.cpp",
      mapping: [{ from: "shape_limit", to: "limit" }],
    },
    {
      id: "function",
      category: "helpers",
      file: "frond_shape.cpp",
      mapping: [{ from: "shape_helper", to: "helper" }],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.equal(current["frond_math.h"], tree["frond_math.h"]);
    assert.match(current["frond_shape.cpp"], /static const int limit = 3;/);
    assert.match(
      current["frond_shape.cpp"],
      /static int helper\(int arg\) \{ return arg \+ limit;/,
    );
    assert.match(
      current["frond_shape.cpp"],
      /int shape_limit = 1; return helper\(2\) \+ shape_limit \+ other::shape_limit;/,
    );
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      path.join(root, "workspace/frond_shape.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("an instantiated template signature cannot select the template's tokens as a separate written overload", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-template-overloads-"));
  const tree = {
    "main.cpp": `namespace frond {
template <class T> T measure(T arg) { return arg; }
int measure(int arg) { return arg + 1; }
}
int main() { return frond::measure<int>(2) + frond::measure(3) == 6 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "template",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "item" }],
      selectors: [{ kind: "function", scope: "frond::measure", signature: "T (T)" }],
    },
    {
      id: "ordinary",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "count" }],
      selectors: [{ kind: "function", scope: "frond::measure", signature: "int (int)" }],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(current["main.cpp"], /T measure\(T item\) \{ return item;/);
    assert.match(current["main.cpp"], /int measure\(int count\) \{ return count \+ 1;/);
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("forward template instantiations cannot replace written definition and nested local owners", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-forward-template-"));
  const tree = {
    "main.cpp": `namespace frond {
template <class T> auto measure(T arg);
template <class T> auto measure(T arg) {
  struct Local { int operator()(int nested) const { return nested + 1; } };
  return Local{}(arg);
}
int measure(int arg) { return arg + 2; }
}
int main() { return frond::measure<int>(2) + frond::measure(3) == 8 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "prototype",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "declItem" }],
      selectors: [
        { kind: "function", scope: "frond::measure", signature: "auto (T)", definition: false },
      ],
    },
    {
      id: "template",
      category: "locals-parameters",
      mapping: [
        { from: "arg", to: "item" },
        { from: "nested", to: "value" },
      ],
      selectors: [
        { kind: "function", scope: "frond::measure", signature: "auto (T)", definition: true },
      ],
    },
    {
      id: "ordinary",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "count" }],
      selectors: [{ kind: "function", scope: "frond::measure", signature: "int (int)" }],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(current["main.cpp"], /auto measure\(T declItem\);/);
    assert.match(current["main.cpp"], /auto measure\(T item\) \{/);
    assert.match(current["main.cpp"], /int value\) const \{ return value \+ 1;/);
    assert.match(current["main.cpp"], /return Local\{\}\(item\);/);
    assert.match(current["main.cpp"], /int measure\(int count\) \{ return count \+ 2;/);
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("project specializations keep the system namespace context without reading system bodies into the edit selection", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-system-context-"));
  const tree = {
    "main.cpp": `#include <functional>
namespace frond { struct First { int value; }; struct Second { int value; }; }
namespace std {
template <> struct hash<frond::First> { size_t operator()(const frond::First& arg) const { return arg.value; } };
template <> struct hash<frond::Second> { size_t operator()(const frond::Second& arg) const { return arg.value; } };
}
int main() { return std::hash<frond::First>{}(frond::First{2}) + std::hash<frond::Second>{}(frond::Second{3}) == 5 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "first-hash",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "item" }],
      selectors: [
        {
          kind: "function",
          scope: "std::hash::operator()",
          signature: "size_t (const frond::First &) const",
        },
      ],
    },
    {
      id: "second-hash",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "entry" }],
      selectors: [
        {
          kind: "function",
          scope: "std::hash::operator()",
          signature: "size_t (const frond::Second &) const",
        },
      ],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(current["main.cpp"], /const frond::First& item\) const \{ return item.value;/);
    assert.match(current["main.cpp"], /const frond::Second& entry\) const \{ return entry.value;/);
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("out-of-line operators retain their class owners when signatures and parameter spellings match", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-method-owners-"));
  const tree = {
    "main.cpp": `namespace frond {
struct First { int value; const int& operator[](int arg) const; };
struct Second { int value; const int& operator[](int arg) const; };
const int& First::operator[](int arg) const { return arg ? value : value; }
const int& Second::operator[](int arg) const { return arg ? value : value; }
}
int main() { return frond::First{2}[0] + frond::Second{3}[1] == 5 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "first-operator",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "index" }],
      selectors: [
        {
          kind: "function",
          scope: "frond::First::operator[]",
          signature: "const int &(int) const",
        },
      ],
    },
    {
      id: "second-operator",
      category: "locals-parameters",
      mapping: [{ from: "arg", to: "slot" }],
      selectors: [
        {
          kind: "function",
          scope: "frond::Second::operator[]",
          signature: "const int &(int) const",
        },
      ],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(
      current["main.cpp"],
      /First::operator\[\]\(int index\) const \{ return index \? value : value;/,
    );
    assert.match(
      current["main.cpp"],
      /Second::operator\[\]\(int slot\) const \{ return slot \? value : value;/,
    );
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("anonymous typedef records keep same-spelling fields bound to their own aliases", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-anonymous-records-"));
  const tree = {
    "main.cpp": `typedef struct { int member; } First;
typedef union { int member; float weight; } Second;
int main() { First a{2}; Second b{3}; const char* text = "member"; return a.member + b.member + (text[0] == 'x') == 5 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "first",
      category: "fields",
      mapping: [{ from: "member", to: "width" }],
      selectors: [{ kind: "record", scope: "First" }],
    },
    {
      id: "second",
      category: "fields",
      mapping: [{ from: "member", to: "height" }],
      selectors: [{ kind: "record", scope: "Second" }],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(current["main.cpp"], /struct \{ int width; \} First/);
    assert.match(current["main.cpp"], /union \{ int height; float weight; \} Second/);
    assert.match(current["main.cpp"], /a.width \+ b.height/);
    assert.match(current["main.cpp"], /"member"/);
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
    assert.deepEqual(tree["main.cpp"].match(/int member/g)?.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("local types use the outer overload signature, and nested selectors follow a previously renamed parent in the same batch", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-type-owners-"));
  const tree = {
    "main.cpp": `namespace frond {
struct Parent { using Child = int; Child value; };
int view(int input) { struct Local { int value; }; Local item{input}; return item.value; }
float view(float input) { struct Local { float value; }; Local item{input}; return item.value; }
}
int main() { return frond::view(2) + frond::view(3.0f) + frond::Parent{1}.value == 6 ? 0 : 1; }
`,
  };
  const requests = [
    {
      id: "first-local-type",
      category: "functions-types",
      mapping: [{ from: "Local", to: "First" }],
      selectors: [
        {
          kind: "type",
          scope: "frond::view::Local",
          owner: { scope: "frond::view", signature: "int (int)" },
        },
      ],
    },
    {
      id: "second-local-type",
      category: "functions-types",
      mapping: [{ from: "Local", to: "Second" }],
      selectors: [
        {
          kind: "type",
          scope: "frond::view::Local",
          owner: { scope: "frond::view", signature: "float (float)" },
        },
      ],
    },
    {
      id: "parent",
      category: "functions-types",
      mapping: [{ from: "Parent", to: "Data" }],
      selectors: [{ kind: "type", scope: "frond::Parent" }],
    },
    {
      id: "child",
      category: "functions-types",
      mapping: [{ from: "Child", to: "Number" }],
      selectors: [{ kind: "type", scope: "frond::Data::Child" }],
    },
  ];
  try {
    const plans = await scopedNamingPlan(tree, requests, root);
    let current = tree;
    const applied = [];
    for (const plan of plans) {
      current = applyScopedNamePlan(current, plan, applied);
      applied.push(plan);
    }
    assert.match(current["main.cpp"], /struct First \{ int value; \}; First item/);
    assert.match(current["main.cpp"], /struct Second \{ float value; \}; Second item/);
    assert.match(current["main.cpp"], /struct Data \{ using Number = int; Number value; \}/);
    await writeTree(path.join(root, "workspace"), current);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "workspace/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
    assert.match(tree["main.cpp"], /struct Parent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("owner/signature renames distinguish overload locals and record fields across files, preserve captures and literals, then restore types and functions", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/scoped-names-"));
  let tree = {
    "frond_shared.h": `#pragma once
namespace frond {
struct TypeA { int member; };
struct TypeB { int member; };
int calc(int arg);
float calc(float arg);
int use(TypeA a, TypeB b);
}
`,
    "frond_first.cpp": `#include "frond_shared.h"
namespace frond {
int calc(int arg) { auto capture = [&arg] { return arg; }; const char* note = "arg member TypeA calc"; return capture() + (note[0] == 'x'); }
float calc(float arg) { auto capture = [=] { return arg; }; return capture(); }
int use(TypeA a, TypeB b) { return a.member + b.member; }
}
`,
    "main.cpp": `#include "frond_shared.h"
int main() { return frond::use(frond::TypeA{2}, frond::TypeB{3}) + frond::calc(1) + frond::calc(2.0f) == 8 ? 0 : 1; }
`,
  };
  const batches = [
    [
      {
        id: "int-local",
        category: "locals-parameters",
        mapping: [{ from: "arg", to: "count" }],
        selectors: [{ kind: "function", scope: "frond::calc", signature: "int (int)" }],
      },
      {
        id: "float-local",
        category: "locals-parameters",
        mapping: [{ from: "arg", to: "weight" }],
        selectors: [{ kind: "function", scope: "frond::calc", signature: "float (float)" }],
      },
    ],
    [
      {
        id: "first-field",
        category: "fields",
        mapping: [{ from: "member", to: "width" }],
        selectors: [{ kind: "record", scope: "frond::TypeA" }],
      },
      {
        id: "second-field",
        category: "fields",
        mapping: [{ from: "member", to: "height" }],
        selectors: [{ kind: "record", scope: "frond::TypeB" }],
      },
    ],
    [
      {
        id: "type",
        category: "functions-types",
        mapping: [{ from: "TypeA", to: "Item" }],
        selectors: [{ kind: "type", scope: "frond::TypeA" }],
      },
      {
        id: "function",
        category: "functions-types",
        mapping: [{ from: "calc", to: "measure" }],
        selectors: [{ kind: "function", scope: "frond::calc" }],
      },
    ],
  ];
  try {
    for (const [index, requests] of batches.entries()) {
      const analysis = path.join(root, `analysis-${index}`);
      await mkdir(analysis);
      const plans = await scopedNamingPlan(tree, requests, analysis);
      const applied = [];
      for (const plan of plans) {
        tree = applyScopedNamePlan(tree, plan, applied);
        applied.push(plan);
      }
      const workspace = path.join(root, `state-${index}`);
      await writeTree(workspace, tree);
      const program = path.join(workspace, "program");
      execFileSync("clang++", [
        "-std=c++17",
        path.join(workspace, "main.cpp"),
        path.join(workspace, "frond_first.cpp"),
        "-o",
        program,
      ]);
      execFileSync(program);
    }
    assert.match(tree["frond_first.cpp"], /int measure\(int count\)/);
    assert.match(tree["frond_first.cpp"], /float measure\(float weight\)/);
    assert.match(tree["frond_first.cpp"], /\[&count\]/);
    assert.match(tree["frond_first.cpp"], /"arg member TypeA calc"/);
    assert.match(tree["frond_first.cpp"], /a.width \+ b.height/);
    assert.match(tree["main.cpp"], /frond::Item\{2\}/);
    const analysis = path.join(root, "bad-owner");
    await mkdir(analysis);
    const before = structuredClone(tree);
    await assert.rejects(
      scopedNamingPlan(
        tree,
        [
          {
            ...batches[0][0],
            selectors: [{ kind: "function", scope: "frond::measure", signature: "int (float)" }],
          },
        ],
        analysis,
      ),
      /owner|signature/,
    );
    assert.deepEqual(tree, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
