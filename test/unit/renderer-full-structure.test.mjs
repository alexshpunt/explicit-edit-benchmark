import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { byteToCharacter } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-offsets.mjs";
import { cppStructure } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";
import {
  physicalSelector,
  includePreambleSelector,
  applyFullStructure,
} from "../../src/suites/explicit-edit-multi-agent/reference/full-structure-edit.mjs";
import { assertFullEndpoint } from "../../src/suites/explicit-edit-multi-agent/grading/full-grade.mjs";

await test("vendor extraction merges active renamed copies and preserves inactive alternatives and literals through separate compilation", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/full-vendor-copies-"));
  const declaration = (name) => `#ifndef STBIR_INCLUDE_STB_IMAGE_RESIZE_H
#define STBIR_INCLUDE_STB_IMAGE_RESIZE_H
int ${name}(int arg);
#endif
`;
  const implementation = (name) => `#ifdef STB_IMAGE_RESIZE_IMPLEMENTATION
#ifdef FEATURE
int ${name}(int arg) { const char* text = "Original FrondResize"; return arg + 2 + (text[0] == 'x'); }
#else
int ${name}(int arg) { return arg + 2; }
#endif
#endif
`;
  let tree = {
    "main.cpp":
      declaration("FrondResize") +
      implementation("Original") +
      "#define STB_IMAGE_RESIZE_IMPLEMENTATION\n" +
      declaration("Original") +
      implementation("FrondResize") +
      "int main() { return FrondResize(3) == 5 ? 0 : 1; }\n",
  };
  const requests = [
    null,
    {
      action: "vendor-header",
      file: "support/stb_image/stb_image_resize.h",
      guard: "STBIR_INCLUDE_STB_IMAGE_RESIZE_H",
      macro: "STB_IMAGE_RESIZE_IMPLEMENTATION",
    },
    { action: "vendor-implementation", macro: "STB_IMAGE_RESIZE_IMPLEMENTATION" },
  ];
  try {
    for (const [index, request] of requests.entries()) {
      if (request) tree = applyFullStructure(tree, request);
      const workspace = path.join(root, `state-${index}`);
      await writeTree(workspace, tree);
      for (const feature of [false, true]) {
        const program = path.join(root, `program-${index}-${feature}`);
        execFileSync("clang++", [
          "-std=c++17",
          ...(feature ? ["-DFEATURE"] : []),
          ...Object.keys(tree)
            .filter((file) => file.endsWith(".cpp"))
            .map((file) => path.join(workspace, file)),
          "-o",
          program,
        ]);
        execFileSync(program);
      }
    }
    const header = tree["support/stb_image/stb_image_resize.h"];
    assert.match(header, /int FrondResize\(int arg\);/);
    assert.match(header, /"Original FrondResize"/);
    assert.match(header, /#else\nint FrondResize/);
    assert.doesNotMatch(header, /int Original\(/);
    assert.throws(() => applyFullStructure(tree, requests[1]), /target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test("final main cleanup removes only copied include preambles and requested direct includes, preserving code and literals", () => {
  const preamble = "#ifdef FEATURE\n#include <future>\n#endif\n";
  const tree = {
    "main.cpp":
      '#include <vector>\n#include "frond_math.h"\n' +
      preamble +
      "namespace frond { using namespace std; }\nint main() { const char* text = \"#include <future>\"; return text[0] == 'x'; }\n",
    "frond_math.h": "#pragma once\nnamespace frond { struct Item { int value; }; }\n",
    "frond_lib.cpp": preamble + "namespace frond { int value() { return 1; } }\n",
  };
  const unit = cppStructure(tree["main.cpp"]).units.find((item) => item.kind === "conditional");
  const request = {
    action: "cleanup-empty-namespaces",
    includes: [{ file: "frond_math.h", quoted: true }],
    preambleSelectors: [includePreambleSelector(tree["main.cpp"], unit)],
  };
  const final = applyFullStructure(tree, request);
  assert.doesNotMatch(final["main.cpp"], /#ifdef|#include <vector>|namespace frond/);
  assert.match(final["main.cpp"], /"#include <future>"/);
  assert.equal(final["frond_lib.cpp"], tree["frond_lib.cpp"]);
  assertFullEndpoint(final, {
    ...tree,
    "main.cpp":
      '#include "frond_math.h"\nint main() { const char* text = "#include <future>"; return text[0] == \'x\'; }\n',
  });
  assert.throws(
    () => applyFullStructure({ ...tree, "frond_lib.cpp": "int other() { return 1; }\n" }, request),
    /has not moved/,
  );
  assert.match(tree["main.cpp"], /#include <vector>/);
});
await test("UTF-8 compiler offsets preserve Unicode boundaries and reject stale or partial code points", () => {
  const source = "aπ😀z",
    offset = byteToCharacter(source);
  for (const prefix of ["", "a", "aπ", "aπ😀", source])
    assert.equal(offset(Buffer.byteLength(prefix)), prefix.length);
  for (const position of [-1, 2, 4, 5, 6, 9, 0.5]) assert.throws(() => offset(position));
  assert.equal(byteToCharacter("plain")(5), 5);
  assert.throws(() => byteToCharacter("plain")(6));
});

await test("layout swaps select whole definitions inside conditionals and remove only a selected prototype", () => {
  const source = `namespace frond {
#ifdef FEATURE
int second(int x) { return x + 2; };
int first(int x) { return x + 1; }
#else
int alternate() { return 0; }
#endif
int first(int);
int first(int);
}
`;
  const tree = { "main.cpp": source };
  const units = cppStructure(source, { expandNamespaceConditionals: true }).units;
  const request = {
    action: "swap-definitions",
    selectors: units.slice(0, 2).map((unit) => physicalSelector(source, unit, true)),
  };
  const next = applyFullStructure(tree, request);
  assert.ok(
    next["main.cpp"].indexOf("int first(int x)") < next["main.cpp"].indexOf("int second(int x)"),
  );
  assert.match(next["main.cpp"], /#else\nint alternate\(\) \{ return 0; \}\n#endif/);
  const prototypes = cppStructure(next["main.cpp"], {
    expandNamespaceConditionals: true,
  }).units.filter((unit) => next["main.cpp"].slice(unit.start, unit.end) === "int first(int);");
  assert.equal(prototypes.length, 2);
  const selector = physicalSelector(next["main.cpp"], prototypes[1], false);
  assert.equal(selector.occurrence, 1);
  const final = applyFullStructure(next, { action: "remove-generated-declaration", selector });
  assert.equal(final["main.cpp"].match(/int first\(int\);/g).length, 1);
  assert.equal(tree["main.cpp"], source);
  assert.throws(
    () =>
      applyFullStructure(tree, {
        ...request,
        selectors: [request.selectors[0], request.selectors[0]],
      }),
    /swap/,
  );
});

await test("endpoint owners accept formatting and reopened namespaces but reject copied bodies, changed literals and missing includes", () => {
  const expected = {
    "main.cpp": `#include "frond_math.h"\nnamespace frond { int measure(int x) { return x + 1; } }`,
    "frond_math.h":
      '#pragma once\nnamespace frond { inline const char* label() { return "a b"; } }',
  };
  const current = {
    ...expected,
    "main.cpp": `#include "frond_math.h"\nnamespace frond { using namespace std; }\nnamespace frond { int measure ( int x ) { return x+1; } }`,
  };
  assertFullEndpoint(current, expected);
  assert.throws(
    () =>
      assertFullEndpoint(
        {
          ...current,
          "frond_math.h": current["frond_math.h"].replace("#pragma once", "#define FEATURE 1"),
        },
        expected,
      ),
    /directives/,
  );
  assert.throws(
    () =>
      assertFullEndpoint(
        {
          ...current,
          "main.cpp": current["main.cpp"] + "\nnamespace frond { int extra(){return 0;} }",
        },
        expected,
      ),
    /bodies/,
  );
  assert.throws(
    () =>
      assertFullEndpoint(
        { ...current, "frond_math.h": expected["frond_math.h"].replace('"a b"', '"ab"') },
        expected,
      ),
    /bodies/,
  );
  assert.throws(
    () =>
      assertFullEndpoint(
        { ...current, "main.cpp": current["main.cpp"].replace('#include "frond_math.h"', "") },
        expected,
      ),
    /includes/,
  );
});
