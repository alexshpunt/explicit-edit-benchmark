import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  prepareBarrierSymbolMap,
  evaluateBarrierSymbolMap,
} from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-symbol-map-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  return () => ({ evidence: path.join(directory, String(index++)) });
}

test("barrier index uses the same C++ standard library as the fresh build", async (t) => {
  const options = await fixture(t);
  const original = {
    "main.cpp":
      "#include <atomic>\nint inspect() { std::atomic<int> value{2}; return value.load(); }\n",
  };
  const map = await prepareBarrierSymbolMap(original, options());
  assert.equal((await evaluateBarrierSymbolMap(original, map, options())).status, "pass");
});

const declarations = `namespace alpha { struct Restored {}; }
namespace beta { struct Restored {}; }
namespace frond {
using namespace alpha;
int inspect(Restored) { return 1; }
using namespace beta;
int untouched(int value) { return value + 2; }
}
`;

function rebind(source) {
  return source
    .replace("using namespace alpha;", "using namespace beta;")
    .replace(/using namespace beta;(\nint untouched| })/, "using namespace alpha;$1");
}

test("barrier symbols accept reordered functions and reopened namespaces", async (t) => {
  const options = await fixture(t);
  const map = await prepareBarrierSymbolMap({ "main.cpp": declarations }, options());
  const reordered = {
    "main.cpp": `namespace alpha { struct Restored {}; }
namespace beta { struct Restored {}; }
namespace frond { int untouched(int value) { return value + 2; } }
namespace frond {
using namespace alpha;
int inspect(Restored) { return 1; }
using namespace beta;
}
`,
  };
  assert.equal((await evaluateBarrierSymbolMap(reordered, map, options())).status, "pass");
});

test("barrier symbols reject a using rebind with unchanged declaration tokens", async (t) => {
  const options = await fixture(t);
  const map = await prepareBarrierSymbolMap({ "main.cpp": declarations }, options());
  const result = await evaluateBarrierSymbolMap(
    { "main.cpp": rebind(declarations) },
    map,
    options(),
  );
  assert.equal(result.status, "fail");
  assert.ok(result.obligations.some((item) => item.status === "fail" && item.file === "main.cpp"));
});

test("barrier references distinguish body bindings without depending on line numbers", async (t) => {
  const options = await fixture(t);
  const original = `namespace alpha { inline int value = 1; }
namespace beta { inline int value = 1; }
namespace frond { using namespace alpha; int inspect() { return value; } using namespace beta; }
`;
  const map = await prepareBarrierSymbolMap({ "main.cpp": original }, options());
  assert.equal(
    (await evaluateBarrierSymbolMap({ "main.cpp": rebind(original) }, map, options())).status,
    "fail",
  );
  assert.equal(
    (await evaluateBarrierSymbolMap({ "main.cpp": "\n\n" + original }, map, options())).status,
    "pass",
  );
});

test("reordering functions preserves local, lambda and anonymous-type bindings", async (t) => {
  const options = await fixture(t);
  const first =
    "static int first(int input) { struct { int value; } local{input}; auto call = [](int value) { return value + 1; }; return call(local.value); }";
  const second = "static int second() { int value = 2; return value; }";
  const map = await prepareBarrierSymbolMap({ "main.cpp": first + "\n" + second }, options());
  assert.equal(
    (await evaluateBarrierSymbolMap({ "main.cpp": second + "\n\n" + first }, map, options()))
      .status,
    "pass",
  );
});

test("reordered callers preserve bindings to a function-local iterator declared in a header", async (t) => {
  const options = await fixture(t);
  const header = `#pragma once
template<class T> auto range(T end) {
  struct Iterator {
    T value;
    T operator*() const { return value; }
    Iterator& operator++() { ++value; return *this; }
    bool operator!=(const Iterator& other) const { return value != other.value; }
  };
  struct Range {
    T limit;
    Iterator begin() const { return {0}; }
    Iterator end() const { return {limit}; }
  };
  return Range{end};
}
`;
  const first =
    "int first() { int sum = 0; for (auto value : range(3)) sum += value; return sum; }\n";
  const second =
    "int second() { int sum = 1; for (auto value : range(5L)) sum += value; return sum; }\n";
  const original = { "api.h": header, "main.cpp": '#include "api.h"\n' + first + second };
  const map = await prepareBarrierSymbolMap(original, options());
  assert.equal(
    (
      await evaluateBarrierSymbolMap(
        { ...original, "main.cpp": '#include "api.h"\n' + second + first },
        map,
        options(),
      )
    ).status,
    "pass",
  );
});

test("reordered functions preserve lambda type identities embedded in library specializations", async (t) => {
  const options = await fixture(t);
  const first =
    "int first(int* values) { auto middle = std::partition(values, values + 4, [](int value) { return value > 0; }); return middle - values; }\n";
  const second = "int second(int value) { return value + 1; }\n";
  const original = { "main.cpp": "#include <algorithm>\n" + first + second };
  const map = await prepareBarrierSymbolMap(original, options());
  assert.equal(
    (
      await evaluateBarrierSymbolMap(
        { "main.cpp": "#include <algorithm>\n" + second + first },
        map,
        options(),
      )
    ).status,
    "pass",
  );
});

test("reordering an unrelated function preserves global anonymous aggregate bindings", async (t) => {
  const options = await fixture(t);
  const unrelated = "int unrelated() { return 0; }\n";
  const aggregate = "struct { int value; } saved{1};\nint inspect() { return saved.value; }\n";
  const map = await prepareBarrierSymbolMap({ "main.cpp": unrelated + aggregate }, options());
  assert.equal(
    (await evaluateBarrierSymbolMap({ "main.cpp": aggregate + unrelated }, map, options())).status,
    "pass",
  );
});

test("anonymous types embedded in function signatures remain stable under declaration reorder", async (t) => {
  const options = await fixture(t);
  const unrelated = "int unrelated() { return 0; }\n";
  const aggregate =
    "struct { int value; } saved{1};\nint inspect(decltype(saved) value) { return value.value; }\n";
  const map = await prepareBarrierSymbolMap({ "main.cpp": unrelated + aggregate }, options());
  assert.equal(
    (await evaluateBarrierSymbolMap({ "main.cpp": aggregate + unrelated }, map, options())).status,
    "pass",
  );
});

test("named typedefs keep their compiler identity across translation units", async (t) => {
  const options = await fixture(t);
  const original = {
    "api.h": "#pragma once\ntypedef struct { int value; } Public;\n",
    "first.cpp": '#include "api.h"\nPublic first{1};\n',
    "second.cpp": '#include "api.h"\nPublic second{2};\n',
    "spare.cpp": "int spare() { return 0; }\n",
  };
  const map = await prepareBarrierSymbolMap(original, options());
  const included = { ...original, "spare.cpp": '#include "api.h"\n' + original["spare.cpp"] };
  assert.equal((await evaluateBarrierSymbolMap(included, map, options())).status, "pass");
});

test("member mismatches project to their enclosing physical declaration", async (t) => {
  const options = await fixture(t);
  const original = { "main.cpp": "namespace sample { struct Owner { int value; int peer; }; }\n" };
  const map = await prepareBarrierSymbolMap(original, options());
  const result = await evaluateBarrierSymbolMap(
    { "main.cpp": original["main.cpp"].replace("int value;", "int changed;") },
    map,
    options(),
  );
  assert.equal(result.status, "fail");
  const failures = result.obligations.filter((item) => item.status === "fail");
  assert.ok(failures.length > 0);
  assert.ok(
    failures.every(
      (item) =>
        item.file === "main.cpp" && item.scope === "sample" && item.selector === "structOwner",
    ),
  );
});

test("indexing errors retain candidate header locations for file-grouped repairs", async (t) => {
  const options = await fixture(t);
  const original = {
    "api.h": "#pragma once\nstruct Box { int value; };\n",
    "main.cpp": '#include "api.h"\nint inspect(Box value) { return value.value; }\n',
  };
  const map = await prepareBarrierSymbolMap(original, options());
  const result = await evaluateBarrierSymbolMap(
    { ...original, "api.h": original["api.h"].replace("int value", "Missing value") },
    map,
    options(),
  );
  assert.equal(result.status, "fail");
  assert.ok(
    result.compilerDiagnostics.some(
      (item) => item.file === "api.h" && item.line === 2 && item.severity === "error",
    ),
  );
});

test("barrier symbols reject wrong spelling, changed body and invalid C++", async (t) => {
  const options = await fixture(t);
  const original = {
    "main.cpp": "int restored(int value) { int local = value; return local + 1; }\n",
  };
  const map = await prepareBarrierSymbolMap(original, options());
  for (const source of [
    original["main.cpp"].replace("restored", "mistaken"),
    original["main.cpp"].replace("+ 1", "+ 2"),
    "int restored( {\n",
  ]) {
    assert.equal(
      (await evaluateBarrierSymbolMap({ "main.cpp": source }, map, options())).status,
      "fail",
    );
  }
});

test("references distinguish file-local symbols in same-named headers", async (t) => {
  const options = await fixture(t);
  const original = {
    "a/shared.h": "#pragma once\nstatic int value = 1;\n",
    "b/shared.h": "#pragma once\nstatic int value = 2;\n",
    "first.cpp": '#include "a/shared.h"\nint first() { return value; }\n',
    "second.cpp": '#include "b/shared.h"\nint second() { return value; }\n',
  };
  const map = await prepareBarrierSymbolMap(original, options());
  const rebound = {
    ...original,
    "first.cpp": original["first.cpp"].replace('"a/shared.h"', '"b/shared.h"'),
    "second.cpp": original["second.cpp"].replace('"b/shared.h"', '"a/shared.h"'),
  };
  assert.equal((await evaluateBarrierSymbolMap(rebound, map, options())).status, "fail");
});

test("barrier symbols keep physical module ownership and header context", async (t) => {
  const options = await fixture(t);
  const original = {
    "api.h": "#pragma once\nnamespace api { inline int value() { return 2; } }\n",
    "main.cpp": '#include "api.h"\nint inspect() { return api::value(); }\n',
  };
  const map = await prepareBarrierSymbolMap(original, options());
  assert.equal((await evaluateBarrierSymbolMap(original, map, options())).status, "pass");
  const moved = {
    "api.h": "#pragma once\n",
    "main.cpp":
      "namespace api { inline int value() { return 2; } }\nint inspect() { return api::value(); }\n",
  };
  assert.equal((await evaluateBarrierSymbolMap(moved, map, options())).status, "fail");
});
