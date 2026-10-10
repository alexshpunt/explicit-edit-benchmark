import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import * as generator from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";

await test("blank-line trimming keeps one internal gap, trims file edges and restores protected text exactly", () => {
  const source =
    '\n \n\t\n\nint value = 1;\n\n \n\t\n\nconst char* raw = R"tag(first\n\n\n\nlast)tag";\n#define TEXT R"tag(a\n\n\n\nb)tag"\nint end = 2;\n\n \n\t';
  const tree = { "main.cpp": source };
  const { tree: trimmed, record } = generator.compactBlankLines(tree);
  assert.equal(
    trimmed["main.cpp"],
    'int value = 1;\n\nconst char* raw = R"tag(first\n\n\n\nlast)tag";\n#define TEXT R"tag(a\n\n\n\nb)tag"\nint end = 2;\n',
  );
  assert.ok(trimmed["main.cpp"].includes('R"tag(first\n\n\n\nlast)tag"'));
  assert.ok(trimmed["main.cpp"].includes('#define TEXT R"tag(a\n\n\n\nb)tag"'));
  assert.ok(record.edits.length >= 2);
  assert.ok(record.edits.every((edit) => /^[ \t\r\n]+$/.test(edit.removed)));
  assert.deepEqual(generator.restoreBlankLines(trimmed, JSON.parse(JSON.stringify(record))), tree);
  assert.equal(generator.compactBlankLines(trimmed).record.edits.length, 0);
  assert.throws(
    () => generator.restoreBlankLines({ "main.cpp": trimmed["main.cpp"] + "\n" }, record),
    /identity/,
  );
});
await test("stripComments itself trims edges and keeps only one blank line between code", () => {
  const source =
    "\n \n// heading\n/* description */\n\nint/**/first = 1;\n\n \n// between\n\nint second = 2;\n// footer\n\n \n";
  const prepared = generator.stripComments(source);
  assert.equal(prepared, "int first = 1;\n\nint second = 2;");
  assert.equal(generator.stripComments(prepared), prepared);
  assert.equal(generator.stripComments("\n \n\t\n"), "");
  assert.equal(generator.stripComments("/* only a comment */\n"), "");
  assert.equal(
    generator.stripComments("\nint first;\n\n\nint second;\n\n"),
    "int first;\n\nint second;",
  );
});
await test("stripComments trims outer spaces but retains safe separators and a continued directive terminator", () => {
  assert.equal(generator.stripComments(" \t int/**/value; /* end */ \t\n"), "int value;");
  assert.equal(generator.stripComments(" \t a/**/b \n"), "a b");
  assert.equal(generator.stripComments(" +/**/+ \n"), "+ +");
  assert.equal(
    generator.stripComments(
      ' \t const char* text = R"tag(  // literal\n\n\n/* literal */  )tag"; \n',
    ),
    'const char* text = R"tag(  // literal\n\n\n/* literal */  )tag";',
  );
  const directive = "#define VALUE \\\n// terminate\n\n";
  const prepared = generator.stripComments(directive);
  assert.equal(prepared, "#define VALUE \\\n \n");
  assert.equal(generator.stripComments(prepared), prepared);
  assert.equal(generator.stripComments(" \t int value; \r\n \t"), "int value;");
});
await test("comment-only lines disappear without joining tokens or extending continued directives", () => {
  const source =
    '// title\n/* a\n b */\nint/**/value = 1; // note\n  /* first */ /* second */\n\n#define VALUE \\\n// terminate the macro\nconst char* raw = R"tag(// literal\n\n/* literal */)tag";\n// footer\n';
  const prepared = generator.stripComments(source);
  assert.equal(
    prepared,
    'int value = 1;  \n\n#define VALUE \\\n \nconst char* raw = R"tag(// literal\n\n/* literal */)tag";',
  );
  assert.equal(generator.stripComments(prepared), prepared);
});
await test("comment preparation preserves literals, spliced comments and preprocessor token boundaries", async () => {
  const source =
    '#include <cstdio>\nextern int edge_marker;\n#define SUM 2/* across\nlines */+3\nint main() { const char* s = R"tag(// not a comment /* either */)tag"; int/**/value=SUM; /\\\n/ hide the following line\\\n#error hidden\nstd::printf("%d %d %s\\n",edge_marker,value,s); }\n#define EMPTY \\\n// terminate\n\n';
  const prepared = generator.stripComments(source);
  assert.ok(prepared.includes('R"tag(// not a comment /* either */)tag"'));
  assert.doesNotMatch(prepared, /#error hidden|across|hide the following/);
  assert.match(prepared, /int\s+value/);
  assert.equal(generator.stripComments(prepared), prepared);
  assert.equal(generator.compactBlankLines({ "main.cpp": prepared }).record.edits.length, 0);
  await mkdir(".tmp", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".tmp/comments-contract-"));
  try {
    await generator.writeTree(path.join(temporary, "source"), {
      "main.cpp": prepared + "int edge_marker = EMPTY 7;\n",
    });
    const executable = path.join(temporary, "program");
    execFileSync("clang++", [
      "-std=c++17",
      path.join(temporary, "source/main.cpp"),
      "-o",
      executable,
    ]);
    assert.equal(
      execFileSync(executable, [], { encoding: "utf8" }).trim(),
      "7 5 // not a comment /* either */",
    );
    const original = {
      "main.cpp": source,
      "PROVENANCE.md": "private metadata",
      "support/LICENSE": "keep notice",
    };
    assert.deepEqual(generator.prepareTree(original), { "main.cpp": prepared });
    assert.equal(original["main.cpp"], source);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
