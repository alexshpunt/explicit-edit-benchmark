import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  maskOrigin,
  restoreOrigin,
  neutralFiles,
} from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { writeTree } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("origin masking changes namespace and macro tokens, not literals or unrelated spellings, and restores exact code", async () => {
  const source =
    '#include <cstdio>\n#ifndef _YOCTO_TEST_H_\n#define _YOCTO_TEST_H_\n#define YOCTO_FEATURE 7\n#define FORWARD \\\n  yocto::value\nnamespace yocto { int value = YOCTO_FEATURE; }\nnamespace yo\\\ncto { int other = 1; }\n// yocto stays in comments\nconst char* note = R"tag(yocto YOCTO_FEATURE)tag";\nint my_yocto_value = 3;\nint main() { using namespace yocto; std::printf("%d %s\\n", FORWARD + other + my_yocto_value, note); }\n#endif\n';
  const tree = { "main.cpp": source };
  const result = maskOrigin(tree);
  const name = result.record.name;
  assert.match(name, /^[a-z]{5}$/);
  assert.ok(result.tree["main.cpp"].includes(`namespace ${name} {`));
  assert.ok(
    result.tree["main.cpp"].includes(`namespace ${name.slice(0, 2)}\\\n${name.slice(2)} {`),
  );
  assert.ok(result.tree["main.cpp"].includes(`#define ${name.toUpperCase()}_FEATURE 7`));
  assert.ok(result.tree["main.cpp"].includes(`#define _${name.toUpperCase()}_TEST_H_`));
  assert.ok(result.tree["main.cpp"].includes(`#define FORWARD \\\n  ${name}::value`));
  assert.ok(result.tree["main.cpp"].includes("// yocto stays in comments"));
  assert.ok(result.tree["main.cpp"].includes('R"tag(yocto YOCTO_FEATURE)tag"'));
  assert.ok(result.tree["main.cpp"].includes("my_yocto_value"));
  assert.equal(tree["main.cpp"], source);
  assert.deepEqual(maskOrigin(tree), result);
  assert.deepEqual(restoreOrigin(result.tree, JSON.parse(JSON.stringify(result.record))), tree);
  assert.throws(
    () => restoreOrigin({ "main.cpp": result.tree["main.cpp"] + " " }, result.record),
    /identity/,
  );
  const changed = structuredClone(result.record);
  changed.edits[0].new = "wrong";
  assert.throws(() => restoreOrigin(result.tree, changed), /token/);
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/markers-contract-"));
  try {
    for (const [index, state] of [
      tree,
      result.tree,
      restoreOrigin(result.tree, result.record),
    ].entries()) {
      const directory = path.join(temporary, String(index));
      await writeTree(directory, state);
      const executable = path.join(directory, "program");
      execFileSync("clang++", ["-std=c++17", path.join(directory, "main.cpp"), "-o", executable]);
      assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "11 yocto YOCTO_FEATURE\n");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

await test("neutral file paths update real includes but preserve literals and reject collisions", () => {
  const source =
    '#include "yocto_math.h"\n#include \\\n "support/yocto_shape.h"\nconst char* note = "yocto_math.h";\nconst char* raw = R"x(\n#include "yocto_math.h"\n)x";\n';
  const tree = {
    "main.cpp": source,
    "yocto_math.h": "#pragma once\n",
    "support/yocto_shape.h": "#pragma once\n",
  };
  const neutral = neutralFiles(tree, "frond");
  assert.deepEqual(Object.keys(neutral), ["frond_math.h", "main.cpp", "support/frond_shape.h"]);
  assert.ok(
    neutral["main.cpp"].startsWith(
      '#include "frond_math.h"\n#include \\\n "support/frond_shape.h"',
    ),
  );
  assert.ok(neutral["main.cpp"].includes('const char* note = "yocto_math.h";'));
  assert.ok(neutral["main.cpp"].includes('R"x(\n#include "yocto_math.h"\n)x"'));
  assert.deepEqual(neutralFiles(tree, "frond"), neutral);
  assert.deepEqual(neutralFiles(neutral, "frond"), neutral);
  assert.equal(tree["main.cpp"], source);
  assert.throws(
    () => neutralFiles({ "yocto_math.h": "", "frond_math.h": "" }, "frond"),
    /collision/,
  );
});

await test("origin dictionary selection avoids namespace and macro collisions deterministically", () => {
  const tree = { "main.cpp": "namespace yocto {}\n#define YOCTO_FEATURE 1\n" };
  const first = maskOrigin(tree);
  assert.throws(() => maskOrigin(tree, { name: "unknown" }), /Unknown fixed origin/);
  const name = first.record.name;
  for (const occupied of [`namespace ${name} {}`, `#define ${name.toUpperCase()}_FEATURE 2`]) {
    const colliding = { "main.cpp": tree["main.cpp"] + occupied + "\n" };
    const next = maskOrigin(colliding);
    assert.notEqual(next.record.name, name);
    assert.throws(() => maskOrigin(colliding, { name }), /collision-free/);
    assert.deepEqual(maskOrigin(colliding), next);
    assert.deepEqual(restoreOrigin(next.tree, next.record), colliding);
  }
});
