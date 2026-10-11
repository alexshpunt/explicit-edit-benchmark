import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  cppTokens,
  pack,
  compactBlankLines,
  treeIdentity,
  writeTree,
} from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import { mixFunctions } from "../../src/suites/explicit-edit-multi-agent/generation/function-mix.mjs";
import { maskOrigin } from "../../src/suites/explicit-edit-multi-agent/generation/origin-markers.mjs";
import { referenceRoute } from "../../src/suites/explicit-edit-multi-agent/generation/reference-route.mjs";

function renameTokens(tree, category, choose) {
  let source = "",
    cursor = 0;
  const edits = [];
  for (const token of cppTokens(tree["main.cpp"])) {
    const replacement = choose(token);
    if (!replacement || replacement === token.text) continue;
    source += tree["main.cpp"].slice(cursor, token.start);
    edits.push({
      start: token.start,
      afterStart: source.length,
      old: token.text,
      new: replacement,
    });
    source += replacement;
    cursor = token.end;
  }
  source += tree["main.cpp"].slice(cursor);
  const next = { "main.cpp": source };
  return {
    tree: next,
    record: {
      kind: "rename",
      category,
      before: treeIdentity(tree),
      after: treeIdentity(next),
      edits,
    },
  };
}

await test("the reference route splits first, then restores binding-specific names and helper names", async () => {
  await mkdir(".tmp", { recursive: true });
  const scratch = await mkdtemp(path.resolve(".tmp/reference-contract-"));
  try {
    const initial = {
      "main.cpp":
        '#include "yocto_parts.h"\n#include <cstdio>\nint main() { std::printf("%d\\n", yocto::first(3) + yocto::second(4)); }',
      "yocto_parts.h":
        "#ifndef _YOCTO_PARTS_H_\n#define _YOCTO_PARTS_H_\nnamespace yocto { int first(int); int second(int); }\n#endif",
      "first.cpp":
        '#include "yocto_parts.h"\nnamespace yocto { static int helper(int width) { return width + 1; } int first(int width) { return helper(width); } }',
      "second.cpp":
        '#include "yocto_parts.h"\nnamespace yocto { static int helper(int width) { return width + 2; } int second(int width) { return helper(width); } }',
    };
    let current = initial;
    const operations = [];
    for (const operation of [
      {
        kind: "append",
        source: "first.cpp",
        target: "main.cpp",
        renames: { helper: "first_helper" },
      },
      {
        kind: "append",
        source: "second.cpp",
        target: "main.cpp",
        renames: { helper: "second_helper" },
      },
      { kind: "include", source: "yocto_parts.h", target: "main.cpp" },
    ]) {
      const result = pack(current, operation);
      current = result.tree;
      operations.push(result.record);
    }
    const functions = renameTokens(
      current,
      "functions-types",
      (token) =>
        ({
          first: "callFirst",
          second: "secondOp",
          first_helper: "computeFirst",
          second_helper: "evaluateSecond",
        })[token.text],
    );
    current = functions.tree;
    operations.push(functions.record);
    const locals = renameTokens(current, "locals-parameters", (token) =>
      token.text === "width"
        ? token.start < current["main.cpp"].indexOf("static int evaluateSecond(int width)")
          ? "argWidth"
          : "widthParam"
        : null,
    );
    current = locals.tree;
    operations.push(locals.record);
    const mixed = await mixFunctions(current, path.join(scratch, "mixing"));
    for (const stage of mixed.stages) {
      current = stage.tree;
      operations.push(stage.record);
    }
    const masked = maskOrigin(current);
    current = masked.tree;
    operations.push(masked.record);
    const compacted = compactBlankLines(current);
    current = compacted.tree;
    operations.push(compacted.record);
    const manifest = { initial: treeIdentity(initial), final: treeIdentity(current), operations };
    const route = referenceRoute(current, manifest);
    assert.deepEqual(route, referenceRoute(current, JSON.parse(JSON.stringify(manifest))));
    assert.deepEqual(route.stages[0].tree, current);
    const split = route.stages.findLast((stage) => stage.phase === "structure").tree;
    assert.deepEqual(
      Object.keys(split).sort(),
      Object.keys(initial)
        .map((file) => file.replace("yocto_", `${masked.record.name}_`))
        .sort(),
    );
    assert.match(split["first.cpp"], /computeFirst\(int argWidth\)/);
    assert.match(split["second.cpp"], /evaluateSecond\(int widthParam\)/);
    assert.doesNotMatch(Object.values(split).join("\n"), /\byocto\b|\bfirst_helper\b/);
    assert.match(split["main.cpp"], /callFirst\(3\)/);
    for (const stage of route.stages)
      for (const source of Object.values(stage.tree))
        assert.equal(
          cppTokens(source).some((token) => /^\/\/|^\/\*/.test(token.text)),
          false,
        );
    const neutral = Object.fromEntries(
      Object.entries(initial).map(([file, source]) => [
        file.replace("yocto_", `${masked.record.name}_`),
        source
          .replaceAll("yocto", masked.record.name)
          .replaceAll("YOCTO", masked.record.name.toUpperCase()),
      ]),
    );
    assert.deepEqual(route.stages.at(-1).tree, neutral);
    assert.equal(route.final, treeIdentity(neutral));
    for (const stage of route.stages) assert.doesNotMatch(JSON.stringify(stage), /yocto/i);
    let namesStarted = false;
    for (const [index, stage] of route.stages.entries()) {
      if (stage.phase === "names") namesStarted = true;
      if (namesStarted) assert.equal(stage.phase, "names");
      const directory = path.join(scratch, `state-${index}`);
      await writeTree(directory, stage.tree);
      const executable = path.join(scratch, `program-${index}`);
      execFileSync("clang++", [
        "-std=c++17",
        ...Object.keys(stage.tree)
          .filter((name) => name.endsWith(".cpp"))
          .map((name) => path.join(directory, name)),
        "-o",
        executable,
      ]);
      assert.equal(execFileSync(executable, { encoding: "utf8" }), "10\n");
    }
    assert.throws(
      () => referenceRoute({ "main.cpp": current["main.cpp"] + " " }, manifest),
      /identity/i,
    );
    assert.throws(() => referenceRoute(current, { ...manifest, initial: "wrong" }), /identity/i);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

await test("repeated macro-controlled headers merge physical-token rename coverage before extraction", () => {
  const header = "support/stb_image/stb_image_resize.h";
  const initial = {
    "main.cpp": `#include "${header}"\n#define IMPLEMENTATION\n#include "${header}"\nint main() { return 0; }`,
    "support/stb.cpp": "int vendor_dummy;",
    [header]:
      "#ifndef VENDOR_H\n#define VENDOR_H\nstruct Item { int width; };\n#endif\n#ifdef IMPLEMENTATION\nint measure(Item item) { return item.width; }\n#endif",
  };
  const appended = pack(initial, { kind: "append", source: "support/stb.cpp", target: "main.cpp" });
  const packed = pack(appended.tree, {
    kind: "include",
    source: header,
    target: "main.cpp",
    repeat: true,
  });
  const boundary = packed.tree["main.cpp"].indexOf("#define IMPLEMENTATION");
  const changed = renameTokens(packed.tree, "fields", (token) =>
    token.text === "width" &&
    (token.start < boundary || token.start > packed.tree["main.cpp"].lastIndexOf("int measure"))
      ? "extentValue"
      : null,
  );
  const manifest = {
    initial: treeIdentity(initial),
    final: treeIdentity(changed.tree),
    operations: [appended.record, packed.record, changed.record],
  };
  const route = referenceRoute(changed.tree, manifest);
  const split = route.stages.findLast((stage) => stage.phase === "structure").tree;
  assert.match(split[header], /int extentValue/);
  assert.match(split[header], /item.extentValue/);
  assert.deepEqual(route.stages.at(-1).tree, initial);
  for (const stage of route.stages)
    assert.deepEqual(Object.keys(stage.tree), Object.keys(stage.tree).sort());
  const conflicting = renameTokens(packed.tree, "fields", (token) =>
    token.text === "width" ? (token.start < boundary ? "firstExtent" : "secondExtent") : null,
  );
  assert.throws(
    () =>
      referenceRoute(conflicting.tree, {
        initial: treeIdentity(initial),
        final: treeIdentity(conflicting.tree),
        operations: [appended.record, packed.record, conflicting.record],
      }),
    /incompatible naming/,
  );
});
