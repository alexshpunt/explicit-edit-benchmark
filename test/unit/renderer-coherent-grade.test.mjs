import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  prepareCoherentContract,
  evaluateCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

const expected = {
  "frond_math.h": `#pragma once
namespace frond {
struct Item { int value; };
int first(int value);
int second(int value);
}
`,
  "frond_math.cpp": `#include "frond_math.h"
namespace frond {
int first(int value) { const char* text = "second value"; return value + (text[0] == 'x'); }
#ifdef FEATURE
int second(int value) { return value + 2; }
int extra() { return 3; }
#else
int second(int value) { return value + 1; }
int extra() { return 4; }
#endif
}
`,
  "main.cpp":
    '#include "frond_math.h"\nint main() { return frond::first(2) == 2 && frond::second(1) >= 2 ? 0 : 1; }\n',
};

await test("coherent contracts accept independent order, formatting, reopened namespaces and harmless includes in real compiled solutions", async () => {
  const contract = prepareCoherentContract(expected);
  const alternative = {
    ...expected,
    "frond_math.h":
      "#pragma once\nnamespace frond { int second(int value); }\nnamespace frond { struct Item { int value; }; int first(int value); }\n",
    "frond_math.cpp": `#include <cstddef>
#include "frond_math.h"
namespace frond {
#ifdef FEATURE
int extra() { return 3; }
int second(int value) { return value + 2; }
#else
int extra() { return 4; }
int second(int value) { return value + 1; }
#endif
}
namespace frond { int first ( int value ) { const char* text = "second value"; return value + (text[0] == 'x'); } }
`,
  };
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-grade-"));
  try {
    for (const [index, tree] of [expected, alternative].entries()) {
      const result = evaluateCoherentContract(tree, contract);
      assert.equal(result.status, "pass");
      assert.equal(result.passed, result.total);
      const workspace = path.join(root, `source-${index}`);
      await writeTree(workspace, tree);
      for (const feature of [false, true]) {
        const program = path.join(root, `program-${index}-${feature}`);
        execFileSync("clang++", [
          "-std=c++17",
          ...(feature ? ["-DFEATURE"] : []),
          path.join(workspace, "main.cpp"),
          path.join(workspace, "frond_math.cpp"),
          "-o",
          program,
        ]);
        execFileSync(program);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("required using context is preserved without requiring duplicate wrapper directives", () => {
  const tree = {
    "main.cpp":
      "namespace frond { using namespace std; int first() { return 1; } using namespace std; int second() { return 2; } }",
  };
  const contract = prepareCoherentContract(tree);
  assert.equal(
    evaluateCoherentContract(
      { "main.cpp": tree["main.cpp"].replace("using namespace std; ", "") },
      contract,
    ).status,
    "pass",
  );
  assert.equal(
    evaluateCoherentContract(
      {
        "main.cpp":
          "namespace frond { using namespace other; int first() { return 1; } int second() { return 2; } }",
      },
      contract,
    ).status,
    "fail",
  );
});
await test("a standard using supplied before its consumers by guarded project headers need not be copied in the translation unit", async () => {
  const tree = {
    "context.h":
      "#ifndef CONTEXT_H\n#define CONTEXT_H\n#include <utility>\nnamespace frond { using std::pair; }\n#endif\n",
    "main.cpp":
      '#include "context.h"\nnamespace frond { using std::pair; pair<int,int> value() { return {1,2}; } }\nint main() { return frond::value().first == 1 ? 0 : 1; }\n',
  };
  const alternative = { ...tree, "main.cpp": tree["main.cpp"].replace("using std::pair; ", "") };
  assert.equal(evaluateCoherentContract(alternative, prepareCoherentContract(tree)).status, "pass");
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-using-"));
  try {
    await writeTree(path.join(root, "source"), alternative);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "source/main.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("unused standard using scaffolding may disappear while qualified consumers remain intact", () => {
  const tree = {
    "main.cpp":
      "#include <atomic>\nnamespace frond { using std::atomic; int first() { std::atomic<int> value(1); return value.load(); } }\n",
  };
  assert.equal(
    evaluateCoherentContract(
      { "main.cpp": tree["main.cpp"].replace("using std::atomic; ", "") },
      prepareCoherentContract(tree),
    ).status,
    "pass",
  );
});
await test("a missing using is not supplied by another namespace, an inactive include or an include after its consumer", () => {
  const tree = {
    "right.h": "#pragma once\n#include <utility>\nnamespace frond { using std::pair; }\n",
    "wrong.h": "#pragma once\n#include <utility>\nnamespace other { using std::pair; }\n",
    "main.cpp":
      '#include "right.h"\nnamespace frond { using std::pair; pair<int,int> value() { return {1,2}; } }\n',
  };
  const contract = prepareCoherentContract(tree);
  const consumer = "namespace frond { pair<int,int> value() { return {1,2}; } }\n";
  for (const source of [
    '#include "wrong.h"\n' + consumer,
    '#if 0\n#include "right.h"\n#endif\n' + consumer,
    consumer + '#include "right.h"\n',
  ])
    assert.equal(
      evaluateCoherentContract({ ...tree, "main.cpp": source }, contract).status,
      "fail",
    );
});
await test("transitive header imports satisfy only consumers in the same conditional branch", () => {
  const tree = {
    "context.h":
      "#ifndef CONTEXT_H\n#define CONTEXT_H\n#include <utility>\nnamespace frond { using std::pair; }\n#endif\n",
    "relay.h": '#pragma once\n#include "context.h"\n',
    "main.cpp":
      '#ifdef FEATURE\n#include "relay.h"\n#endif\nnamespace frond { using std::pair; }\n#ifdef FEATURE\nnamespace frond { pair<int,int> value() { return {1,2}; } }\n#else\nnamespace frond { int value() { return 1; } }\n#endif\n',
  };
  const contract = prepareCoherentContract(tree);
  const alternative = { ...tree, "main.cpp": tree["main.cpp"].replace("using std::pair;", "") };
  assert.equal(evaluateCoherentContract(alternative, contract).status, "pass");
  assert.equal(
    evaluateCoherentContract(
      {
        ...alternative,
        "main.cpp": alternative["main.cpp"].replace('#include "relay.h"', '#include "utility"'),
      },
      contract,
    ).status,
    "fail",
  );
});
await test("unused literal namespace context may move with a module, while harmless standard imports need not match physical scaffolding", async () => {
  const tree = {
    "module.cpp": "#include <string>\nnamespace frond { int value() { return 1; } }\n",
    "main.cpp":
      "#include <string>\nnamespace frond { using namespace std::string_literals; int value(); }\nint main() { return frond::value() == 1 ? 0 : 1; }\n",
  };
  const alternative = {
    ...tree,
    "main.cpp": tree["main.cpp"].replace("using namespace std::string_literals; ", ""),
    "module.cpp": tree["module.cpp"].replace(
      "namespace frond {",
      "#include <deque>\nnamespace frond { using std::deque; using namespace std::string_literals;",
    ),
  };
  assert.equal(evaluateCoherentContract(alternative, prepareCoherentContract(tree)).status, "pass");
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-literal-using-"));
  try {
    await writeTree(path.join(root, "source"), alternative);
    execFileSync("clang++", [
      "-std=c++17",
      path.join(root, "source/main.cpp"),
      path.join(root, "source/module.cpp"),
      "-o",
      path.join(root, "program"),
    ]);
    execFileSync(path.join(root, "program"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("standard imports cannot extend a project overload family even when existing calls still work", async () => {
  const tree = {
    "main.cpp":
      "#include <algorithm>\n#include <deque>\nnamespace frond { int max(int a, int b) { return a > b ? a : b; } }\nint main() { return frond::max(1, 2) == 2 ? 0 : 1; }\n",
  };
  const contract = prepareCoherentContract(tree);
  const harmless = {
    "main.cpp": tree["main.cpp"].replace(
      "namespace frond {",
      "namespace frond { using std::deque;",
    ),
  };
  const extended = {
    "main.cpp": tree["main.cpp"].replace("namespace frond {", "namespace frond { using std::max;"),
  };
  assert.equal(evaluateCoherentContract(harmless, contract).status, "pass");
  assert.equal(evaluateCoherentContract(extended, contract).status, "fail");
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/coherent-overload-import-"));
  try {
    for (const [index, candidate] of [tree, harmless, extended].entries()) {
      const source = path.join(root, `source-${index}`);
      await writeTree(source, candidate);
      const program = path.join(root, `program-${index}`);
      execFileSync("clang++", ["-std=c++17", path.join(source, "main.cpp"), "-o", program]);
      execFileSync(program);
    }
    const newConsumer =
      "\nconst double& (*selected)(const double&, const double&) = frond::max<double>;\n";
    assert.throws(() =>
      execFileSync("clang++", ["-x", "c++", "-std=c++17", "-fsyntax-only", "-"], {
        input: tree["main.cpp"] + newConsumer,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    execFileSync("clang++", ["-x", "c++", "-std=c++17", "-fsyntax-only", "-"], {
      input: extended["main.cpp"] + newConsumer,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("literal using context still must reach literal consumers, and unsupported or conditional imports keep their contracts", () => {
  const tree = {
    "main.cpp":
      '#include <string>\nnamespace frond { using namespace std::string_literals; std::string value() { return "text"s; } }\n',
  };
  const contract = prepareCoherentContract(tree);
  for (const source of [
    tree["main.cpp"].replace("using namespace std::string_literals; ", ""),
    tree["main.cpp"].replace("using namespace std::string_literals; ", "") +
      "namespace frond { using namespace std::string_literals; }\n",
    tree["main.cpp"].replace(
      "using namespace std::string_literals;",
      "using namespace std::chrono_literals;",
    ),
    tree["main.cpp"] + "namespace frond { using Alias = std::string; }\n",
    tree["main.cpp"] + "#ifdef FEATURE\nnamespace frond { using std::deque; }\n#endif\n",
  ])
    assert.equal(evaluateCoherentContract({ "main.cpp": source }, contract).status, "fail");
});
await test("a definition without macro dependencies can cross an unrelated macro boundary", () => {
  const tree = {
    "main.cpp":
      "#define SCALE(x) (x)\nint first() { return SCALE(1); }\n#undef SCALE\nint second() { return 2; }\n",
  };
  const alternative = {
    "main.cpp":
      "int second() { return 2; }\n#define SCALE(x) (x)\nint first() { return SCALE(1); }\n#undef SCALE\n",
  };
  assert.equal(evaluateCoherentContract(alternative, prepareCoherentContract(tree)).status, "pass");
  execFileSync("clang++", ["-x", "c++", "-std=c++17", "-fsyntax-only", "-"], {
    input: alternative["main.cpp"],
  });
});
await test("macro activation boundaries, macro kind and comments cannot be changed by order-free grading", () => {
  const tree = {
    "main.cpp":
      "#define SCALE(x) (x)\nint first() { return SCALE(1); }\n#undef SCALE\nint second() { return 2; }\n",
  };
  const contract = prepareCoherentContract(tree);
  for (const source of [
    "int first() { return SCALE(1); }\n#define SCALE(x) (x)\n#undef SCALE\nint second() { return 2; }\n",
    tree["main.cpp"].replace("#define SCALE(x)", "#define SCALE (x)"),
    tree["main.cpp"] + "// a new comment\n",
  ])
    assert.equal(evaluateCoherentContract({ "main.cpp": source }, contract).status, "fail");
});
await test("coherent contracts report unmet obligations and reject changed owners, bodies, literals, inactive branches and duplicate facades", () => {
  const contract = prepareCoherentContract(expected);
  const source = expected["frond_math.cpp"];
  const cases = [
    { ...expected, "main.cpp": expected["main.cpp"] + source, "frond_math.cpp": "" },
    { ...expected, "frond_math.cpp": source.replace("return value + 1;", "return value + 9;") },
    { ...expected, "frond_math.cpp": source.replace('"second value"', '"second Value"') },
    {
      ...expected,
      "frond_math.cpp": source.replace("int second(int value)", "int second(int wrong)"),
    },
    {
      ...expected,
      "frond_math.cpp": source + "namespace frond { int first(int value) { return 0; } }\n",
    },
    {
      ...expected,
      "frond_math.h": expected["frond_math.h"].replace("int value;", "int unrelated;"),
    },
    { ...expected, "frond_math.cpp": source.replace("#ifdef FEATURE", "#ifdef OTHER") },
    { ...expected, "frond_math.cpp": source.replace("int extra() { return 4; }", "") },
  ];
  for (const tree of cases) {
    const result = evaluateCoherentContract(tree, contract);
    assert.equal(result.status, "fail");
    assert.ok(result.obligations.some((item) => item.status === "fail"));
    assert.ok(result.passed < result.total);
  }
  assert.equal(
    evaluateCoherentContract({ ...expected, "main.cpp": "namespace frond {" }, contract).status,
    "fail",
  );
});
